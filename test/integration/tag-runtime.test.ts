// @vitest-environment node
import { randomUUID } from "node:crypto";
import type Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDockerClient } from "@/lib/docker/client";
import { DEFAULT_LIMITS } from "@/lib/docker/policy";
import { RUNTIME_IMAGES } from "@/lib/docker/runtime-images";
import { DomainError, type DomainErrorCode } from "@/lib/domain/errors";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { readModbus, writeModbus } from "@/lib/protocols/modbus/client";
import { createDeviceInstance } from "@/lib/services/device-service";
import { createFactory } from "@/lib/services/factory-service";
import {
  configureModbusEndpoint,
  createProgramVersion,
  removePlcRuntime,
  type RuntimeDeps,
  startPlc,
  stopPlc,
} from "@/lib/services/plc-runtime-service";
import { createTag, getModbusMap, readTag, readTags, writeTag } from "@/lib/services/tag-service";
import { cidrsOverlap } from "@/lib/validation/network";
import { createGenericModel, openTestDb, resetDb } from "./harness";

/**
 * Typed tag access and the external Modbus endpoint, end to end: PostgreSQL for the tag
 * registry and commands, a real Docker Engine running OpenPLC.
 * Needs TEST_DATABASE_URL and TEST_DOCKER=1.
 */
const enabled = process.env.TEST_DOCKER === "1" && Boolean(process.env.TEST_DATABASE_URL);
const describeRuntime = enabled ? describe : describe.skip;

const RUN_LABEL = "zfactory.test-run";
const runId = randomUUID();
const alice = { ownerId: "alice" };
const bob = { ownerId: "bob" };
const EXTERNAL_PORT = 15650;

/** One located variable per tag below; the echoes prove a written value reached PLC logic. */
const PROGRAM = `PROGRAM main
  VAR
    StartCommand AT %QX0.0 : BOOL;
    RunStatus AT %QX0.1 : BOOL;
    SpeedSetpoint AT %QW0 : INT;
    SpeedEcho AT %MW0 : INT;
    PressureSetpoint AT %MD0 : REAL;
    ScanCount AT %MD1 : DINT;
    PressureEcho AT %MD2 : REAL;
  END_VAR
  ScanCount := ScanCount + 1;
  RunStatus := StartCommand;
  SpeedEcho := SpeedSetpoint + 1;
  PressureEcho := PressureSetpoint * 2.0;
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#50ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : main;
  END_RESOURCE
END_CONFIGURATION
`;

const TAGS = [
  { name: "Pump01_StartCommand", dataType: "BOOL", role: "COMMAND", logicalAddress: "%QX0.0" },
  { name: "Pump01_Running", dataType: "BOOL", role: "STATUS", logicalAddress: "%QX0.1" },
  { name: "VFD01_SpeedSetpoint", dataType: "INT16", role: "SETPOINT", logicalAddress: "%QW0", scale: 0.1, unit: "Hz" },
  { name: "VFD01_SpeedEcho", dataType: "INT16", role: "FEEDBACK", logicalAddress: "%MW0", scale: 0.1, unit: "Hz" },
  { name: "PT101_PressureSetpoint", dataType: "FLOAT32", role: "SETPOINT", logicalAddress: "%MD0", unit: "bar" },
  { name: "PLC_ScanCount", dataType: "INT32", role: "FEEDBACK", logicalAddress: "%MD1" },
  { name: "PT101_PressureEcho", dataType: "FLOAT32", role: "PROCESS_VALUE", logicalAddress: "%MD2", unit: "bar" },
];

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
  for (let third = 20; third < 50; third += 1) {
    const candidate = `10.213.${third}.0/28`;
    if (!used.some((subnet) => !subnet.includes(":") && cidrsOverlap(candidate, subnet))) return candidate;
  }
  throw new Error("no free test subnet");
}

describeRuntime("typed tags and the external Modbus endpoint on a real runtime", () => {
  let db: PrismaClient;
  let docker: Docker;
  let deps: RuntimeDeps;
  let factoryId: string;
  let plcId: string;
  let secondPlcId: string;

  const value = async (name: string) => (await readTag(deps, alice, plcId, name)).value;

  /** Runs `nc` in a throwaway busybox container on the given network; true when the TCP connect succeeds. */
  async function canConnectFrom(network: string, host: string, port: number): Promise<boolean> {
    const container = await docker.createContainer({
      Image: "busybox:1.37",
      Cmd: ["sh", "-c", `nc -w 3 ${host} ${port} </dev/null`],
      Labels: { [RUN_LABEL]: runId },
      HostConfig: { NetworkMode: network },
    });
    await container.start();
    const result = (await container.wait()) as { StatusCode: number };
    await container.remove({ force: true });
    return result.StatusCode === 0;
  }

  beforeAll(async () => {
    db = openTestDb();
    await resetDb(db);
    docker = createDockerClient(process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock");
    deps = {
      db,
      docker,
      policy: {
        images: RUNTIME_IMAGES,
        portRange: { min: 15600, max: 15699 },
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
    plcId = (await createDeviceInstance(db, { factoryId, deviceModelId: plcModel.id, name: "PLC-01" })).id;
    secondPlcId = (await createDeviceInstance(db, { factoryId, deviceModelId: plcModel.id, name: "PLC-02" })).id;

    await createProgramVersion(db, alice, plcId, { sourceText: PROGRAM });
    for (const tag of TAGS) await createTag(db, alice, plcId, tag);
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

  it("publishes the PLC's Modbus server on the configured host endpoint", async () => {
    await expectDomainError(
      configureModbusEndpoint(deps, alice, plcId, { bindAddress: "127.0.0.1", hostPort: 80 }),
      "VALIDATION",
      "host-port-range",
    );
    await expectDomainError(
      configureModbusEndpoint(deps, alice, plcId, { bindAddress: "0.0.0.0", hostPort: EXTERNAL_PORT }),
      "VALIDATION",
      "bind-address-allowed",
    );
    await expectDomainError(
      configureModbusEndpoint(deps, bob, plcId, { bindAddress: "127.0.0.1", hostPort: EXTERNAL_PORT }),
      "NOT_FOUND",
    );

    expect(
      await configureModbusEndpoint(deps, alice, plcId, { bindAddress: "127.0.0.1", hostPort: EXTERNAL_PORT }),
    ).toEqual({ bindAddress: "127.0.0.1", hostPort: EXTERNAL_PORT });
    // Another PLC cannot claim an endpoint that is already reserved, even before anything runs.
    await expectDomainError(
      configureModbusEndpoint(deps, alice, secondPlcId, { bindAddress: "127.0.0.1", hostPort: EXTERNAL_PORT }),
      "CONFLICT",
      "host-port-taken",
    );

    expect(await startPlc(deps, alice, plcId)).toEqual({ state: "RUNNING" });

    const map = await getModbusMap(db, alice, plcId);
    expect(map.endpoint).toEqual({ bindAddress: "127.0.0.1", hostPort: EXTERNAL_PORT, containerPort: 502 });
    expect(map.version).toBe(TAGS.length);

    // The deployment snapshot carries the tag map that was live when the program was deployed.
    const snapshot = await db.configurationVersion.findFirstOrThrow({ where: { scopeType: "PLC", scopeId: plcId } });
    expect(snapshot.snapshotJson).toMatchObject({ modbusMappingVersion: TAGS.length });
    expect((snapshot.snapshotJson as { tags: unknown[] }).tags).toHaveLength(TAGS.length);

    await expectDomainError(
      configureModbusEndpoint(deps, alice, plcId, { bindAddress: "127.0.0.1", hostPort: EXTERNAL_PORT + 1 }),
      "CONFLICT",
      "runtime-recreate-required",
    );
  }, 400_000);

  it("is reachable by an external Modbus client on that endpoint", async () => {
    // A plain Modbus client outside the factory network, using only host address and port.
    const endpoint = { host: "127.0.0.1", port: EXTERNAL_PORT };
    await writeModbus(endpoint, "COIL", 0, true);
    await sleep(300);
    expect(await readModbus(endpoint, "COIL", 0, 2)).toEqual([true, true]);
    await writeModbus(endpoint, "COIL", 0, false);
    await sleep(300);
    expect(await readModbus(endpoint, "COIL", 1)).toEqual([false]);
  }, 60_000);

  it("keeps the PLC reachable by service name inside its factory network only", async () => {
    expect(await canConnectFrom(`zfactory_${factoryId}`, "plc-01", 502)).toBe(true);
    // The default bridge is a different network: no DNS name, no route by service name.
    expect(await canConnectFrom("bridge", "plc-01", 502)).toBe(false);
  }, 120_000);

  it("reads typed engineering values through the tag map", async () => {
    const first = (await value("PLC_ScanCount")) as number;
    await sleep(1000);
    const second = (await value("PLC_ScanCount")) as number;
    expect(second - first).toBeGreaterThanOrEqual(10);

    expect(await readTag(deps, alice, plcId, "PT101_PressureEcho")).toMatchObject({
      name: "PT101_PressureEcho",
      value: 0,
      unit: "bar",
      quality: "GOOD",
    });
    await expectDomainError(readTag(deps, alice, plcId, "No_Such_Tag"), "NOT_FOUND");
    await expectDomainError(readTag(deps, bob, plcId, "PLC_ScanCount"), "NOT_FOUND");
  }, 60_000);

  it("writes commands and setpoints with scaling and multi-word encoding", async () => {
    expect(await writeTag(deps, alice, plcId, "Pump01_StartCommand", true)).toMatchObject({ status: "ACCEPTED" });
    await writeTag(deps, alice, plcId, "VFD01_SpeedSetpoint", 45);
    await writeTag(deps, alice, plcId, "PT101_PressureSetpoint", 3.25);
    await sleep(400);

    // The PLC program saw the written values: status follows the command, echoes follow the setpoints.
    expect(await value("Pump01_Running")).toBe(true);
    expect(await value("VFD01_SpeedSetpoint")).toBeCloseTo(45);
    // Raw 450 + 1 = 451, scaled by 0.1.
    expect(await value("VFD01_SpeedEcho")).toBeCloseTo(45.1);
    expect(await value("PT101_PressureSetpoint")).toBe(3.25);
    expect(await value("PT101_PressureEcho")).toBe(6.5);

    const commands = await db.deviceCommand.findMany({
      where: { plcInstanceId: plcId },
      orderBy: { requestedAt: "asc" },
    });
    expect(commands.map((command) => [command.commandType, command.status, command.source])).toEqual([
      ["WRITE_TAG", "ACCEPTED", "UI"],
      ["WRITE_TAG", "ACCEPTED", "UI"],
      ["WRITE_TAG", "ACCEPTED", "UI"],
    ]);
    expect(commands.map((command) => command.requestedValueJson)).toEqual([true, 45, 3.25]);
    // Accepted by the PLC is not "applied by the device": that is read back from feedback.
    expect(commands.every((command) => command.appliedAt === null)).toBe(true);
  }, 60_000);

  it("refuses to write feedback, status and process values, and bad values", async () => {
    const before = await value("PT101_PressureEcho");

    for (const name of ["Pump01_Running", "VFD01_SpeedEcho", "PLC_ScanCount", "PT101_PressureEcho"]) {
      await expectDomainError(
        writeTag(deps, alice, plcId, name, name === "Pump01_Running" ? false : 1),
        "INVARIANT",
        "tag-read-only",
      );
    }
    await expectDomainError(writeTag(deps, alice, plcId, "VFD01_SpeedSetpoint", "fast"), "VALIDATION", "tag-value");
    await expectDomainError(writeTag(deps, alice, plcId, "VFD01_SpeedSetpoint", 9999), "VALIDATION", "tag-value");
    await expectDomainError(writeTag(deps, alice, plcId, "Pump01_StartCommand", 1), "VALIDATION", "tag-value");
    await expectDomainError(writeTag(deps, bob, plcId, "Pump01_StartCommand", false), "NOT_FOUND");

    expect(await value("PT101_PressureEcho")).toBe(before);
    expect(await value("Pump01_Running")).toBe(true);
    // Refused writes are not recorded as commands.
    expect(await db.deviceCommand.count({ where: { plcInstanceId: plcId } })).toBe(3);
  }, 60_000);

  it("reports every tag with its quality, and DISCONNECTED when the PLC is down", async () => {
    const live = await readTags(deps, alice, plcId);
    expect(live.map((reading) => reading.name).sort()).toEqual(TAGS.map((tag) => tag.name).sort());
    expect(live.every((reading) => reading.quality === "GOOD" && reading.value !== null)).toBe(true);

    await stopPlc(deps, alice, plcId);
    const down = await readTags(deps, alice, plcId);
    expect(down.every((reading) => reading.quality === "DISCONNECTED" && reading.value === null)).toBe(true);
    await expectDomainError(writeTag(deps, alice, plcId, "Pump01_StartCommand", false), "RUNTIME_FAILURE");
    expect(
      (await db.deviceCommand.findMany({ where: { plcInstanceId: plcId }, orderBy: { requestedAt: "desc" } }))[0]
        ?.status,
    ).toBe("FAILED");
  }, 120_000);

  it("keeps the endpoint when the runtime is removed and lets it be changed afterwards", async () => {
    await removePlcRuntime(deps, alice, plcId);
    expect((await getModbusMap(db, alice, plcId)).endpoint).toMatchObject({ hostPort: EXTERNAL_PORT });

    expect(
      await configureModbusEndpoint(deps, alice, plcId, { bindAddress: "127.0.0.1", hostPort: EXTERNAL_PORT + 1 }),
    ).toEqual({ bindAddress: "127.0.0.1", hostPort: EXTERNAL_PORT + 1 });
    // The old endpoint is free for another PLC now.
    expect(
      await configureModbusEndpoint(deps, alice, secondPlcId, { bindAddress: "127.0.0.1", hostPort: EXTERNAL_PORT }),
    ).toEqual({ bindAddress: "127.0.0.1", hostPort: EXTERNAL_PORT });
  }, 120_000);
});
