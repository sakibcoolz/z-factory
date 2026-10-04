// @vitest-environment node
import { randomUUID } from "node:crypto";
import type Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDockerClient } from "@/lib/docker/client";
import { DEFAULT_LIMITS } from "@/lib/docker/policy";
import { RUNTIME_IMAGES } from "@/lib/docker/runtime-images";
import { DomainError, type DomainErrorCode } from "@/lib/domain/errors";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { createDeviceInstance } from "@/lib/services/device-service";
import { createFactory } from "@/lib/services/factory-service";
import {
  createProgramVersion,
  deployProgramVersion,
  listProgramVersions,
  readPlcRegisters,
  refreshPlcState,
  removePlcRuntime,
  restartPlc,
  type RuntimeDeps,
  startPlc,
  stopPlc,
  writePlcRegister,
} from "@/lib/services/plc-runtime-service";
import { cidrsOverlap } from "@/lib/validation/network";
import { createGenericModel, openTestDb, resetDb } from "./harness";

/**
 * The PLC runtime service end to end: PostgreSQL for configuration, versions, state and
 * events, and a real Docker Engine running OpenPLC. Needs TEST_DATABASE_URL and TEST_DOCKER=1.
 */
const enabled = process.env.TEST_DOCKER === "1" && Boolean(process.env.TEST_DATABASE_URL);
const describeRuntime = enabled ? describe : describe.skip;

const RUN_LABEL = "zfactory.test-run";
const runId = randomUUID();
const alice = { ownerId: "alice" };
const bob = { ownerId: "bob" };

const program = (step: number) => `PROGRAM main
  VAR
    StartCommand AT %QX0.0 : BOOL;
    Setpoint AT %QW0 : INT;
    ScanCounter AT %QW1 : INT;
  END_VAR
  ScanCounter := ScanCounter + ${step};
  IF StartCommand THEN
    Setpoint := 45;
  ELSE
    Setpoint := 0;
  END_IF;
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#50ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : main;
  END_RESOURCE
END_CONFIGURATION
`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function expectDomainError(action: Promise<unknown>, code: DomainErrorCode, rule?: string) {
  const error = await action.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe(code);
  if (rule) expect((error as DomainError).details.rule).toBe(rule);
}

async function freeSubnet(docker: Docker): Promise<string> {
  const used = (await docker.listNetworks()).flatMap((network) =>
    (network.IPAM?.Config ?? []).map((config) => config.Subnet).filter((subnet): subnet is string => Boolean(subnet)),
  );
  for (let third = 50; third < 100; third += 1) {
    const candidate = `10.213.${third}.0/28`;
    if (!used.some((subnet) => !subnet.includes(":") && cidrsOverlap(candidate, subnet))) return candidate;
  }
  throw new Error("no free test subnet");
}

describeRuntime("PLC runtime service with PostgreSQL and a real Docker Engine", () => {
  let db: PrismaClient;
  let docker: Docker;
  let deps: RuntimeDeps;
  let factoryId: string;
  let plcId: string;
  let vfdId: string;

  const device = () =>
    db.deviceInstance.findUniqueOrThrow({ where: { id: plcId }, include: { plcProfile: true, runtimePorts: true } });
  const events = async () =>
    (await db.runtimeEvent.findMany({ where: { deviceId: plcId }, orderBy: { occurredAt: "asc" } })).map(
      (event) => event.type,
    );
  const counter = async () =>
    ((await readPlcRegisters(deps, alice, plcId, { area: "HOLDING_REGISTER", address: 1 })) as number[])[0] ?? 0;

  beforeAll(async () => {
    db = openTestDb();
    await resetDb(db);
    docker = createDockerClient(process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock");
    deps = {
      db,
      docker,
      policy: {
        images: RUNTIME_IMAGES,
        portRange: { min: 15700, max: 15799 },
        bindAddresses: ["127.0.0.1"],
        limits: DEFAULT_LIMITS,
        labels: { [RUN_LABEL]: runId },
      },
      runtimeSecret: "integration-test-runtime-secret-0123456789",
    };

    const factory = await createFactory(db, alice, {
      name: "Pump House",
      slug: "pump-house",
      subnetCidr: await freeSubnet(docker),
    });
    factoryId = factory.id;
    const plcModel = await createGenericModel(db, "PLC", "Generic compact PLC", { architectureType: "COMPACT" });
    const vfdModel = await createGenericModel(db, "VFD", "Generic VFD");
    plcId = (await createDeviceInstance(db, { factoryId, deviceModelId: plcModel.id, name: "S7-1200-1214C-01" })).id;
    vfdId = (await createDeviceInstance(db, { factoryId, deviceModelId: vfdModel.id, name: "VFD-01" })).id;
  }, 120_000);

  afterAll(async () => {
    const filters = { label: [`${RUN_LABEL}=${runId}`] };
    for (const container of await docker.listContainers({ all: true, filters })) {
      await docker.getContainer(container.Id).remove({ force: true, v: true });
    }
    for (const network of await docker.listNetworks({ filters })) {
      await docker.getNetwork(network.Id).remove();
    }
    await db.$disconnect();
  }, 120_000);

  it("versions programs explicitly and selects the newest for deployment", async () => {
    const v1 = await createProgramVersion(db, alice, plcId, { sourceText: program(1) });
    expect(v1).toMatchObject({ version: 1, status: "DRAFT", language: "ST" });
    expect(v1.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect((await device()).plcProfile?.programVersionId).toBe(v1.id);

    await expectDomainError(
      createProgramVersion(db, alice, plcId, { sourceText: "   " }),
      "VALIDATION",
      "program-source",
    );
    await expectDomainError(createProgramVersion(db, bob, plcId, { sourceText: program(1) }), "NOT_FOUND");
    await expectDomainError(createProgramVersion(db, alice, vfdId, { sourceText: program(1) }), "INCOMPATIBLE");
  });

  it("refuses runtime operations before the PLC is started", async () => {
    await expectDomainError(deployProgramVersion(deps, alice, plcId), "CONFLICT", "runtime-required");
    await expectDomainError(stopPlc(deps, alice, plcId), "CONFLICT", "runtime-required");
    await expectDomainError(
      readPlcRegisters(deps, alice, plcId, { area: "HOLDING_REGISTER", address: 0 }),
      "CONFLICT",
      "runtime-required",
    );
  });

  it("starts the PLC, deploys the selected program and records what ran", async () => {
    expect(await startPlc(deps, alice, plcId)).toEqual({ state: "RUNNING" });

    const plc = await device();
    expect(plc.runtimeStatus).toBe("RUNNING");
    expect(plc.dockerContainerId).toMatch(/^[0-9a-f]{64}$/);
    // The DNS name inside the factory network comes from the instance name.
    expect(plc.hostName).toBe("s7-1200-1214c-01");
    // Runtime identity is recorded apart from the hardware profile the instance carries.
    expect(plc.plcProfile).toMatchObject({ runtimeVersion: "OpenPLC Runtime v4.2.4" });
    expect(plc.plcProfile?.runtimeImage).toContain("openplc-runtime:v4.2.4@sha256:8412ffa8");
    expect(plc.plcProfile?.imageDigest).toMatch(/^sha256:/);
    expect(plc.plcProfile?.apiHostPort).toBeGreaterThanOrEqual(15700);
    expect(plc.runtimePorts).toEqual([
      expect.objectContaining({ protocol: "MODBUS_TCP", containerPort: 502, bindAddress: "127.0.0.1" }),
    ]);
    expect(plc.runtimePorts[0]?.hostPort).not.toBe(plc.plcProfile?.apiHostPort);

    expect((await listProgramVersions(db, alice, plcId)).map((v) => [v.version, v.status])).toEqual([[1, "DEPLOYED"]]);
    expect(await events()).toEqual(["DEVICE_STARTING", "PLC_PROGRAM_DEPLOYED"]);
    expect((await db.factory.findUniqueOrThrow({ where: { id: factoryId } })).runtimeStatus).toBe("RUNNING");

    const snapshot = await db.configurationVersion.findFirstOrThrow({ where: { scopeType: "PLC", scopeId: plcId } });
    expect(snapshot).toMatchObject({ version: 1, createdBy: "alice" });
    expect(snapshot.snapshotJson).toMatchObject({
      programVersion: 1,
      ioMappingVersion: 0,
      modbusMappingVersion: 0,
      runtime: "OpenPLC Runtime v4.2.4",
      compiler: "STruC++ 0.7.0",
    });

    const container = await docker.getContainer(plc.dockerContainerId ?? "").inspect();
    expect(container.Config.Labels).toMatchObject({ "zfactory.factory-id": factoryId, "zfactory.device-id": plcId });
    expect(container.HostConfig.NetworkMode).toBe(`zfactory_${factoryId}`);
  }, 400_000);

  it("executes the program and gives tag access through the PLC", async () => {
    const before = await counter();
    await sleep(1000);
    expect((await counter()) - before).toBeGreaterThanOrEqual(10);

    await writePlcRegister(deps, alice, plcId, { area: "COIL", address: 0, value: true });
    await sleep(300);
    expect(await readPlcRegisters(deps, alice, plcId, { area: "HOLDING_REGISTER", address: 0 })).toEqual([45]);

    await expectDomainError(readPlcRegisters(deps, bob, plcId, { area: "HOLDING_REGISTER", address: 0 }), "NOT_FOUND");
    await expectDomainError(
      writePlcRegister(deps, bob, plcId, { area: "COIL", address: 0, value: false }),
      "NOT_FOUND",
    );
  }, 60_000);

  it("redeploys a new version into the same container", async () => {
    const containerBefore = (await device()).dockerContainerId;
    const v2 = await createProgramVersion(db, alice, plcId, { sourceText: program(5) });

    expect(await deployProgramVersion(deps, alice, plcId)).toEqual({ version: 2 });

    expect((await listProgramVersions(db, alice, plcId)).map((v) => [v.version, v.status])).toEqual([
      [1, "COMPILED"],
      [2, "DEPLOYED"],
    ]);
    const plc = await device();
    expect(plc.dockerContainerId).toBe(containerBefore);
    expect(plc.plcProfile?.programVersionId).toBe(v2.id);
    expect(await db.configurationVersion.count({ where: { scopeType: "PLC", scopeId: plcId } })).toBe(2);

    const before = await counter();
    await sleep(1000);
    expect((await counter()) - before).toBeGreaterThanOrEqual(50);
  }, 400_000);

  it("turns a program that does not compile into a failed version and an event, not an outage", async () => {
    await createProgramVersion(db, alice, plcId, {
      sourceText: program(1).replace("ScanCounter + 1;", "Missing_Tag + ;"),
    });

    await expectDomainError(deployProgramVersion(deps, alice, plcId), "VALIDATION", "program-compile");

    expect((await listProgramVersions(db, alice, plcId)).map((v) => [v.version, v.status])).toEqual([
      [1, "COMPILED"],
      [2, "DEPLOYED"],
      [3, "FAILED"],
    ]);
    expect((await events()).at(-1)).toBe("PLC_PROGRAM_DEPLOY_FAILED");
    expect(await refreshPlcState(deps, alice, plcId)).toEqual({ state: "RUNNING" });
    expect((await device()).runtimeStatus).toBe("RUNNING");
  }, 120_000);

  it("restarts the container and comes back running the same program", async () => {
    await expectDomainError(restartPlc(deps, bob, plcId), "NOT_FOUND");

    const restarted = await restartPlc(deps, alice, plcId);
    // The runtime reloads the built program on boot; give it a moment to reach RUN.
    let state = restarted.state;
    for (let attempt = 0; attempt < 20 && state !== "RUNNING"; attempt += 1) {
      await sleep(1000);
      state = (await refreshPlcState(deps, alice, plcId)).state;
    }
    expect(state).toBe("RUNNING");

    const before = await counter();
    await sleep(1000);
    expect((await counter()) - before).toBeGreaterThanOrEqual(50);
  }, 300_000);

  it("records a crashed runtime as a faulted device with an event", async () => {
    const containerId = (await device()).dockerContainerId ?? "";
    await docker.getContainer(containerId).kill();

    expect(await refreshPlcState(deps, alice, plcId)).toEqual({ state: "FAULTED" });
    expect((await device()).runtimeStatus).toBe("FAULTED");
    expect((await events()).at(-1)).toBe("DEVICE_FAULTED");
    expect((await db.factory.findUniqueOrThrow({ where: { id: factoryId } })).runtimeStatus).toBe("DEGRADED");
  }, 60_000);

  it("recovers by starting again, then stops and removes the runtime", async () => {
    // Version 3 does not compile; select the last good one before restarting.
    const [, v2] = await listProgramVersions(db, alice, plcId);
    await db.plcInstanceProfile.update({ where: { deviceInstanceId: plcId }, data: { programVersionId: v2?.id } });
    expect(await startPlc(deps, alice, plcId)).toEqual({ state: "RUNNING" });

    await expectDomainError(stopPlc(deps, bob, plcId), "NOT_FOUND");
    await stopPlc(deps, alice, plcId);
    expect((await device()).runtimeStatus).toBe("STOPPED");
    expect((await db.factory.findUniqueOrThrow({ where: { id: factoryId } })).runtimeStatus).toBe("STOPPED");

    await removePlcRuntime(deps, alice, plcId);
    const plc = await device();
    expect(plc).toMatchObject({ dockerContainerId: null, runtimeStatus: "STOPPED", runtimePorts: [] });
    expect(plc.plcProfile?.apiHostPort).toBeNull();
    // Program history survives removing the container.
    expect(await listProgramVersions(db, alice, plcId)).toHaveLength(3);
    expect(await docker.listContainers({ all: true, filters: { label: [`${RUN_LABEL}=${runId}`] } })).toEqual([]);
  }, 400_000);
});
