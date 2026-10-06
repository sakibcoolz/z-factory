// @vitest-environment node
import { randomUUID } from "node:crypto";
import type Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDockerClient } from "@/lib/docker/client";
import { DEFAULT_LIMITS } from "@/lib/docker/policy";
import { RUNTIME_IMAGES } from "@/lib/docker/runtime-images";
import type { DomainError } from "@/lib/domain/errors";
import type { ScenarioReport } from "@/lib/domain/scenario";
import { EventBus } from "@/lib/events/bus";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { DeviceSimulatorRuntime } from "@/lib/runtimes/device-sim/runtime";
import { ProcessBridgeRuntime } from "@/lib/runtimes/process-bridge/runtime";
import { connectDevices } from "@/lib/services/connection-service";
import { createDeviceInstance } from "@/lib/services/device-service";
import { listEvents } from "@/lib/services/event-service";
import { createFactory } from "@/lib/services/factory-service";
import { createProgramVersion, type RuntimeDeps, startPlc } from "@/lib/services/plc-runtime-service";
import {
  clearAllOverrides,
  listActiveOverrides,
  runScenario,
  type ScenarioDeps,
} from "@/lib/services/scenario-service";
import { forceSimulatedValue, startFactorySimulation } from "@/lib/services/simulation-service";
import { createTag } from "@/lib/services/tag-service";
import { cidrsOverlap } from "@/lib/validation/network";
import { createGenericModel, openTestDb, resetDb } from "./harness";

/**
 * TASK-804: repeatable closed-loop scenarios against a real OpenPLC program and the device
 * simulator. A pump on a drive, a discharge pressure transmitter and a temperature
 * transmitter; the program runs the pump on request and stops it on high temperature or
 * high pressure, latched until a reset. The scenarios change only what an operator asks
 * for and what the simulated transmitters read; every alarm and every stop is the
 * program's. Needs TEST_DATABASE_URL and TEST_DOCKER=1.
 */
const enabled = process.env.TEST_DOCKER === "1" && Boolean(process.env.TEST_DATABASE_URL);
const describeRuntime = enabled ? describe : describe.skip;

const RUN_LABEL = "zfactory.test-run";
const runId = randomUUID();
const alice = { ownerId: "alice" };

const PROGRAM = `PROGRAM pump_station
  VAR
    Start_Cmd AT %QX101.0 : BOOL;
    High_Temp_Alarm AT %QX101.1 : BOOL;
    Reset_Cmd AT %QX101.2 : BOOL;
    High_Pressure_Trip AT %QX101.3 : BOOL;
    Stopped_On_Alarm AT %QX101.4 : BOOL;
    Speed_SP AT %QW101 : INT;
    VFD_Run AT %QX100.0 : BOOL;
    VFD_FrequencyRef AT %QW100 : INT;
    VFD_ActualFrequency AT %MW10 : INT;
    Pump_Running AT %MX10.0 : BOOL;
    Pressure AT %MD12 : REAL;
    Temperature AT %MD14 : REAL;
  END_VAR

  IF Temperature > 80.0 THEN
    High_Temp_Alarm := TRUE;
  END_IF;
  IF Reset_Cmd AND Temperature < 75.0 THEN
    High_Temp_Alarm := FALSE;
  END_IF;
  IF Pressure > 3.0 THEN
    High_Pressure_Trip := TRUE;
  END_IF;
  IF Reset_Cmd THEN
    High_Pressure_Trip := FALSE;
  END_IF;
  VFD_Run := Start_Cmd AND NOT High_Temp_Alarm AND NOT High_Pressure_Trip;
  IF NOT VFD_Run THEN
    VFD_FrequencyRef := 0;
  ELSIF Speed_SP > 450 THEN
    VFD_FrequencyRef := 450;
  ELSE
    VFD_FrequencyRef := Speed_SP;
  END_IF;
  Stopped_On_Alarm := (High_Temp_Alarm OR High_Pressure_Trip) AND NOT Pump_Running;
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#50ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : pump_station;
  END_RESOURCE
END_CONFIGURATION
`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function freeSubnet(docker: Docker): Promise<string> {
  const used = (await docker.listNetworks()).flatMap((network) =>
    (network.IPAM?.Config ?? []).map((config) => config.Subnet).filter((subnet): subnet is string => Boolean(subnet)),
  );
  for (let third = 21; third < 40; third += 1) {
    const candidate = `10.217.${third}.0/28`;
    if (!used.some((subnet) => !subnet.includes(":") && cidrsOverlap(candidate, subnet))) return candidate;
  }
  throw new Error("no free test subnet");
}

const PLC = "PLC-01";
const expectTag = (tag: string, op: string, value: number | boolean, extra: Record<string, number> = {}) => ({
  kind: "EXPECT",
  plc: PLC,
  tag,
  op,
  value,
  withinS: 10,
  ...extra,
});
const write = (tag: string, value: number | boolean) => ({ kind: "WRITE", plc: PLC, tag, value });

/** The pump runs, the temperature goes above the program's 80 °C limit, the program stops the pump. */
const HIGH_TEMPERATURE = {
  name: "High temperature stops the pump",
  description: "TT-01 forced to 92 °C; the program raises its alarm and stops the drive until reset below 75 °C.",
  steps: [
    write("Speed_SP", 40),
    write("Start_Cmd", true),
    expectTag("VFD_ActualFrequency", "EQ", 40, { withinS: 15 }),
    expectTag("Pump_Running", "EQ", true),
    // AUTO: the transmitter reads its process value, below the limit, and the alarm stays off.
    expectTag("Temperature", "EQ", 55, { tolerance: 0.01 }),
    expectTag("High_Temp_Alarm", "EQ", false, { holdS: 1 }),
    { kind: "FORCE", device: "TT-01", value: 92 },
    expectTag("Temperature", "EQ", 92, { tolerance: 0.01, withinS: 5 }),
    // The program raises the alarm and withdraws the run command; the drive ramps down and the pump stops.
    expectTag("High_Temp_Alarm", "EQ", true, { withinS: 5 }),
    expectTag("VFD_Run", "EQ", false, { withinS: 2 }),
    expectTag("VFD_FrequencyRef", "EQ", 0, { withinS: 2 }),
    expectTag("VFD_ActualFrequency", "EQ", 0, { withinS: 15 }),
    expectTag("Pump_Running", "EQ", false),
    // The program confirms the stop from the feedback.
    expectTag("Stopped_On_Alarm", "EQ", true, { withinS: 5 }),
    { kind: "CLEAR" },
    expectTag("Temperature", "EQ", 55, { tolerance: 0.01, withinS: 5 }),
    // Latched: back in AUTO the alarm holds until the program is reset.
    expectTag("High_Temp_Alarm", "EQ", true, { holdS: 1 }),
    write("Reset_Cmd", true),
    expectTag("High_Temp_Alarm", "EQ", false, { withinS: 5 }),
    write("Reset_Cmd", false),
    expectTag("VFD_ActualFrequency", "EQ", 40, { withinS: 15 }),
    expectTag("Pump_Running", "EQ", true),
    // Leave the plant as the scenario found it.
    write("Start_Cmd", false),
    expectTag("VFD_ActualFrequency", "EQ", 0, { withinS: 15 }),
  ],
};

/**
 * The operator asks for more speed than the program allows; the program limits it, the
 * drive and the pump follow, the pressure rises with the speed and the program trips.
 */
const PRESSURE_LOOP = {
  name: "Speed limit and high-pressure trip",
  steps: [
    write("Speed_SP", 30),
    write("Start_Cmd", true),
    expectTag("VFD_FrequencyRef", "EQ", 30, { withinS: 5 }),
    // 50 Hz in 2 s: the drive is still ramping when the reference is already there.
    expectTag("VFD_ActualFrequency", "LT", 30, { withinS: 2 }),
    expectTag("VFD_ActualFrequency", "EQ", 30, { withinS: 15 }),
    // 4 bar at 50 Hz, ∝ speed²: 1.44 bar at 30 Hz, below the 3 bar trip.
    expectTag("Pressure", "EQ", 1.44, { tolerance: 0.02, withinS: 10 }),
    write("Speed_SP", 50),
    // The program limits 50 Hz to 45 Hz: 3.24 bar, and it trips on its own pressure feedback.
    expectTag("VFD_FrequencyRef", "EQ", 45, { withinS: 5 }),
    expectTag("High_Pressure_Trip", "EQ", true, { withinS: 15 }),
    expectTag("VFD_Run", "EQ", false, { withinS: 2 }),
    expectTag("VFD_ActualFrequency", "EQ", 0, { withinS: 15 }),
    expectTag("Pump_Running", "EQ", false),
    expectTag("Stopped_On_Alarm", "EQ", true, { withinS: 5 }),
    write("Start_Cmd", false),
    write("Speed_SP", 30),
    write("Reset_Cmd", true),
    expectTag("High_Pressure_Trip", "EQ", false, { withinS: 5 }),
    write("Reset_Cmd", false),
    expectTag("Pressure", "LT", 0.05, { withinS: 10 }),
  ],
};

describeRuntime("closed-loop scenarios with a real OpenPLC runtime and the device simulator (TASK-804)", () => {
  let db: PrismaClient;
  let docker: Docker;
  let deps: ScenarioDeps;
  let factoryId: string;
  let plcId: string;
  const ids = { vfd: "", motor: "", pump: "", pressure: "", temperature: "" };

  const events = async () => listEvents(db, alice, factoryId, { limit: 500 });
  const ofRun = async (run: string) =>
    (await events())
      .filter((event) => event.payload.runId === run)
      .map((event) => event.type)
      .reverse();
  /** What a run did, without its timing: repeatable runs are equal here. */
  const outcome = (report: ScenarioReport) => ({
    status: report.status,
    steps: report.steps.map((step) => [
      step.label,
      step.status,
      typeof step.observed === "boolean" ? step.observed : null,
    ]),
    overrides: report.overrides.map(({ atS: _atS, ...entry }) => entry),
  });

  beforeAll(async () => {
    db = openTestDb();
    await resetDb(db);
    docker = createDockerClient(process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock");
    const bus = new EventBus();
    const runtime: RuntimeDeps = {
      db,
      docker,
      bus,
      policy: {
        images: RUNTIME_IMAGES,
        portRange: { min: 15_980, max: 15_999 },
        bindAddresses: ["127.0.0.1"],
        limits: DEFAULT_LIMITS,
        labels: { [RUN_LABEL]: runId },
      },
      runtimeSecret: "integration-test-runtime-secret-0123456789",
    };
    deps = {
      runtime,
      simulation: { db, bus, simulator: new DeviceSimulatorRuntime(), tickMs: 50, snapshotIntervalMs: 5000 },
      process: { db, bus, bridge: new ProcessBridgeRuntime(), client: null },
      pollMs: 50,
    };

    factoryId = (
      await createFactory(db, alice, {
        name: "Scenario Station",
        slug: "scenario-station",
        subnetCidr: await freeSubnet(docker),
      })
    ).id;
    const models = new Map<string, string>();
    const create = async (category: string, name: string) => {
      if (!models.has(category)) {
        const model = await createGenericModel(
          db,
          category,
          `Generic ${category}`,
          category === "PLC" ? { architectureType: "COMPACT" } : {},
        );
        models.set(category, model.id);
      }
      return (await createDeviceInstance(db, { factoryId, deviceModelId: models.get(category) ?? "", name })).id;
    };
    plcId = await create("PLC", PLC);
    ids.vfd = await create("VFD", "VFD-01");
    ids.motor = await create("MOTOR", "M-01");
    ids.pump = await create("PUMP", "P-01");
    ids.pressure = await create("SENSOR", "PT-01");
    ids.temperature = await create("SENSOR", "TT-01");
    const connect = (relationship: string, source: string, target: string) =>
      connectDevices(db, { factoryId, relationship, source: { deviceId: source }, target: { deviceId: target } });
    await connect("DRIVES", ids.vfd, ids.motor);
    await connect("MECHANICALLY_DRIVES", ids.motor, ids.pump);
    await connect("MEASURES", ids.pressure, ids.pump);
    await db.simulationProfile.createMany({
      data: [
        { deviceInstanceId: ids.vfd, kind: "STATE_MACHINE", parametersJson: { accelTimeS: 2, decelTimeS: 2 } },
        {
          deviceInstanceId: ids.motor,
          kind: "STATE_MACHINE",
          parametersJson: { timeConstantS: 0.2, coastTimeConstantS: 0.5 },
        },
        {
          deviceInstanceId: ids.pressure,
          kind: "STATE_MACHINE",
          parametersJson: { source: { kind: "MEASURED", signal: "pressure" }, rangeMin: 0, rangeMax: 10 },
        },
        {
          deviceInstanceId: ids.temperature,
          kind: "STATE_MACHINE",
          parametersJson: { source: { kind: "CONSTANT", value: 55 }, rangeMin: 0, rangeMax: 150 },
        },
      ],
    });

    await createProgramVersion(db, alice, plcId, { sourceText: PROGRAM });
    const hz = { dataType: "INT16", scale: 0.1, unit: "Hz" };
    const tags: Array<Record<string, unknown>> = [
      { name: "Start_Cmd", dataType: "BOOL", role: "COMMAND", logicalAddress: "%QX101.0" },
      { name: "Reset_Cmd", dataType: "BOOL", role: "COMMAND", logicalAddress: "%QX101.2" },
      { name: "Speed_SP", ...hz, role: "SETPOINT", logicalAddress: "%QW101" },
      { name: "High_Temp_Alarm", dataType: "BOOL", role: "ALARM", logicalAddress: "%QX101.1" },
      { name: "High_Pressure_Trip", dataType: "BOOL", role: "ALARM", logicalAddress: "%QX101.3" },
      { name: "Stopped_On_Alarm", dataType: "BOOL", role: "STATUS", logicalAddress: "%QX101.4" },
      { name: "VFD_Run", dataType: "BOOL", role: "STATUS", logicalAddress: "%QX100.0", device: ids.vfd, signal: "run" },
      {
        name: "VFD_FrequencyRef",
        ...hz,
        role: "STATUS",
        logicalAddress: "%QW100",
        device: ids.vfd,
        signal: "frequencySetpoint",
      },
      {
        name: "VFD_ActualFrequency",
        ...hz,
        role: "FEEDBACK",
        logicalAddress: "%MW10",
        device: ids.vfd,
        signal: "actualFrequency",
      },
      {
        name: "Pump_Running",
        dataType: "BOOL",
        role: "STATUS",
        logicalAddress: "%MX10.0",
        device: ids.pump,
        signal: "running",
      },
      {
        name: "Pressure",
        dataType: "FLOAT32",
        role: "PROCESS_VALUE",
        unit: "bar",
        logicalAddress: "%MD12",
        device: ids.pressure,
        signal: "value",
      },
      {
        name: "Temperature",
        dataType: "FLOAT32",
        role: "PROCESS_VALUE",
        unit: "°C",
        logicalAddress: "%MD14",
        device: ids.temperature,
        signal: "value",
      },
    ];
    for (const { device, signal, ...tag } of tags) {
      await createTag(db, alice, plcId, { ...tag, sourceDeviceInstanceId: device, sourceSignal: signal });
    }
  }, 120_000);

  afterAll(async () => {
    await deps.simulation.simulator.stopAll();
    const filters = { label: [`${RUN_LABEL}=${runId}`] };
    for (const container of await docker.listContainers({ all: true, filters })) {
      await docker.getContainer(container.Id).remove({ force: true, v: true });
    }
    for (const network of await docker.listNetworks({ filters })) {
      await docker.getNetwork(network.Id).remove();
    }
    await db.$disconnect();
  }, 120_000);

  it("refuses a scenario that would write what the program decides, and records the refusal", async () => {
    expect(await startPlc(deps.runtime, alice, plcId)).toEqual({ state: "RUNNING" });
    await startFactorySimulation(deps.simulation, alice, factoryId);

    const refusal = async (scenario: unknown) =>
      (
        await runScenario(deps, alice, factoryId, scenario).then(
          () => undefined,
          (error: unknown) => error as DomainError,
        )
      )?.message;
    // The alarm is the program's: a scenario expects it, it never sets it.
    expect(await refusal({ name: "Set the alarm", steps: [write("High_Temp_Alarm", true)] })).toMatch(
      /Step 1: High_Temp_Alarm is not a command or setpoint tag/,
    );
    expect(await refusal({ name: "Drive the pump", steps: [write("VFD_Run", true)] })).toMatch(/not a command/);
    expect(await refusal({ name: "Unknown", steps: [{ kind: "FORCE", device: "TT-99", value: 1 }] })).toMatch(
      /no device named TT-99/,
    );
    expect(await refusal({ name: "Bad", steps: [] })).toMatch(/steps/);
    const rejected = (await events()).filter((event) => event.type === "SCENARIO_REJECTED");
    expect(rejected).toHaveLength(4);
    expect(rejected.at(-1)?.payload).toMatchObject({ scenario: "Set the alarm", rule: "scenario-step", by: "alice" });
    // Nothing reached the PLC.
    expect(await db.deviceCommand.count()).toBe(0);
  }, 400_000);

  it("proves the high-temperature alarm: forced input → PLC alarm → drive stopped → feedback → PLC, twice alike", async () => {
    const first = await runScenario(deps, alice, factoryId, HIGH_TEMPERATURE);
    expect(first.failure).toBeNull();
    expect(first.status).toBe("PASSED");
    // The evidence names the value that was out of AUTO, and it is back in AUTO.
    expect(outcome(first).overrides).toEqual([{ target: "TT-01", mode: "FORCED", value: 92 }]);
    expect(await listActiveOverrides(deps, alice, factoryId)).toEqual([]);

    const second = await runScenario(deps, alice, factoryId, HIGH_TEMPERATURE);
    expect(outcome(second)).toEqual(outcome(first));
    expect(await ofRun(second.runId)).toEqual(["SCENARIO_STARTED", "SCENARIO_COMPLETED"]);
    const completed = (await events()).find(
      (event) => event.type === "SCENARIO_COMPLETED" && event.payload.runId === second.runId,
    );
    expect(completed?.payload).toMatchObject({
      scenario: HIGH_TEMPERATURE.name,
      status: "PASSED",
      passed: HIGH_TEMPERATURE.steps.length,
      steps: HIGH_TEMPERATURE.steps.length,
      overridden: ["TT-01"],
    });
    const types = (await events()).map((event) => event.type);
    expect(types.filter((type) => type === "SIMULATED_INPUT_FORCED")).toHaveLength(2);
    expect(types.filter((type) => type === "SIMULATED_INPUT_RELEASED")).toHaveLength(2);
    // The program raised its own alarm; the scenario wrote only commands and setpoints.
    const written = await db.deviceCommand.findMany({ include: { tag: true } });
    expect([...new Set(written.map((command) => command.tag?.name))].sort()).toEqual([
      "Reset_Cmd",
      "Speed_SP",
      "Start_Cmd",
    ]);
  }, 240_000);

  it("closes the VFD, motor and process loop: the program limits the speed and trips on its own feedback", async () => {
    const first = await runScenario(deps, alice, factoryId, PRESSURE_LOOP);
    expect(first.failure).toBeNull();
    const second = await runScenario(deps, alice, factoryId, PRESSURE_LOOP);
    expect(outcome(second)).toEqual(outcome(first));
    expect(first.overrides).toEqual([]);
    // Numbers read are the same from run to run where the plant has settled.
    const pressure = (report: ScenarioReport) => report.steps.find((step) => step.label.includes("Pressure = 1.44"));
    expect(Number(pressure(first)?.observed)).toBeCloseTo(1.44, 1);
    expect(Number(pressure(second)?.observed)).toBeCloseTo(Number(pressure(first)?.observed), 1);
  }, 240_000);

  it("fails a run whose expectation is not met, says why, and still returns every value to AUTO", async () => {
    const report = await runScenario(deps, alice, factoryId, {
      name: "Wrong threshold",
      steps: [
        { kind: "FORCE", device: "TT-01", value: 78 },
        // 78 °C is below the program's 80 °C limit: the alarm stays off, the expectation fails.
        expectTag("High_Temp_Alarm", "EQ", true, { withinS: 2 }),
        { kind: "WAIT", seconds: 1 },
      ],
    });
    expect(report.status).toBe("FAILED");
    expect(report.steps.map((step) => step.status)).toEqual(["PASSED", "FAILED", "SKIPPED"]);
    expect(report.steps[1]).toMatchObject({ observed: false });
    expect(report.failure).toMatch(/Step 2 .*High_Temp_Alarm was false: not within 2 s/);
    expect(await listActiveOverrides(deps, alice, factoryId)).toEqual([]);
    expect(await ofRun(report.runId)).toEqual(["SCENARIO_STARTED", "SCENARIO_FAILED"]);
  }, 60_000);

  it("starts only from AUTO, and clears every override on request", async () => {
    await forceSimulatedValue(deps.simulation, alice, ids.temperature, 60);
    expect(await listActiveOverrides(deps, alice, factoryId)).toEqual([
      { kind: "FORCED", target: "TT-01", mode: "FORCED", value: 60 },
    ]);
    const refused = await runScenario(deps, alice, factoryId, HIGH_TEMPERATURE).then(
      () => undefined,
      (error: unknown) => error as DomainError,
    );
    expect(refused?.details.rule).toBe("scenario-overrides-active");
    expect(refused?.message).toMatch(/TT-01 is still overridden/);

    expect(await clearAllOverrides(deps, alice, factoryId)).toBe(1);
    expect(await clearAllOverrides(deps, alice, factoryId)).toBe(0);
    expect(await listActiveOverrides(deps, alice, factoryId)).toEqual([]);
    await sleep(200);
    const state = deps.simulation.simulator.status(factoryId);
    expect(state?.devices.find((device) => device.deviceId === ids.temperature)?.outputs.value).toBe(55);
  }, 60_000);
});
