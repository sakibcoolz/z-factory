// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { DomainError, type DomainErrorCode } from "@/lib/domain/errors";
import type { RuntimeEventEnvelope } from "@/lib/domain/events";
import { EventBus } from "@/lib/events/bus";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { DeviceSimulatorRuntime } from "@/lib/runtimes/device-sim/runtime";
import { connectDevices } from "@/lib/services/connection-service";
import { createDeviceInstance } from "@/lib/services/device-service";
import { createFactory } from "@/lib/services/factory-service";
import {
  clearDeviceFault,
  forceSimulatedValue,
  getSimulationState,
  injectDeviceFault,
  planSimulation,
  resetSimulatedDevice,
  type SimulationDeps,
  startFactorySimulation,
  stopFactorySimulation,
} from "@/lib/services/simulation-service";
import { createTag, getModbusMap } from "@/lib/services/tag-service";
import { createGenericModel, describeDb, openTestDb, resetDb } from "./harness";
import { startTestPlc, type TestPlc } from "./modbus-server";

const alice = { ownerId: "alice" };
const bob = { ownerId: "bob" };

async function expectDomainError(action: Promise<unknown>, code: DomainErrorCode, rule?: string) {
  const error = await action.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe(code);
  if (rule) expect((error as DomainError).details.rule).toBe(rule);
}

/**
 * The simulation service against PostgreSQL, with an in-process Modbus server standing in
 * for the PLC. The loop with a real OpenPLC runtime is covered by simulation-runtime.test.ts.
 */
describeDb("device simulation service against PostgreSQL", () => {
  let db: PrismaClient;
  let plc: TestPlc;
  let deps: SimulationDeps;
  let published: RuntimeEventEnvelope[];
  let factoryId: string;
  let plcId: string;
  const ids = { vfd: "", motor: "", pump: "", sensor: "", relay: "" };

  const tag = (
    name: string,
    dataType: string,
    role: string,
    logicalAddress: string,
    device: keyof typeof ids,
    signal: string,
  ) =>
    createTag(db, alice, plcId, {
      name,
      dataType,
      role,
      logicalAddress,
      sourceDeviceInstanceId: ids[device],
      sourceSignal: signal,
      ...(dataType === "INT16" && signal !== "actualSpeed" ? { scale: 0.1 } : {}),
    });

  /** VFD-01 → M-01 → P-01 with PT-01 on the pump, wired to PLC-01. */
  async function wire() {
    await connectDevices(db, {
      factoryId,
      relationship: "DRIVES",
      source: { deviceId: ids.vfd },
      target: { deviceId: ids.motor },
    });
    await connectDevices(db, {
      factoryId,
      relationship: "MECHANICALLY_DRIVES",
      source: { deviceId: ids.motor },
      target: { deviceId: ids.pump },
    });
    await connectDevices(db, {
      factoryId,
      relationship: "MEASURES",
      source: { deviceId: ids.sensor },
      target: { deviceId: ids.pump },
    });
    await db.simulationProfile.create({
      data: {
        deviceInstanceId: ids.sensor,
        kind: "STATE_MACHINE",
        parametersJson: { source: { kind: "MEASURED", signal: "pressure" }, rangeMin: 0, rangeMax: 10 },
      },
    });
    await tag("VFD01_Run", "BOOL", "STATUS", "%QX0.0", "vfd", "run");
    await tag("VFD01_FrequencyRef", "INT16", "STATUS", "%QW0", "vfd", "frequencySetpoint");
    await tag("VFD01_ActualFrequency", "INT16", "FEEDBACK", "%MW0", "vfd", "actualFrequency");
    await tag("M01_Speed", "INT16", "FEEDBACK", "%MW1", "motor", "actualSpeed");
    await tag("PT01_Pressure", "FLOAT32", "PROCESS_VALUE", "%MD0", "sensor", "value");
    await tag("VFD01_Faulted", "BOOL", "ALARM", "%MX0.0", "vfd", "faulted");
  }

  const configureEndpoint = () =>
    db.runtimePort.create({
      data: { deviceInstanceId: plcId, protocol: "MODBUS_TCP", containerPort: 502, hostPort: plc.port },
    });

  const advance = async (seconds: number) => {
    for (let step = 0; step < Math.round(seconds * 10); step += 1) await deps.simulator.tick(factoryId, 100);
  };

  const pressure = () => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt16BE(plc.holding[2048] ?? 0, 0);
    buffer.writeUInt16BE(plc.holding[2049] ?? 0, 2);
    return buffer.readFloatBE(0);
  };

  beforeAll(async () => {
    db = openTestDb();
    plc = await startTestPlc();
  });

  beforeEach(async () => {
    await resetDb(db);
    plc.coils.fill(false);
    plc.holding.fill(0);
    published = [];
    const bus = new EventBus();
    bus.subscribe((event) => published.push(event));
    deps = { db, simulator: new DeviceSimulatorRuntime(), bus, snapshotIntervalMs: 2000 };

    const factory = await createFactory(db, alice, {
      name: "Pump House",
      slug: "pump-house",
      subnetCidr: "172.20.1.0/24",
    });
    factoryId = factory.id;
    const models = {
      plc: await createGenericModel(db, "PLC", "Generic compact PLC", { architectureType: "COMPACT" }),
      vfd: await createGenericModel(db, "VFD", "Generic VFD"),
      motor: await createGenericModel(db, "MOTOR", "Generic motor"),
      pump: await createGenericModel(db, "PUMP", "Generic pump"),
      sensor: await createGenericModel(db, "SENSOR", "Generic pressure transmitter"),
      relay: await createGenericModel(db, "RELAY", "Generic relay"),
    };
    const create = async (model: keyof typeof models, name: string) =>
      (await createDeviceInstance(db, { factoryId, deviceModelId: models[model].id, name })).id;
    plcId = await create("plc", "PLC-01");
    ids.vfd = await create("vfd", "VFD-01");
    ids.motor = await create("motor", "M-01");
    ids.pump = await create("pump", "P-01");
    ids.sensor = await create("sensor", "PT-01");
    ids.relay = await create("relay", "K-01");
  });

  afterEach(async () => {
    await deps.simulator.stopAll();
  });

  afterAll(async () => {
    await plc.close();
    await db.$disconnect();
  });

  it("wires device signals to tags only where PLC logic is the one driving them", async () => {
    const input = await tag("VFD01_Run", "BOOL", "STATUS", "%QX0.0", "vfd", "run");
    expect(input).toMatchObject({ sourceDeviceInstanceId: ids.vfd, sourceSignal: "run", accessMode: "READ_ONLY" });
    expect((await getModbusMap(db, alice, plcId)).rows[0]).toMatchObject({ sourceSignal: "run" });

    // A gateway-writable tag would let a gateway command the device past the PLC program.
    await expectDomainError(
      tag("VFD01_Ref", "INT16", "SETPOINT", "%QW0", "vfd", "frequencySetpoint"),
      "INCOMPATIBLE",
      "signal-plc-driven",
    );
    // The runtime cannot take simulated values on input addresses.
    await expectDomainError(
      tag("VFD01_Hz", "INT16", "FEEDBACK", "%IW0", "vfd", "actualFrequency"),
      "INCOMPATIBLE",
      "signal-address",
    );
    await expectDomainError(
      tag("VFD01_Hz", "INT16", "FEEDBACK", "%QW1", "vfd", "actualFrequency"),
      "INCOMPATIBLE",
      "signal-address",
    );
    await expectDomainError(
      tag("VFD01_Rev", "BOOL", "STATUS", "%IX0.0", "vfd", "reverse"),
      "INCOMPATIBLE",
      "signal-address",
    );
    await expectDomainError(
      tag("VFD01_Hz", "BOOL", "FEEDBACK", "%MX0.0", "vfd", "actualFrequency"),
      "INCOMPATIBLE",
      "signal-data-type",
    );
    await expectDomainError(
      tag("VFD01_Rev", "INT16", "STATUS", "%QW2", "vfd", "reverse"),
      "INCOMPATIBLE",
      "signal-data-type",
    );
    await expectDomainError(
      tag("VFD01_Torque", "INT16", "FEEDBACK", "%MW0", "vfd", "torque"),
      "VALIDATION",
      "device-signal",
    );
    await expectDomainError(
      tag("K01_State", "BOOL", "STATUS", "%MX0.0", "relay", "state"),
      "INCOMPATIBLE",
      "simulated-device",
    );
    await expectDomainError(tag("VFD01_Run2", "BOOL", "STATUS", "%QX0.1", "vfd", "run"), "CONFLICT", "signal-bound");
    await expectDomainError(
      createTag(db, alice, plcId, {
        name: "Loose",
        dataType: "BOOL",
        role: "STATUS",
        logicalAddress: "%QX1.0",
        sourceSignal: "run",
      }),
      "VALIDATION",
      "signal-device",
    );
  });

  it("plans the simulation from devices, connections, profiles and signal tags", async () => {
    await wire();
    await db.deviceFaultDefinition.create({
      data: {
        deviceModelId: (await db.deviceInstance.findUniqueOrThrow({ where: { id: ids.pump } })).deviceModelId,
        code: "DRY_RUN",
        name: "Dry run protection",
        severity: "CRITICAL",
        resetBehavior: "MANUAL",
      },
    });

    const plan = await planSimulation(db, alice, factoryId);
    const byName = Object.fromEntries(plan.devices.map((device) => [device.name, device]));
    expect(Object.keys(byName).sort()).toEqual(["M-01", "P-01", "PT-01", "VFD-01"]);
    expect(byName["M-01"]).toMatchObject({ type: "MOTOR", driveId: ids.vfd });
    expect(byName["P-01"]).toMatchObject({
      type: "PUMP",
      motorId: ids.motor,
      faults: { DRY_RUN: { severity: "CRITICAL", latching: true } },
    });
    expect(byName["PT-01"]).toMatchObject({
      type: "SENSOR",
      measuresId: ids.pump,
      params: { source: { kind: "MEASURED", signal: "pressure" } },
    });
    expect(plan.skipped).toMatchObject([{ name: "K-01" }]);
    expect(plan.bindings.map((binding) => [binding.tagName, binding.direction, binding.area, binding.address])).toEqual(
      [
        ["VFD01_Run", "IN", "COIL", 0],
        ["VFD01_Faulted", "OUT", "COIL", 8192],
        ["VFD01_FrequencyRef", "IN", "HOLDING_REGISTER", 0],
        ["VFD01_ActualFrequency", "OUT", "HOLDING_REGISTER", 1024],
        ["M01_Speed", "OUT", "HOLDING_REGISTER", 1025],
        ["PT01_Pressure", "OUT", "HOLDING_REGISTER", 2048],
      ],
    );
    expect([...plan.plcs.values()]).toEqual([{ name: "PLC-01", endpoint: null, runtimeStatus: "STOPPED" }]);

    await expectDomainError(planSimulation(db, bob, factoryId), "NOT_FOUND");
  });

  it("turns a signal-generator profile into the sensor's source, and prefers the instance's profile", async () => {
    const modelId = (await db.deviceInstance.findUniqueOrThrow({ where: { id: ids.sensor } })).deviceModelId;
    await db.simulationProfile.create({
      data: { deviceModelId: modelId, kind: "CONSTANT", parametersJson: { value: 3 } },
    });
    let plan = await planSimulation(db, alice, factoryId);
    expect(plan.devices.find((device) => device.name === "PT-01")?.params).toEqual({
      source: { kind: "CONSTANT", value: 3 },
    });

    await db.simulationProfile.create({
      data: { deviceInstanceId: ids.sensor, kind: "SINE", parametersJson: { min: 1, max: 5, periodS: 60 } },
    });
    plan = await planSimulation(db, alice, factoryId);
    expect(plan.devices.find((device) => device.name === "PT-01")?.params).toEqual({
      source: { kind: "SINE", min: 1, max: 5, periodS: 60 },
    });

    await db.simulationProfile.create({ data: { deviceInstanceId: ids.vfd, kind: "RAMP", parametersJson: {} } });
    await expectDomainError(planSimulation(db, alice, factoryId), "VALIDATION", "simulation-profile");
  });

  it("refuses to start without a PLC endpoint, with invalid parameters, twice, or for another owner", async () => {
    await wire();
    await expectDomainError(
      startFactorySimulation(deps, alice, factoryId, { autoTick: false }),
      "CONFLICT",
      "plc-endpoint-required",
    );
    expect(deps.simulator.isRunning(factoryId)).toBe(false);

    await configureEndpoint();
    await expectDomainError(startFactorySimulation(deps, bob, factoryId, { autoTick: false }), "NOT_FOUND");

    const profile = await db.simulationProfile.create({
      data: { deviceInstanceId: ids.vfd, kind: "STATE_MACHINE", parametersJson: { accelTimeS: -1 } },
    });
    await expectDomainError(
      startFactorySimulation(deps, alice, factoryId, { autoTick: false }),
      "VALIDATION",
      "simulation-params",
    );
    expect(deps.simulator.isRunning(factoryId)).toBe(false);
    await db.simulationProfile.delete({ where: { id: profile.id } });

    const started = await startFactorySimulation(deps, alice, factoryId, { autoTick: false });
    expect(started).toMatchObject({ running: true, skipped: [{ name: "K-01" }] });
    await expectDomainError(
      startFactorySimulation(deps, alice, factoryId, { autoTick: false }),
      "CONFLICT",
      "simulation-running",
    );
  });

  it("runs the loop through the PLC's Modbus endpoint and persists events, status and snapshots", async () => {
    await wire();
    await configureEndpoint();
    await startFactorySimulation(deps, alice, factoryId, { autoTick: false });

    const devices = await db.deviceInstance.findMany({ where: { factoryId }, orderBy: { name: "asc" } });
    expect(devices.map((device) => [device.name, device.runtimeStatus])).toEqual([
      ["K-01", "STOPPED"],
      ["M-01", "RUNNING"],
      ["P-01", "RUNNING"],
      ["PLC-01", "STOPPED"],
      ["PT-01", "RUNNING"],
      ["VFD-01", "RUNNING"],
    ]);

    // What PLC logic would do: run the drive at 40.0 Hz.
    plc.coils[0] = true;
    plc.holding[0] = 400;
    await advance(10);
    expect(plc.holding.slice(1024, 1026)).toEqual([400, 1160]);
    expect(pressure()).toBeCloseTo(4 * 0.8 * 0.8, 3);
    expect(plc.coils[8192]).toBe(false);

    // Live state comes from simulator memory.
    const state = await getSimulationState(deps, alice, factoryId);
    expect(state).toMatchObject({ running: true, ticks: 100, lastError: null });
    const live = state.running ? Object.fromEntries(state.devices.map((device) => [device.name, device])) : {};
    expect(live["VFD-01"]).toMatchObject({ state: "RUNNING", inputs: { run: true, frequencySetpoint: 40 } });
    expect(live["PT-01"]?.outputs.value).toBeCloseTo(2.56, 3);
    await expectDomainError(getSimulationState(deps, bob, factoryId), "NOT_FOUND");

    const events = await db.runtimeEvent.findMany({
      where: { factoryId, type: { not: "FACTORY_CREATED" } },
      orderBy: { occurredAt: "asc" },
    });
    const types = events.map((event) => event.type);
    expect(types[0]).toBe("SIMULATION_STARTED");
    expect(types).toEqual(
      expect.arrayContaining(["CONNECTION_UP", "VFD_STATE_CHANGED", "MOTOR_STATE_CHANGED", "PUMP_STATE_CHANGED"]),
    );
    // 100 ticks produced a handful of rows, not one per tick.
    expect(events.length).toBeLessThan(12);
    expect(events.find((event) => event.type === "CONNECTION_UP")?.deviceId).toBe(plcId);
    expect(published.map((event) => event.id).sort()).toEqual(events.map((event) => event.id).sort());

    // 10 s at a 2 s snapshot interval: one row per device, overwritten, not one per tick.
    const snapshots = await db.deviceRuntimeSnapshot.findMany();
    expect(snapshots).toHaveLength(4);
    const vfdSnapshot = snapshots.find((snapshot) => snapshot.deviceInstanceId === ids.vfd);
    expect(vfdSnapshot).toMatchObject({ status: "RUNNING", quality: "GOOD" });
    expect(vfdSnapshot?.valuesJson).toMatchObject({ state: "RUNNING", outputs: { actualFrequency: 40 } });

    await stopFactorySimulation(deps, alice, factoryId);
    expect(await getSimulationState(deps, alice, factoryId)).toEqual({ running: false });
    const stopped = await db.deviceInstance.findMany({ where: { factoryId, runtimeStatus: "RUNNING" } });
    expect(stopped).toEqual([]);
    expect((await db.runtimeEvent.findMany({ where: { factoryId, type: "SIMULATION_STOPPED" } })).length).toBe(1);
    await expectDomainError(stopFactorySimulation(deps, alice, factoryId), "CONFLICT", "simulation-not-running");
  });

  it("records fault injection, clearing and reset, and reflects a trip in the stored status", async () => {
    await wire();
    await configureEndpoint();
    await startFactorySimulation(deps, alice, factoryId, { autoTick: false });
    plc.coils[0] = true;
    plc.holding[0] = 500;
    await advance(8);

    const faulted = await injectDeviceFault(deps, alice, ids.vfd, "OVERCURRENT");
    expect(faulted).toMatchObject({ activeFaults: ["OVERCURRENT"], faulted: true });
    await advance(0.5);
    // The PLC sees the trip on its feedback tags.
    expect(plc.coils[8192]).toBe(true);
    expect(plc.holding[1024]).toBe(0);
    expect((await db.deviceInstance.findUniqueOrThrow({ where: { id: ids.vfd } })).runtimeStatus).toBe("FAULTED");

    await expectDomainError(resetSimulatedDevice(deps, alice, ids.vfd), "CONFLICT", "fault-active");
    await clearDeviceFault(deps, alice, ids.vfd, "OVERCURRENT");
    await advance(0.5);
    expect(plc.coils[8192]).toBe(true);
    expect(await resetSimulatedDevice(deps, alice, ids.vfd)).toMatchObject({ tripped: false });
    await advance(6);
    expect(plc.coils[8192]).toBe(false);
    expect(plc.holding[1024]).toBe(500);
    expect((await db.deviceInstance.findUniqueOrThrow({ where: { id: ids.vfd } })).runtimeStatus).toBe("RUNNING");

    const audit = await db.runtimeEvent.findMany({
      where: { deviceId: ids.vfd, type: { in: ["FAULT_INJECTED", "FAULT_CLEARED", "DEVICE_RESET"] } },
      orderBy: { occurredAt: "asc" },
    });
    expect(audit.map((event) => [event.type, event.severity])).toEqual([
      ["FAULT_INJECTED", "CRITICAL"],
      ["FAULT_CLEARED", "INFO"],
      ["DEVICE_RESET", "INFO"],
    ]);
    expect(audit[0]?.payloadJson).toMatchObject({ code: "OVERCURRENT", latching: true, source: "UI" });

    await expectDomainError(injectDeviceFault(deps, alice, ids.vfd, "DRY_RUN"), "VALIDATION", "supported-fault");
    await expectDomainError(injectDeviceFault(deps, alice, ids.vfd, "drop table"), "VALIDATION");
    await expectDomainError(injectDeviceFault(deps, bob, ids.vfd, "OVERCURRENT"), "NOT_FOUND");
    await expectDomainError(injectDeviceFault(deps, alice, ids.relay, "STUCK"), "INCOMPATIBLE", "simulated-device");
  });

  it("forces and releases a simulated sensor value, with an audit record", async () => {
    await wire();
    await configureEndpoint();
    await startFactorySimulation(deps, alice, factoryId, { autoTick: false });

    await forceSimulatedValue(deps, alice, ids.sensor, 7.25);
    await advance(0.2);
    expect(pressure()).toBeCloseTo(7.25, 5);
    await forceSimulatedValue(deps, alice, ids.sensor, null);
    await advance(0.2);
    expect(pressure()).toBe(0);

    await expectDomainError(forceSimulatedValue(deps, alice, ids.vfd, 5), "INCOMPATIBLE", "forcible-device");
    await expectDomainError(forceSimulatedValue(deps, alice, ids.sensor, "high"), "VALIDATION");
    const audit = await db.runtimeEvent.findMany({ where: { deviceId: ids.sensor }, orderBy: { occurredAt: "asc" } });
    expect(audit.map((event) => event.type)).toEqual(["SIMULATED_INPUT_FORCED", "SIMULATED_INPUT_RELEASED"]);
  });

  it("requires a running simulation for operator actions", async () => {
    await wire();
    await expectDomainError(
      injectDeviceFault(deps, alice, ids.vfd, "OVERCURRENT"),
      "CONFLICT",
      "simulation-not-running",
    );
  });
});
