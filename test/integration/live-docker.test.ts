// @vitest-environment node
import { randomUUID } from "node:crypto";
import type Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadCatalog } from "@/lib/catalog";
import { ingestCatalog } from "@/lib/catalog/ingest";
import { createDockerClient } from "@/lib/docker/client";
import { DEFAULT_LIMITS } from "@/lib/docker/policy";
import { RUNTIME_IMAGES } from "@/lib/docker/runtime-images";
import type { LiveMessage } from "@/lib/domain/live";
import { EventBus } from "@/lib/events/bus";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { EMPTY_OPERATION_STATE } from "@/lib/plc/operation-state";
import { DeviceSimulatorRuntime } from "@/lib/runtimes/device-sim/runtime";
import { TagMonitorRuntime } from "@/lib/runtimes/tag-monitor/monitor";
import { listAlarms, listEvents } from "@/lib/services/event-service";
import { createFactory } from "@/lib/services/factory-service";
import { getLiveTags, type LiveDeps, openLiveStream } from "@/lib/services/live-service";
import { addPeripheral, createPlc } from "@/lib/services/plc-config-service";
import { createProgramVersion, type RuntimeDeps } from "@/lib/services/plc-runtime-service";
import { getPlcProgramView } from "@/lib/services/plc-runtime-view-service";
import { createTag } from "@/lib/services/tag-service";
import { cidrsOverlap } from "@/lib/validation/network";
import { openTestDb, resetDb } from "./harness";

/** A refused operation: its message and, since TASK-1007, the explanation a domain error carries. */
const refused = (message: string) => ({ message, explanation: expect.objectContaining({ actual: message }) });

/**
 * Live values, commands and alarms on a real OpenPLC runtime: what an operator writes
 * reaches the PLC as a command, the program decides the output, and what the program
 * reports comes back as live values and alarms. Needs TEST_DATABASE_URL and TEST_DOCKER=1.
 */
const enabled = process.env.TEST_DOCKER === "1" && Boolean(process.env.TEST_DATABASE_URL);
const describeRuntime = enabled ? describe : describe.skip;

const RUN_LABEL = "zfactory.test-run";
const runId = randomUUID();
const alice = { ownerId: "alice" };

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  runtimeDeps: undefined as unknown,
  liveDeps: undefined as unknown,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db/client", async (original) => ({ ...(await original<object>()), getDb: () => state.db }));
vi.mock("@/lib/auth/actor", () => ({ requireActor: async () => ({ ownerId: "alice" }) }));
vi.mock("@/lib/services/runtime-deps", () => ({
  getRuntimeDeps: () => state.runtimeDeps,
  getLiveDeps: () => state.liveDeps,
}));

const plcActions = await import("@/app/factories/[factoryId]/plcs/runtime-actions");
const liveActions = await import("@/app/factories/[factoryId]/live-actions");

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function freeSubnet(docker: Docker): Promise<string> {
  const used = (await docker.listNetworks()).flatMap((network) =>
    (network.IPAM?.Config ?? []).map((config) => config.Subnet).filter((subnet): subnet is string => Boolean(subnet)),
  );
  for (let third = 1; third < 20; third += 1) {
    const candidate = `10.216.${third}.0/28`;
    if (!used.some((subnet) => !subnet.includes(":") && cidrsOverlap(candidate, subnet))) return candidate;
  }
  throw new Error("no free test subnet");
}

describeRuntime("live values, commands and alarms on a real OpenPLC runtime", () => {
  let db: PrismaClient;
  let docker: Docker;
  let live: LiveDeps;
  let factoryId: string;
  let plcId: string;
  let closeStream: () => void = () => undefined;
  const stream: LiveMessage[] = [];

  const operate = (operation: string) =>
    plcActions.runtimeAction(factoryId, plcId, EMPTY_OPERATION_STATE, form({ operation }));
  const write = (tag: string, value: string) =>
    liveActions.writeTagAction(factoryId, plcId, tag, EMPTY_OPERATION_STATE, form({ value }));
  const reading = async (name: string) =>
    (await getLiveTags(live, alice, factoryId)).tags.find((tag) => tag.name === name)?.reading;

  async function until(condition: () => Promise<boolean>, timeoutMs = 15_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await condition()) return true;
      await sleep(150);
    }
    return condition();
  }

  beforeAll(async () => {
    db = openTestDb();
    state.db = db;
    await resetDb(db);
    await ingestCatalog(db, loadCatalog());
    docker = createDockerClient(process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock");
    const bus = new EventBus();
    const runtime: RuntimeDeps = {
      db,
      docker,
      bus,
      policy: {
        images: RUNTIME_IMAGES,
        portRange: { min: 15700, max: 15799 },
        bindAddresses: ["127.0.0.1"],
        limits: DEFAULT_LIMITS,
        labels: { [RUN_LABEL]: runId },
      },
      runtimeSecret: "integration-test-runtime-secret-0123456789",
    };
    live = {
      db,
      bus,
      monitor: new TagMonitorRuntime(),
      simulator: new DeviceSimulatorRuntime(),
      pollMs: 150,
      sampling: { minIntervalMs: 200, maxIntervalMs: 60_000, deadbandRatio: 0.01 },
    };
    state.runtimeDeps = runtime;
    state.liveDeps = live;

    const modelId = async (modelName: string) => (await db.deviceModel.findFirstOrThrow({ where: { modelName } })).id;
    factoryId = (
      await createFactory(db, alice, {
        name: "Live Station",
        slug: "live-station",
        subnetCidr: await freeSubnet(docker),
      })
    ).id;
    plcId = (
      await createPlc(db, alice, { factoryId, deviceModelId: await modelId("CPU 1214C DC/DC/DC"), name: "PLC-01" })
    ).id;
    await addPeripheral(db, alice, plcId, {
      deviceModelId: await modelId("Generic on/off valve, 24 V DC"),
      name: "XV-101",
    });
    await createTag(db, alice, plcId, {
      name: "Start_Cmd",
      dataType: "BOOL",
      role: "COMMAND",
      logicalAddress: "%QX10.0",
    });
    await createTag(db, alice, plcId, {
      name: "Hold_Limit",
      dataType: "INT16",
      role: "SETPOINT",
      logicalAddress: "%QW10",
    });
    await createTag(db, alice, plcId, {
      name: "Limit_Alarm",
      dataType: "BOOL",
      role: "ALARM",
      logicalAddress: "%QX10.1",
    });
    await createTag(db, alice, plcId, {
      name: "Interlock",
      dataType: "BOOL",
      role: "STATUS",
      logicalAddress: "%QX10.2",
    });

    // The operator may ask; the program decides: no output while the limit is exceeded.
    const starter = (await getPlcProgramView(db, alice, plcId)).source;
    const program = starter.replace(
      "Scans := Scans + 1;",
      [
        "Scans := Scans + 1;",
        "  Limit_Alarm := Hold_Limit > 100;",
        "  Interlock := Limit_Alarm;",
        "  XV_101_Y1 := Start_Cmd AND NOT Interlock;",
      ].join("\n"),
    );
    await createProgramVersion(db, alice, plcId, { sourceText: program });
  }, 120_000);

  afterAll(async () => {
    closeStream();
    await live.monitor.stopAll();
    const filters = { label: [`${RUN_LABEL}=${runId}`] };
    for (const container of await docker.listContainers({ all: true, filters })) {
      await docker.getContainer(container.Id).remove({ force: true, v: true });
    }
    for (const network of await docker.listNetworks({ filters })) {
      await docker.getNetwork(network.Id).remove();
    }
    await db.$disconnect();
  }, 120_000);

  it("reads the tags of a started PLC and streams them", async () => {
    closeStream = await openLiveStream(live, alice, factoryId, null, (message) => stream.push(message));
    expect(await operate("start")).toEqual({ notice: "The runtime is started: running." });
    expect(live.monitor.isRunning(plcId)).toBe(true);
    expect(await until(async () => (await reading("Start_Cmd"))?.quality === "GOOD")).toBe(true);
    expect(await reading("XV_101_Y1")).toMatchObject({ value: false, quality: "GOOD" });

    const kinds = stream.map((message) => (message.kind === "event" ? message.event.type : message.kind));
    expect(kinds[0]).toBe("snapshot");
    expect(kinds).toEqual(expect.arrayContaining(["DEVICE_STARTING", "PLC_PROGRAM_DEPLOYED", "CONNECTION_UP", "tags"]));
    // Unchanged values are still confirmed, so they do not go stale in the browser.
    const confirmations = () => stream.filter((message) => message.kind === "tags" && message.confirmed).length;
    const before = confirmations();
    await sleep(2500);
    expect(confirmations()).toBeGreaterThan(before);
  }, 300_000);

  it("writes a command to the PLC and lets the program decide the output", async () => {
    expect(await write("Start_Cmd", "true")).toEqual({
      notice: "Accepted by the PLC: Start_Cmd = ON. PLC logic decides what follows.",
    });
    expect(await until(async () => (await reading("XV_101_Y1"))?.value === true)).toBe(true);

    // The setpoint makes the program raise its alarm and interlock the output: the command still stands.
    expect((await write("Hold_Limit", "150")).notice).toContain("Hold_Limit = 150");
    expect(await until(async () => (await reading("XV_101_Y1"))?.value === false)).toBe(true);
    expect(await reading("Start_Cmd")).toMatchObject({ value: true, quality: "GOOD" });
    expect(await reading("Limit_Alarm")).toMatchObject({ value: true });

    // An output of the program cannot be written from outside, and the attempt is kept.
    expect(await write("XV_101_Y1", "true")).toEqual(refused("XV_101_Y1 is a STATUS tag and cannot be written."));
    expect(await write("Limit_Alarm", "false")).toEqual(refused("Limit_Alarm is a ALARM tag and cannot be written."));
    expect(await write("Hold_Limit", "999999")).toMatchObject({ message: expect.stringContaining("range") });
    const commands = (await listEvents(db, alice, factoryId, { family: "COMMAND" })).map((event) => event.type);
    expect(commands.filter((type) => type === "COMMAND_ACCEPTED")).toHaveLength(2);
    expect(commands.filter((type) => type === "COMMAND_REJECTED")).toHaveLength(2);
  }, 120_000);

  it("turns the program's alarm tag into an alarm with a beginning and an end", async () => {
    const active = async () => (await listAlarms(db, alice, factoryId)).filter((alarm) => alarm.clearedAt === null);
    expect(await until(async () => (await active()).length === 1)).toBe(true);
    expect((await active())[0]).toMatchObject({
      code: "TAG:Limit_Alarm",
      tagName: "Limit_Alarm",
      deviceName: "PLC-01",
    });

    await write("Hold_Limit", "50");
    expect(await until(async () => (await active()).length === 0)).toBe(true);
    // With the alarm gone the interlock releases and the standing command opens the valve again.
    expect(await until(async () => (await reading("XV_101_Y1"))?.value === true)).toBe(true);
    const alarmEvents = stream.flatMap((message) =>
      message.kind === "event" && message.event.type.startsWith("ALARM_") ? [message.event.type] : [],
    );
    expect(alarmEvents).toEqual(["ALARM_RAISED", "ALARM_CLEARED"]);
  }, 120_000);

  it("stores telemetry for what changed, far less than one sample per read", async () => {
    const stored = async (name: string) => db.telemetrySample.count({ where: { factoryId, tag: { name } } });
    // Hold_Limit was 0, then 150, then 50. The last sample is written by the cycle that read it.
    expect(await until(async () => (await stored("Hold_Limit")) >= 3)).toBe(true);
    expect(await stored("Hold_Limit")).toBeLessThanOrEqual(4);
    // Start_Cmd changed once.
    expect(await stored("Start_Cmd")).toBe(2);
    const cycles = live.monitor.status(plcId)?.cycles ?? 0;
    expect(cycles).toBeGreaterThan(20);
    expect(await db.telemetrySample.count({ where: { factoryId } })).toBeLessThan(cycles);
  });

  it("stops reading the PLC when it is stopped, without calling that a lost connection", async () => {
    expect(await operate("stop")).toEqual({ notice: "The runtime is stopped. Its container and program are kept." });
    expect(live.monitor.isRunning(plcId)).toBe(false);
    expect(await reading("Start_Cmd")).toEqual({
      plcId,
      name: "Start_Cmd",
      value: null,
      quality: "DISCONNECTED",
      readAt: null,
    });
    expect((await listAlarms(db, alice, factoryId)).map((alarm) => alarm.code)).not.toContain("PLC_LINK_DOWN");
    expect((await listEvents(db, alice, factoryId, { family: "LINK" })).map((event) => event.type)).not.toContain(
      "CONNECTION_DOWN",
    );
    const last = stream.filter((message) => message.kind === "tags").at(-1);
    expect(last).toMatchObject({ confirmed: false });
    expect(await operate("remove")).toMatchObject({ notice: expect.stringContaining("removed") });
  }, 300_000);
});
