// @vitest-environment node
import { randomUUID } from "node:crypto";
import type Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDockerClient } from "@/lib/docker/client";
import { inspectRuntimeContainer } from "@/lib/docker/containers";
import { ensureFactoryNetwork } from "@/lib/docker/networks";
import { DEFAULT_LIMITS, type RuntimePolicy } from "@/lib/docker/policy";
import { allocateHostPorts, listPublishedPorts } from "@/lib/docker/ports";
import { RUNTIME_IMAGES } from "@/lib/docker/runtime-images";
import { DomainError } from "@/lib/domain/errors";
import {
  createOpenPlcContainer,
  deployProgram,
  openPlcClient,
  openPlcHealth,
  type OpenPlcTarget,
  readPlcValues,
  removeOpenPlc,
  restartOpenPlc,
  startOpenPlc,
  stopOpenPlc,
  writePlcValue,
} from "@/lib/runtimes/openplc/adapter";
import type { OpenPlcClient } from "@/lib/runtimes/openplc/client";
import { cidrsOverlap } from "@/lib/validation/network";

/**
 * OpenPLC Runtime v4 end to end against a real Docker Engine: start, deploy a program,
 * watch it execute, exchange values over Modbus, redeploy, and fail safely.
 * Runs only when TEST_DOCKER=1; pulls the pinned runtime image on first use.
 */
const describeDocker = process.env.TEST_DOCKER === "1" ? describe : describe.skip;

const RUN_LABEL = "zfactory.test-run";
const runId = randomUUID();
const factoryId = randomUUID();
const deviceId = randomUUID();
const networkName = `zfactory_test_${runId.slice(0, 8)}`;
const RUNTIME_SECRET = "integration-test-runtime-secret-0123456789";

const policy: RuntimePolicy = {
  images: RUNTIME_IMAGES,
  portRange: { min: 15800, max: 15899 },
  bindAddresses: ["127.0.0.1"],
  limits: DEFAULT_LIMITS,
  labels: { [RUN_LABEL]: runId },
};

/** %QW0 follows the start command through an interlock on %IW0; %QW1 counts scans. */
const program = (step: number) => `PROGRAM pump_control
  VAR
    PT101_Pressure AT %IW0 : INT;
    Pump01_StartCommand AT %QX0.0 : BOOL;
    VFD01_FrequencySetpoint AT %QW0 : INT;
    ScanCounter AT %QW1 : INT;
    Bypass_Interlock AT %QX0.1 : BOOL;
  END_VAR
  VAR
    Interlock_OK : BOOL;
  END_VAR

  Interlock_OK := (PT101_Pressure > 120) OR Bypass_Interlock;
  ScanCounter := ScanCounter + ${step};
  IF Pump01_StartCommand AND Interlock_OK THEN
    VFD01_FrequencySetpoint := 45;
  ELSE
    VFD01_FrequencySetpoint := 0;
  END_IF;
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#50ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : pump_control;
  END_RESOURCE
END_CONFIGURATION
`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function freeSubnet(docker: Docker): Promise<string> {
  const used = (await docker.listNetworks()).flatMap((network) =>
    (network.IPAM?.Config ?? []).map((config) => config.Subnet).filter((subnet): subnet is string => Boolean(subnet)),
  );
  for (let third = 100; third < 200; third += 1) {
    const candidate = `10.213.${third}.0/28`;
    if (!used.some((subnet) => !subnet.includes(":") && cidrsOverlap(candidate, subnet))) return candidate;
  }
  throw new Error("no free test subnet");
}

describeDocker("OpenPLC runtime adapter against a real engine", () => {
  let docker: Docker;
  let target: OpenPlcTarget;
  let client: OpenPlcClient;
  let containerId: string;

  const holding = async (address: number, count = 1) =>
    (await readPlcValues(target, "HOLDING_REGISTER", address, count)) as number[];

  beforeAll(async () => {
    docker = createDockerClient(process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock");
    await ensureFactoryNetwork(docker, { factoryId, name: networkName, subnetCidr: await freeSubnet(docker) }, policy);
    const [apiHostPort = 0, modbusHostPort = 0] = allocateHostPorts(2, await listPublishedPorts(docker), policy);
    target = {
      factoryId,
      deviceId,
      networkName,
      serviceName: "plc-01",
      apiHostPort,
      modbusHostPort,
      bindAddress: "127.0.0.1",
    };
    client = openPlcClient(target, RUNTIME_SECRET);
  }, 120_000);

  afterAll(async () => {
    const filters = { label: [`${RUN_LABEL}=${runId}`] };
    for (const container of await docker.listContainers({ all: true, filters })) {
      await docker.getContainer(container.Id).remove({ force: true, v: true });
    }
    for (const network of await docker.listNetworks({ filters })) {
      await docker.getNetwork(network.Id).remove();
    }
  }, 120_000);

  it("starts the pinned runtime image under the hardened container settings", async () => {
    const created = await createOpenPlcContainer(docker, policy, target);
    containerId = created.containerId;

    const { runtimeVersion } = await startOpenPlc(docker, containerId, client);
    expect(runtimeVersion).toBe("v4.2.4");

    const details = await docker.getContainer(containerId).inspect();
    expect(details.Config.Image).toContain("sha256:8412ffa8a5de98caba7a2b1cc03009f944e8153175361b61297f34f7a501fc4f");
    expect(details.HostConfig.Privileged).toBe(false);
    expect(details.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(details.Mounts).toEqual([]);
    expect(details.HostConfig.Memory).toBe(1024 * 1024 * 1024);

    // Up, but with no program loaded the PLC is not executing anything yet.
    const health = await openPlcHealth(docker, containerId, client);
    expect(health).toMatchObject({ containerRunning: true, plcStatus: "EMPTY", state: "DEGRADED" });
  }, 300_000);

  it("deploys a Structured Text program and executes it cyclically", async () => {
    const deployed = await deployProgram(client, program(1));
    expect(deployed.md5).toMatch(/^[0-9a-f]{32}$/);
    expect(deployed.compilerVersion).toBe("0.7.0");

    expect((await openPlcHealth(docker, containerId, client)).state).toBe("RUNNING");

    const [, before = 0] = await holding(0, 2);
    await sleep(1000);
    const [, after = 0] = await holding(0, 2);
    // A 50 ms task adds about 20 counts per second.
    expect(after - before).toBeGreaterThanOrEqual(10);
    expect(after - before).toBeLessThanOrEqual(40);
  }, 300_000);

  it("lets PLC logic, not the writer, decide the device command", async () => {
    // The start command is accepted by Modbus…
    await writePlcValue(target, "COIL", 0, true);
    await sleep(300);
    expect(await readPlcValues(target, "COIL", 0)).toEqual([true]);
    // …but the interlock is not satisfied, so the PLC keeps the setpoint at zero.
    expect(await holding(0)).toEqual([0]);

    // Once the permissive is there, the same command produces the setpoint.
    await writePlcValue(target, "COIL", 1, true);
    await sleep(300);
    expect(await holding(0)).toEqual([45]);

    await writePlcValue(target, "COIL", 0, false);
    await sleep(300);
    expect(await holding(0)).toEqual([0]);
  }, 60_000);

  it("refuses writes to read-only Modbus areas", async () => {
    await expect(writePlcValue(target, "INPUT_REGISTER", 0, 500)).rejects.toMatchObject({
      code: "INCOMPATIBLE",
      details: { rule: "writable-area" },
    });
    expect(await readPlcValues(target, "INPUT_REGISTER", 0)).toEqual([0]);
  });

  it("redeploys a changed program without recreating the container or its image", async () => {
    const imageBefore = (await inspectRuntimeContainer(docker, containerId)).imageId;

    await deployProgram(client, program(5));

    const [, before = 0] = await holding(0, 2);
    await sleep(1000);
    const [, after = 0] = await holding(0, 2);
    // Same 50 ms task, now counting in steps of 5.
    expect(after - before).toBeGreaterThanOrEqual(50);

    const status = await inspectRuntimeContainer(docker, containerId);
    expect(status.imageId).toBe(imageBefore);
    expect(status.running).toBe(true);
    expect((await docker.listContainers({ filters: { label: [`${RUN_LABEL}=${runId}`] } })).map((c) => c.Id)).toEqual([
      containerId,
    ]);
  }, 300_000);

  it("rejects a program that does not compile and keeps the running one", async () => {
    const broken = program(1).replace("ScanCounter := ScanCounter + 1;", "ScanCounter := Undeclared_Tag + ;");

    const error = await deployProgram(client, broken).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("VALIDATION");
    expect((error as DomainError).details.rule).toBe("program-compile");
    expect(((error as DomainError).details.diagnostics as unknown[]).length).toBeGreaterThan(0);

    expect((await openPlcHealth(docker, containerId, client)).state).toBe("RUNNING");
  }, 120_000);

  it("restarts, stops and removes the runtime", async () => {
    await restartOpenPlc(docker, containerId, client);
    expect((await openPlcHealth(docker, containerId, client)).containerRunning).toBe(true);

    await stopOpenPlc(docker, containerId);
    const stopped = await openPlcHealth(docker, containerId, client);
    expect(stopped.containerRunning).toBe(false);
    expect(stopped.plcStatus).toBeUndefined();

    expect(await removeOpenPlc(docker, containerId)).toBe(true);
    expect(await removeOpenPlc(docker, containerId)).toBe(false);
  }, 300_000);
});
