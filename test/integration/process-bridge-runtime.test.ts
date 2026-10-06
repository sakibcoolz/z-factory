// @vitest-environment node
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import type Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDockerClient } from "@/lib/docker/client";
import { DEFAULT_LIMITS } from "@/lib/docker/policy";
import { RUNTIME_IMAGES } from "@/lib/docker/runtime-images";
import { PROCESS_ALARM_PREFIX } from "@/lib/domain/alarms";
import type { DomainError } from "@/lib/domain/errors";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { loadModuleTypes } from "@/lib/process-modules";
import { ingestModuleTypes } from "@/lib/process-modules/ingest";
import { ProcessBridgeRuntime } from "@/lib/runtimes/process-bridge/runtime";
import { createProcessSimClient, type ProcessSimClient } from "@/lib/runtimes/process-sim/client";
import { DeviceSimulatorRuntime } from "@/lib/runtimes/device-sim/runtime";
import { GatewayEndpointRuntime } from "@/lib/runtimes/gateway-endpoint/runtime";
import { TagMonitorRuntime } from "@/lib/runtimes/tag-monitor/monitor";
import { EventBus } from "@/lib/events/bus";
import { type FactoryRuntimeDeps, startFactory, stopFactory } from "@/lib/services/factory-runtime-service";
import { createDeviceInstance } from "@/lib/services/device-service";
import { listAlarms, listEvents } from "@/lib/services/event-service";
import { createFactory } from "@/lib/services/factory-service";
import { createProgramVersion, type RuntimeDeps, startPlc, stopPlc } from "@/lib/services/plc-runtime-service";
import { bindModuleSignal, getModuleIoRegistry } from "@/lib/services/module-io-service";
import {
  clearProcessOverride,
  getProcessBridgeState,
  listProcessOverrides,
  setProcessOverride,
  type ProcessBridgeDeps,
  startProcessBridge,
  stopProcessBridge,
} from "@/lib/services/process-bridge-service";
import { assignModuleDevice, createModule, listModuleTypes } from "@/lib/services/process-module-service";
import { runScenario, type ScenarioDeps } from "@/lib/services/scenario-service";
import { createTag, readTag, writeTag } from "@/lib/services/tag-service";
import { cidrsOverlap } from "@/lib/validation/network";
import { createGenericModel, openTestDb, resetDb } from "./harness";

/**
 * The process loop, end to end (TASK-603): a Structured Text program on a real OpenPLC
 * runtime commands a pump house that the process simulation service models; the bridge
 * carries the command in and the process values out, and the program reacts to what comes
 * back. Needs TEST_DATABASE_URL, TEST_DOCKER=1 and PROCESS_SIM_BIN (the built service).
 */
const binary = process.env.PROCESS_SIM_BIN;
const enabled = process.env.TEST_DOCKER === "1" && Boolean(process.env.TEST_DATABASE_URL) && Boolean(binary);
const describeLoop = enabled ? describe : describe.skip;

const RUN_LABEL = "zfactory.test-run";
const runId = randomUUID();
const alice = { ownerId: "alice" };
const TOKEN = "integration-token-0123456789";

/**
 * A gateway may ask (Start_Cmd, Speed_SP, Reset_Cmd); the program decides what the pump
 * house gets: it limits the speed and trips above 3 bar. Speeds are in 0.01 %.
 */
const PROGRAM = `PROGRAM pump_house
  VAR
    Start_Cmd AT %QX101.0 : BOOL;
    High_Pressure_Trip AT %QX101.1 : BOOL;
    Reset_Cmd AT %QX101.2 : BOOL;
    Speed_SP AT %QW101 : INT;
    PH_Run_Cmd AT %QX100.0 : BOOL;
    PH_Speed_SP AT %QW100 : INT;
    PH_Running AT %MX10.0 : BOOL;
    PH_Low_Pressure AT %MX10.1 : BOOL;
    PH_Pressure AT %MD10 : REAL;
  END_VAR

  IF PH_Pressure > 3.0 THEN
    High_Pressure_Trip := TRUE;
  END_IF;
  IF Reset_Cmd THEN
    High_Pressure_Trip := FALSE;
  END_IF;
  PH_Run_Cmd := Start_Cmd AND NOT High_Pressure_Trip;
  IF NOT PH_Run_Cmd THEN
    PH_Speed_SP := 0;
  ELSIF Speed_SP > 9000 THEN
    PH_Speed_SP := 9000;
  ELSIF Speed_SP < 0 THEN
    PH_Speed_SP := 0;
  ELSE
    PH_Speed_SP := Speed_SP;
  END_IF;
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#50ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : pump_house;
  END_RESOURCE
END_CONFIGURATION
`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function freeSubnet(docker: Docker): Promise<string> {
  const used = (await docker.listNetworks()).flatMap((network) =>
    (network.IPAM?.Config ?? []).map((config) => config.Subnet).filter((subnet): subnet is string => Boolean(subnet)),
  );
  for (let third = 41; third < 60; third += 1) {
    const candidate = `10.213.${third}.0/28`;
    if (!used.some((subnet) => !subnet.includes(":") && cidrsOverlap(candidate, subnet))) return candidate;
  }
  throw new Error("no free test subnet");
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port")),
      );
    });
  });
}

async function waitForHealth(client: ProcessSimClient): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await client.health();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await sleep(100);
    }
  }
}

describeLoop("process simulation in a closed loop with a real OpenPLC runtime", () => {
  let db: PrismaClient;
  let docker: Docker;
  let runtime: RuntimeDeps;
  let service: ChildProcess;
  let client: ProcessSimClient;
  let deps: ProcessBridgeDeps;
  let factoryId: string;
  let plcId: string;
  let moduleId: string;

  const read = async (name: string) => (await readTag(runtime, alice, plcId, name)).value;
  const write = (name: string, value: number | boolean) => writeTag(runtime, alice, plcId, name, value);

  /** Polls a tag until it satisfies the condition; returns the last value either way. */
  async function until(name: string, condition: (value: number | boolean | null) => boolean, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    let value = await read(name);
    while (!condition(value) && Date.now() < deadline) {
      await sleep(100);
      value = await read(name);
    }
    return value;
  }
  const activeAlarms = async () =>
    (await listAlarms(db, alice, factoryId)).filter((alarm) => alarm.clearedAt === null).map((alarm) => alarm.code);
  const eventTypes = async () => (await listEvents(db, alice, factoryId, { limit: 500 })).map((event) => event.type);
  const moduleState = async () => {
    const state = await getProcessBridgeState(deps, alice, factoryId);
    if (!state.running) throw new Error("the bridge is not running");
    const found = state.modules.find((module) => module.moduleId === moduleId);
    if (!found) throw new Error("the module is not in the bridge");
    return found;
  };

  beforeAll(async () => {
    db = openTestDb();
    await resetDb(db);
    await ingestModuleTypes(db, loadModuleTypes());
    docker = createDockerClient(process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock");
    runtime = {
      db,
      docker,
      policy: {
        images: RUNTIME_IMAGES,
        portRange: { min: 15_700, max: 15_799 },
        bindAddresses: ["127.0.0.1"],
        limits: DEFAULT_LIMITS,
        labels: { [RUN_LABEL]: runId },
      },
      runtimeSecret: "integration-test-runtime-secret-0123456789",
    };

    const port = await freePort();
    service = spawn(binary ?? "", [], {
      env: { ...process.env, PROCESS_SIM_ADDR: `127.0.0.1:${port}`, PROCESS_SIM_TOKEN: TOKEN },
      stdio: ["ignore", "pipe", "pipe"],
    });
    service.stdout?.resume();
    service.stderr?.resume();
    client = createProcessSimClient({ url: `http://127.0.0.1:${port}`, token: TOKEN });
    await waitForHealth(client);
    deps = { db, bridge: new ProcessBridgeRuntime(), client, cycleMs: 100, tickMs: 50, snapshotIntervalMs: 2000 };

    const factory = await createFactory(db, alice, {
      name: "Pump House Loop",
      slug: "pump-house-loop",
      subnetCidr: await freeSubnet(docker),
    });
    factoryId = factory.id;
    const create = async (category: string, name: string) =>
      (
        await createDeviceInstance(db, {
          factoryId,
          deviceModelId: (
            await createGenericModel(
              db,
              category,
              `Generic ${category}`,
              category === "PLC" ? { architectureType: "COMPACT" } : {},
            )
          ).id,
          name,
        })
      ).id;
    plcId = await create("PLC", "PLC-01");
    const pumpId = await create("PUMP", "P-01");
    const transmitterId = await create("SENSOR", "PT-01");

    await createProgramVersion(db, alice, plcId, { sourceText: PROGRAM });
    const percent = { dataType: "INT16", scale: 0.01, unit: "%" };
    const tags = [
      // What a gateway or the UI may write.
      { name: "Start_Cmd", dataType: "BOOL", role: "COMMAND", logicalAddress: "%QX101.0" },
      { name: "Reset_Cmd", dataType: "BOOL", role: "COMMAND", logicalAddress: "%QX101.2" },
      { name: "Speed_SP", ...percent, role: "SETPOINT", logicalAddress: "%QW101" },
      // What the program drives into the process.
      { name: "PH_Run_Cmd", dataType: "BOOL", role: "STATUS", logicalAddress: "%QX100.0" },
      { name: "PH_Speed_SP", ...percent, role: "PROCESS_VALUE", logicalAddress: "%QW100" },
      // What the process returns to the program.
      { name: "PH_Running", dataType: "BOOL", role: "STATUS", logicalAddress: "%MX10.0" },
      { name: "PH_Low_Pressure", dataType: "BOOL", role: "ALARM", logicalAddress: "%MX10.1" },
      { name: "PH_Pressure", dataType: "FLOAT32", role: "PROCESS_VALUE", logicalAddress: "%MD10", unit: "bar" },
      // What the program concludes.
      { name: "High_Pressure_Trip", dataType: "BOOL", role: "ALARM", logicalAddress: "%QX101.1" },
    ];
    for (const tag of tags) await createTag(db, alice, plcId, tag);
    const tagIds = new Map(
      (await db.tag.findMany({ where: { plcInstanceId: plcId }, select: { id: true, name: true } })).map((tag) => [
        tag.name,
        tag.id,
      ]),
    );

    const types = await listModuleTypes(db);
    const typeId = types.find((type) => type.code === "PUMP_HOUSE")?.id ?? "";
    moduleId = (
      await createModule(db, alice, { factoryId, typeId, name: "PH-01", config: { ratedFlow: 60, ratedPressure: 6 } })
    ).id;
    await assignModuleDevice(db, alice, moduleId, { roleKey: "DUTY_PUMP", deviceId: pumpId });
    await assignModuleDevice(db, alice, moduleId, { roleKey: "DISCHARGE_PRESSURE", deviceId: transmitterId });
    // The module's signals are bound through the registry (TASK-605); the bridge reads the stored bindings.
    for (const [signalKey, tag] of [
      ["DUTY_RUN_CMD", "PH_Run_Cmd"],
      ["DUTY_SPEED_SETPOINT", "PH_Speed_SP"],
      ["DUTY_RUNNING", "PH_Running"],
      ["DISCHARGE_PRESSURE", "PH_Pressure"],
      ["LOW_PRESSURE", "PH_Low_Pressure"],
    ] as const) {
      await bindModuleSignal(db, alice, moduleId, { signalKey, tagId: tagIds.get(tag) ?? "" });
    }
    expect((await getModuleIoRegistry(db, alice, moduleId)).readyToRun).toBe(true);
  }, 120_000);

  afterAll(async () => {
    await deps?.bridge.stopAll();
    if (service && service.exitCode === null) {
      await new Promise<void>((resolve) => {
        service.once("exit", () => resolve());
        service.kill("SIGTERM");
      });
    }
    const filters = { label: [`${RUN_LABEL}=${runId}`] };
    for (const container of await docker.listContainers({ all: true, filters })) {
      await docker.getContainer(container.Id).remove({ force: true, v: true });
    }
    for (const network of await docker.listNetworks({ filters })) {
      await docker.getNetwork(network.Id).remove();
    }
    await db.$disconnect();
  }, 120_000);

  it("starts once the PLC has an endpoint, loads the model and reaches the PLC", async () => {
    const before = await startProcessBridge(deps, alice, factoryId).then(
      () => undefined,
      (error: unknown) => error as DomainError,
    );
    expect(before?.details.rule).toBe("plc-endpoint-required");

    expect(await startPlc(runtime, alice, plcId)).toEqual({ state: "RUNNING" });
    const started = await startProcessBridge(deps, alice, factoryId);
    expect(started).toMatchObject({ running: true, skipped: [] });
    expect((await client.list()).map((instance) => [instance.instanceId, instance.clock, instance.status])).toEqual([
      [moduleId, "manual", "RUNNING"],
    ]);
    expect(
      (await db.processModuleInstance.findUniqueOrThrow({ where: { id: moduleId }, select: { status: true } })).status,
    ).toBe("RUNNING");

    await sleep(600);
    const state = await moduleState();
    expect(state).toMatchObject({ status: "RUNNING", quality: "GOOD", plcs: [{ plcId, up: true }], error: null });
    expect(state.tick).toBeGreaterThan(4);
    expect(await eventTypes()).toEqual(expect.arrayContaining(["PROCESS_BRIDGE_STARTED", "CONNECTION_UP"]));
    expect(await db.runtimeEvent.count({ where: { factoryId, deviceId: plcId, type: "CONNECTION_UP" } })).toBe(1);
    // Nothing commanded: the pump stands still and the program sees that.
    expect(await read("PH_Running")).toBe(false);
    expect(await read("PH_Pressure")).toBe(0);
  }, 400_000);

  it("runs the pump when the program decides to; the process value is readable at the PLC as a mapped tag", async () => {
    await write("Speed_SP", 70);
    await write("Start_Cmd", true);

    expect(await until("PH_Running", (value) => value === true)).toBe(true);
    // The ramp takes 5 s: the pressure is on its way before it is there.
    const rising = await until("PH_Pressure", (value) => Number(value) > 0.2);
    expect(Number(rising)).toBeLessThan(2.9);
    // 6 bar at full speed, pressure ∝ speed²: 2.94 bar at 70 %, as a REAL in %MD10.
    const pressure = await until("PH_Pressure", (value) => Math.abs(Number(value) - 2.94) < 0.02);
    expect(Number(pressure)).toBeCloseTo(2.94, 1);
    expect(await read("PH_Low_Pressure")).toBe(false);
    expect(await read("High_Pressure_Trip")).toBe(false);
    expect(await moduleState()).toMatchObject({
      quality: "GOOD",
      inputs: { DUTY_RUN_CMD: 1, DUTY_SPEED_SETPOINT: 70 },
      outputs: { DUTY_RUNNING: 1, DUTY_SPEED: 70 },
      alarms: [],
    });
    expect(await eventTypes()).toContain("PROCESS_STATE_CHANGED");
  }, 60_000);

  it("delivers the model's alarm to the PLC and records it; the alarm clears when the cause goes", async () => {
    // At 50 % the pressure settles at 1.5 bar, under the 1.8 bar low limit of a 6 bar pump.
    await write("Speed_SP", 50);
    expect(await until("PH_Low_Pressure", (value) => value === true)).toBe(true);
    // The alarm is raised on the way down, as soon as the pump is at its setpoint and still short.
    expect(Number(await read("PH_Pressure"))).toBeLessThan(1.8);
    expect(await until("PH_Pressure", (value) => Math.abs(Number(value) - 1.5) < 0.02)).toBeCloseTo(1.5, 1);
    expect(await read("PH_Low_Pressure")).toBe(true);
    expect(await moduleState()).toMatchObject({ alarms: ["LOW_PRESSURE"] });
    expect(await activeAlarms()).toEqual([`${PROCESS_ALARM_PREFIX}PH-01/LOW_PRESSURE`]);
    expect(await eventTypes()).toEqual(expect.arrayContaining(["PROCESS_ALARM_RAISED", "ALARM_RAISED"]));

    await write("Speed_SP", 70);
    expect(await until("PH_Low_Pressure", (value) => value === false)).toBe(false);
    // The bridge writes the PLC before it records the cycle's events: the clearing follows within the cycle.
    const deadline = Date.now() + 5000;
    while ((await activeAlarms()).length > 0 && Date.now() < deadline) await sleep(100);
    expect(await activeAlarms()).toEqual([]);
    expect(await eventTypes()).toEqual(expect.arrayContaining(["PROCESS_ALARM_CLEARED", "ALARM_CLEARED"]));
  }, 60_000);

  it("leaves control to PLC logic: the interlock trips on the process value and the pump stops", async () => {
    // 80 % gives 3.84 bar: above the program's 3 bar trip.
    await write("Speed_SP", 80);
    expect(await until("High_Pressure_Trip", (value) => value === true)).toBe(true);
    expect(await until("PH_Running", (value) => value === false)).toBe(false);
    expect(await read("PH_Run_Cmd")).toBe(false);
    expect(await until("PH_Pressure", (value) => Number(value) === 0)).toBe(0);
    expect(await moduleState()).toMatchObject({ inputs: { DUTY_RUN_CMD: 0, DUTY_SPEED_SETPOINT: 0 } });

    // A gateway cannot write what the program or the process produce.
    for (const [name, value] of [
      ["PH_Run_Cmd", true],
      ["PH_Speed_SP", 50],
      ["PH_Running", true],
      ["PH_Pressure", 1],
    ] as const) {
      const error = await write(name, value).then(
        () => undefined,
        (reason: unknown) => reason as DomainError,
      );
      expect(error?.details.rule, name).toBe("tag-read-only");
    }

    await write("Speed_SP", 70);
    await write("Reset_Cmd", true);
    expect(await until("High_Pressure_Trip", (value) => value === false)).toBe(false);
    expect(await until("PH_Running", (value) => value === true)).toBe(true);
    await write("Reset_Cmd", false);
  }, 60_000);

  it("lets a test override what the PLC reads, and the PLC program decides on it (TASK-801)", async () => {
    expect(await until("PH_Running", (value) => value === true)).toBe(true);
    const refusals = async (signal: string, input: unknown) =>
      (
        await setProcessOverride(deps, alice, moduleId, signal, input).then(
          () => undefined,
          (error: unknown) => error as DomainError,
        )
      )?.details;
    // A command the PLC gives is never overridden; a value outside the range is refused.
    expect(await refusals("DUTY_RUN_CMD", { mode: "MANUAL_OVERRIDE", value: 0 })).toMatchObject({
      rule: "process-override-signal",
    });
    expect(await refusals("DISCHARGE_PRESSURE", { mode: "MANUAL_OVERRIDE", value: 99 })).toMatchObject({
      rule: "process-sim-configuration",
    });

    // 3.5 bar is above the program's 3 bar trip; the pump itself runs at 70 % (2.94 bar).
    const set = await setProcessOverride(deps, alice, moduleId, "DISCHARGE_PRESSURE", {
      mode: "MANUAL_OVERRIDE",
      value: 3.5,
    });
    expect(set).toMatchObject({ mode: "MANUAL_OVERRIDE", effective: 3.5, source: "alice" });
    expect(Number(await until("PH_Pressure", (value) => Number(value) === 3.5))).toBe(3.5);
    // The PLC program, not the test, trips the pump.
    expect(await until("High_Pressure_Trip", (value) => value === true)).toBe(true);
    expect(await until("PH_Run_Cmd", (value) => value === false)).toBe(false);
    expect(await until("PH_Running", (value) => value === false)).toBe(false);
    const overrides = await listProcessOverrides(deps, alice, moduleId);
    expect(overrides.find((entry) => entry.signal === "DISCHARGE_PRESSURE")).toMatchObject({
      mode: "MANUAL_OVERRIDE",
      effective: 3.5,
      calculated: 0,
    });

    // Back to AUTO: the calculated value returns, the trip stays until the program is reset.
    expect(await clearProcessOverride(deps, alice, moduleId, "DISCHARGE_PRESSURE")).toMatchObject({ mode: "AUTO" });
    expect(Number(await until("PH_Pressure", (value) => Number(value) === 0))).toBe(0);
    expect(await read("High_Pressure_Trip")).toBe(true);
    await write("Reset_Cmd", true);
    expect(await until("High_Pressure_Trip", (value) => value === false)).toBe(false);
    await write("Reset_Cmd", false);
    expect(await until("PH_Running", (value) => value === true)).toBe(true);
    const types = await eventTypes();
    expect(types).toEqual(expect.arrayContaining(["PROCESS_OVERRIDE_SET", "PROCESS_OVERRIDE_CLEARED"]));
  }, 90_000);

  it("runs a closed-loop scenario on a process override twice with the same outcome (TASK-804)", async () => {
    const scenarioDeps: ScenarioDeps = {
      runtime,
      simulation: { db, simulator: new DeviceSimulatorRuntime() },
      process: deps,
    };
    const plc = "PLC-01";
    const expectTag = (tag: string, value: number | boolean, extra: Record<string, number> = {}) => ({
      kind: "EXPECT",
      plc,
      tag,
      op: "EQ",
      value,
      withinS: 10,
      ...extra,
    });
    // Nothing writes the trip or the run command: the program decides on the overridden value.
    const scenario = {
      name: "High discharge pressure",
      steps: [
        expectTag("PH_Running", true),
        expectTag("High_Pressure_Trip", false, { holdS: 0.5 }),
        { kind: "OVERRIDE", module: "PH-01", signal: "DISCHARGE_PRESSURE", value: 3.5 },
        expectTag("PH_Pressure", 3.5, { tolerance: 0.01, withinS: 5 }),
        expectTag("High_Pressure_Trip", true, { withinS: 5 }),
        expectTag("PH_Run_Cmd", false, { withinS: 5 }),
        // The model answers the withdrawn command: the duty pump stops.
        expectTag("PH_Running", false),
        { kind: "OVERRIDE", module: "PH-01", signal: "DISCHARGE_PRESSURE", value: 3.8 },
        expectTag("PH_Pressure", 3.8, { tolerance: 0.01, withinS: 5 }),
        { kind: "CLEAR" },
        // Back in AUTO the model's own value returns; the trip stays until the program is reset.
        expectTag("PH_Pressure", 0, { tolerance: 0.01 }),
        expectTag("High_Pressure_Trip", true, { holdS: 0.5 }),
        { kind: "WRITE", plc, tag: "Reset_Cmd", value: true },
        expectTag("High_Pressure_Trip", false, { withinS: 5 }),
        { kind: "WRITE", plc, tag: "Reset_Cmd", value: false },
        expectTag("PH_Running", true),
        { kind: "EXPECT", plc, tag: "PH_Pressure", op: "GT", value: 2.5, withinS: 15 },
      ],
    };

    const first = await runScenario(scenarioDeps, alice, factoryId, scenario);
    expect(first.failure).toBeNull();
    const second = await runScenario(scenarioDeps, alice, factoryId, scenario);
    // Repeatable: the same steps pass and read the same values; only the timing differs.
    for (const report of [first, second]) {
      expect(report.status).toBe("PASSED");
      expect(report.overrides.map(({ atS: _atS, ...entry }) => entry)).toEqual([
        { target: "PH-01 · DISCHARGE_PRESSURE", mode: "MANUAL_OVERRIDE", value: 3.5 },
        { target: "PH-01 · DISCHARGE_PRESSURE", mode: "MANUAL_OVERRIDE", value: 3.8 },
      ]);
    }
    const observed = (report: typeof first) =>
      report.steps.map((step) => [step.status, typeof step.observed === "boolean" ? step.observed : null]);
    expect(observed(second)).toEqual(observed(first));
    expect((await listProcessOverrides(deps, alice, moduleId)).every((entry) => entry.mode === "AUTO")).toBe(true);

    // The record says which values were overridden, by which run, and when they were back in AUTO.
    const events = await listEvents(db, alice, factoryId, { limit: 500 });
    const ofRun = (runId: string) =>
      events
        .filter((event) => event.payload.runId === runId)
        .map((event) => event.type)
        .reverse();
    expect(ofRun(second.runId)).toEqual([
      "SCENARIO_STARTED",
      "PROCESS_OVERRIDE_SET",
      "PROCESS_OVERRIDE_CHANGED",
      "PROCESS_OVERRIDE_CLEARED",
      "SCENARIO_COMPLETED",
    ]);
    const changed = events.find(
      (event) => event.type === "PROCESS_OVERRIDE_CHANGED" && event.payload.runId === second.runId,
    );
    expect(changed?.payload).toMatchObject({
      module: "PH-01",
      code: "DISCHARGE_PRESSURE",
      mode: "MANUAL_OVERRIDE",
      value: 3.8,
      from: { mode: "MANUAL_OVERRIDE", value: 3.5 },
      scenario: "High discharge pressure",
      by: "alice",
    });

    // A step the simulation refuses fails the run, is recorded as rejected, and leaves everything in AUTO.
    const refused = await runScenario(scenarioDeps, alice, factoryId, {
      name: "Override a command",
      steps: [
        { kind: "OVERRIDE", module: "PH-01", signal: "DISCHARGE_PRESSURE", value: 1 },
        { kind: "OVERRIDE", module: "PH-01", signal: "DUTY_RUN_CMD", value: 0 },
        expectTag("PH_Running", true),
      ],
    });
    expect(refused.status).toBe("FAILED");
    expect(refused.steps.map((step) => step.status)).toEqual(["PASSED", "FAILED", "SKIPPED"]);
    expect(refused.failure).toMatch(/Step 2 .*command the PLC gives/);
    const rejected = (await listEvents(db, alice, factoryId, { limit: 50 })).find(
      (event) => event.type === "PROCESS_OVERRIDE_REJECTED",
    );
    expect(rejected?.payload).toMatchObject({ code: "DUTY_RUN_CMD", rule: "process-override-signal" });
    expect((await listProcessOverrides(deps, alice, moduleId)).every((entry) => entry.mode === "AUTO")).toBe(true);
    expect(await until("PH_Running", (value) => value === true)).toBe(true);
  }, 240_000);

  it("marks the module DISCONNECTED while the PLC is away, then stops cleanly", async () => {
    await stopPlc(runtime, alice, plcId);
    const deadline = Date.now() + 10_000;
    while ((await moduleState()).quality !== "DISCONNECTED" && Date.now() < deadline) await sleep(100);
    expect(await moduleState()).toMatchObject({
      quality: "DISCONNECTED",
      plcs: [{ plcId, up: false }],
      // A PLC that does not answer drives nothing: the command counts as off.
      inputs: { DUTY_RUN_CMD: 0 },
    });
    expect(await eventTypes()).toEqual(expect.arrayContaining(["CONNECTION_DOWN", "PROCESS_QUALITY_CHANGED"]));

    await stopProcessBridge(deps, alice, factoryId);
    expect(await getProcessBridgeState(deps, alice, factoryId)).toEqual({ running: false });
    expect(await client.list()).toEqual([]);
    expect(
      (await db.processModuleInstance.findUniqueOrThrow({ where: { id: moduleId }, select: { status: true } })).status,
    ).toBe("STOPPED");
    expect(await activeAlarms()).toEqual([]);
    expect((await eventTypes())[0]).toBe("PROCESS_BRIDGE_STOPPED");
  }, 120_000);

  it("is started and stopped with the factory, from the stored bindings", async () => {
    const bus = new EventBus();
    const simulator = new DeviceSimulatorRuntime();
    const factory: FactoryRuntimeDeps = {
      runtime: { ...runtime, bus },
      simulation: { db, bus, simulator, tickMs: 50, snapshotIntervalMs: 2000 },
      live: {
        db,
        bus,
        simulator,
        monitor: new TagMonitorRuntime(),
        pollMs: 200,
        sampling: { minIntervalMs: 200, maxIntervalMs: 60_000, deadbandRatio: 0.01 },
      },
      gateway: { ...runtime, bus, endpoints: new GatewayEndpointRuntime() },
      process: deps,
    };
    try {
      const started = await startFactory(factory, alice, factoryId);
      // The pump and the transmitter are simulated as devices too (unwired); the module runs in the bridge.
      expect(started).toMatchObject({ plcs: [{ id: plcId, state: "RUNNING" }], processModules: 1, processNote: null });
      expect(deps.bridge.isRunning(factoryId)).toBe(true);
      // Starting again leaves the running bridge alone.
      expect((await startFactory(factory, alice, factoryId)).processModules).toBe(1);

      const stopped = await stopFactory(factory, alice, factoryId);
      expect(stopped).toMatchObject({ processModules: 0, processNote: null });
      expect(deps.bridge.isRunning(factoryId)).toBe(false);
      expect(await client.list()).toEqual([]);
    } finally {
      await factory.gateway.endpoints.stopAll();
      await factory.live.monitor.stopAll();
      await simulator.stopAll();
    }
  }, 400_000);
});
