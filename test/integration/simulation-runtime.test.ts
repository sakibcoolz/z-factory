// @vitest-environment node
import { randomUUID } from "node:crypto";
import type Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDockerClient } from "@/lib/docker/client";
import { DEFAULT_LIMITS } from "@/lib/docker/policy";
import { RUNTIME_IMAGES } from "@/lib/docker/runtime-images";
import { DomainError } from "@/lib/domain/errors";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { readModbus, writeModbus } from "@/lib/protocols/modbus/client";
import { DeviceSimulatorRuntime } from "@/lib/runtimes/device-sim/runtime";
import { GatewayEndpointRuntime } from "@/lib/runtimes/gateway-endpoint/runtime";
import { connectDevices } from "@/lib/services/connection-service";
import { createDeviceInstance } from "@/lib/services/device-service";
import { createFactory } from "@/lib/services/factory-service";
import { addGateway, connectGateway, getGatewayMap, mapAllGatewayTags } from "@/lib/services/gateway-service";
import { createProgramVersion, type RuntimeDeps, startPlc, stopPlc } from "@/lib/services/plc-runtime-service";
import {
  clearDeviceFault,
  getSimulationState,
  injectDeviceFault,
  type SimulationDeps,
  startFactorySimulation,
  stopFactorySimulation,
} from "@/lib/services/simulation-service";
import { createTag, readTag, writeTag } from "@/lib/services/tag-service";
import { cidrsOverlap } from "@/lib/validation/network";
import { createGenericModel, openTestDb, resetDb } from "./harness";

/**
 * The closed control loop, end to end: a Structured Text program on a real OpenPLC
 * runtime decides, the shared device simulator responds, and its feedback changes what
 * the program decides next. Needs TEST_DATABASE_URL and TEST_DOCKER=1.
 */
const enabled = process.env.TEST_DOCKER === "1" && Boolean(process.env.TEST_DATABASE_URL);
const describeRuntime = enabled ? describe : describe.skip;

const RUN_LABEL = "zfactory.test-run";
const runId = randomUUID();
const alice = { ownerId: "alice" };

/**
 * The gateway may ask (StartCommand, SpeedSetpoint, ResetCommand); the program decides what
 * the drive gets: it limits the speed, stops on a drive fault and trips on high pressure.
 */
const PROGRAM = `PROGRAM pump_station
  VAR
    StartCommand AT %QX0.0 : BOOL;
    VFD_Run AT %QX0.1 : BOOL;
    VFD_Reset AT %QX0.2 : BOOL;
    ResetCommand AT %QX0.3 : BOOL;
    HighPressureTrip AT %QX0.4 : BOOL;
    VFD_FrequencyRef AT %QW0 : INT;
    SpeedSetpoint AT %QW1 : INT;
    VFD_ActualFrequency AT %MW0 : INT;
    VFD_Faulted AT %MX0.0 : BOOL;
    Pump_Running AT %MX0.1 : BOOL;
    Pressure AT %MD0 : REAL;
  END_VAR

  IF Pressure > 3.0 THEN
    HighPressureTrip := TRUE;
  END_IF;
  IF ResetCommand THEN
    HighPressureTrip := FALSE;
  END_IF;
  VFD_Reset := ResetCommand;
  VFD_Run := StartCommand AND NOT VFD_Faulted AND NOT HighPressureTrip;
  IF NOT VFD_Run THEN
    VFD_FrequencyRef := 0;
  ELSIF SpeedSetpoint > 450 THEN
    VFD_FrequencyRef := 450;
  ELSE
    VFD_FrequencyRef := SpeedSetpoint;
  END_IF;
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
  for (let third = 1; third < 20; third += 1) {
    const candidate = `10.213.${third}.0/28`;
    if (!used.some((subnet) => !subnet.includes(":") && cidrsOverlap(candidate, subnet))) return candidate;
  }
  throw new Error("no free test subnet");
}

describeRuntime("device simulation in a closed loop with a real OpenPLC runtime", () => {
  let db: PrismaClient;
  let docker: Docker;
  let runtime: RuntimeDeps;
  let simulation: SimulationDeps;
  let factoryId: string;
  let plcId: string;
  const ids = { vfd: "", motor: "", pump: "", sensor: "" };

  const read = async (name: string) => (await readTag(runtime, alice, plcId, name)).value;

  /** Polls a tag until it satisfies the condition; returns the last value either way. */
  async function until(name: string, condition: (value: number | boolean | null) => boolean, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    let value = await read(name);
    while (!condition(value) && Date.now() < deadline) {
      await sleep(100);
      value = await read(name);
    }
    return value;
  }

  beforeAll(async () => {
    db = openTestDb();
    await resetDb(db);
    docker = createDockerClient(process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock");
    runtime = {
      db,
      docker,
      policy: {
        images: RUNTIME_IMAGES,
        portRange: { min: 15500, max: 15599 },
        bindAddresses: ["127.0.0.1"],
        limits: DEFAULT_LIMITS,
        labels: { [RUN_LABEL]: runId },
      },
      runtimeSecret: "integration-test-runtime-secret-0123456789",
    };
    simulation = { db, simulator: new DeviceSimulatorRuntime(), tickMs: 50, snapshotIntervalMs: 2000 };

    const factory = await createFactory(db, alice, {
      name: "Pump House",
      slug: "pump-house",
      subnetCidr: await freeSubnet(docker),
    });
    factoryId = factory.id;
    const model = (category: string, name: string) =>
      createGenericModel(db, category, name, category === "PLC" ? { architectureType: "COMPACT" } : {});
    const create = async (category: string, name: string) =>
      (
        await createDeviceInstance(db, {
          factoryId,
          deviceModelId: (await model(category, `Generic ${category}`)).id,
          name,
        })
      ).id;
    plcId = await create("PLC", "PLC-01");
    ids.vfd = await create("VFD", "VFD-01");
    ids.motor = await create("MOTOR", "M-01");
    ids.pump = await create("PUMP", "P-01");
    ids.sensor = await create("SENSOR", "PT-01");

    const connect = (relationship: string, source: string, target: string) =>
      connectDevices(db, { factoryId, relationship, source: { deviceId: source }, target: { deviceId: target } });
    await connect("DRIVES", ids.vfd, ids.motor);
    await connect("MECHANICALLY_DRIVES", ids.motor, ids.pump);
    await connect("MEASURES", ids.sensor, ids.pump);
    await db.simulationProfile.createMany({
      data: [
        { deviceInstanceId: ids.vfd, kind: "STATE_MACHINE", parametersJson: { accelTimeS: 2, decelTimeS: 2 } },
        {
          deviceInstanceId: ids.motor,
          kind: "STATE_MACHINE",
          parametersJson: { timeConstantS: 0.2, coastTimeConstantS: 0.5 },
        },
        {
          deviceInstanceId: ids.sensor,
          kind: "STATE_MACHINE",
          parametersJson: { source: { kind: "MEASURED", signal: "pressure" }, rangeMin: 0, rangeMax: 10 },
        },
      ],
    });

    await createProgramVersion(db, alice, plcId, { sourceText: PROGRAM });
    const hz = { dataType: "INT16", scale: 0.1, unit: "Hz" };
    const tags = [
      // What a gateway or the UI may write.
      { name: "Pump01_StartCommand", dataType: "BOOL", role: "COMMAND", logicalAddress: "%QX0.0" },
      { name: "Pump01_ResetCommand", dataType: "BOOL", role: "COMMAND", logicalAddress: "%QX0.3" },
      { name: "Pump01_SpeedSetpoint", ...hz, role: "SETPOINT", logicalAddress: "%QW1" },
      // What the program drives and the simulated devices consume.
      { name: "VFD01_Run", dataType: "BOOL", role: "STATUS", logicalAddress: "%QX0.1", device: ids.vfd, signal: "run" },
      {
        name: "VFD01_Reset",
        dataType: "BOOL",
        role: "STATUS",
        logicalAddress: "%QX0.2",
        device: ids.vfd,
        signal: "faultReset",
      },
      {
        name: "VFD01_FrequencyRef",
        ...hz,
        role: "STATUS",
        logicalAddress: "%QW0",
        device: ids.vfd,
        signal: "frequencySetpoint",
      },
      // What the simulated devices return to the program.
      {
        name: "VFD01_ActualFrequency",
        ...hz,
        role: "FEEDBACK",
        logicalAddress: "%MW0",
        device: ids.vfd,
        signal: "actualFrequency",
      },
      {
        name: "VFD01_Faulted",
        dataType: "BOOL",
        role: "ALARM",
        logicalAddress: "%MX0.0",
        device: ids.vfd,
        signal: "faulted",
      },
      {
        name: "P01_Running",
        dataType: "BOOL",
        role: "STATUS",
        logicalAddress: "%MX0.1",
        device: ids.pump,
        signal: "running",
      },
      {
        name: "PT01_Pressure",
        dataType: "FLOAT32",
        role: "PROCESS_VALUE",
        logicalAddress: "%MD0",
        unit: "bar",
        device: ids.sensor,
        signal: "value",
      },
      // What the program concludes from that feedback.
      { name: "Pump01_HighPressureTrip", dataType: "BOOL", role: "ALARM", logicalAddress: "%QX0.4" },
    ];
    for (const { device, signal, ...tag } of tags as Array<Record<string, unknown>>) {
      await createTag(db, alice, plcId, { ...tag, sourceDeviceInstanceId: device, sourceSignal: signal });
    }
  }, 120_000);

  afterAll(async () => {
    await simulation.simulator.stopAll();
    const filters = { label: [`${RUN_LABEL}=${runId}`] };
    for (const container of await docker.listContainers({ all: true, filters })) {
      await docker.getContainer(container.Id).remove({ force: true, v: true });
    }
    for (const network of await docker.listNetworks({ filters })) {
      await docker.getNetwork(network.Id).remove();
    }
    await db.$disconnect();
  }, 120_000);

  it("starts once the PLC has an endpoint and reaches the PLC", async () => {
    const before = await startFactorySimulation(simulation, alice, factoryId).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((before as DomainError).details.rule).toBe("plc-endpoint-required");

    expect(await startPlc(runtime, alice, plcId)).toEqual({ state: "RUNNING" });
    expect(await startFactorySimulation(simulation, alice, factoryId)).toMatchObject({ running: true, skipped: [] });

    await sleep(500);
    const state = await getSimulationState(simulation, alice, factoryId);
    expect(state).toMatchObject({ running: true, lastError: null });
    expect(state.running && state.ticks).toBeGreaterThan(3);
    expect(await db.runtimeEvent.count({ where: { factoryId, deviceId: plcId, type: "CONNECTION_UP" } })).toBe(1);
    // Nothing commanded: the drive stands still and the program sees that.
    expect(await read("VFD01_ActualFrequency")).toBe(0);
    expect(await read("P01_Running")).toBe(false);
  }, 400_000);

  it("runs the pump when the program decides to, with ramp, speed and pressure feedback", async () => {
    await writeTag(runtime, alice, plcId, "Pump01_SpeedSetpoint", 40);
    await writeTag(runtime, alice, plcId, "Pump01_StartCommand", true);

    // 50 Hz in 2 s: the drive is on its ramp shortly after the command, not at the setpoint.
    const ramping = await until("VFD01_ActualFrequency", (value) => Number(value) > 2);
    expect(Number(ramping)).toBeLessThan(40);

    expect(await until("VFD01_ActualFrequency", (value) => value === 40)).toBe(40);
    expect(await read("VFD01_Run")).toBe(true);
    expect(await read("VFD01_FrequencyRef")).toBe(40);
    expect(await until("P01_Running", (value) => value === true)).toBe(true);
    // 4 bar at 50 Hz, pressure ∝ speed²: 2.56 bar at 40 Hz.
    const pressure = await until("PT01_Pressure", (value) => Math.abs(Number(value) - 2.56) < 0.01);
    expect(Number(pressure)).toBeCloseTo(2.56, 1);
    expect(await read("Pump01_HighPressureTrip")).toBe(false);
  }, 60_000);

  it("leaves the devices to PLC logic: a gateway cannot write what the program drives", async () => {
    for (const name of ["VFD01_Run", "VFD01_FrequencyRef", "VFD01_ActualFrequency", "PT01_Pressure"]) {
      const error = await writeTag(
        runtime,
        alice,
        plcId,
        name,
        name.startsWith("VFD01_Run") ? false : 0,
        "GATEWAY",
      ).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect((error as DomainError).details.rule, name).toBe("tag-read-only");
    }
    await sleep(300);
    expect(await read("VFD01_ActualFrequency")).toBe(40);
  }, 60_000);

  it("lets an edge device behind a gateway endpoint command the pump through PLC logic and read the result", async () => {
    const endpoints = new GatewayEndpointRuntime();
    const deps = { ...runtime, endpoints };
    try {
      await createGenericModel(db, "GATEWAY", "Test gateway");
      const gateway = await addGateway(deps, alice, factoryId);
      const { connectionId } = await connectGateway(deps, alice, gateway.id, {
        plcId,
        host: "127.0.0.1",
        port: 15_590,
      });
      await mapAllGatewayTags(deps, alice, connectionId);
      // The edge device knows only what its register map says.
      const map = await getGatewayMap(deps, alice, connectionId);
      const edge = { host: map.endpoint.host, port: map.endpoint.port, unitId: map.endpoint.unitId };
      const register = (tag: string) => {
        const found = map.registers.find((entry) => entry.tag === tag);
        if (!found) throw new Error(`${tag} is not in the gateway map`);
        return found;
      };
      const readHz = async (tag: string) => {
        const { area, address, scale } = register(tag);
        return Number((await readModbus(edge, area, address, 1))[0]) * scale;
      };
      expect(register("Pump01_SpeedSetpoint").access).toBe("READ_WRITE");
      expect(register("VFD01_ActualFrequency").access).toBe("READ");
      expect(await readHz("VFD01_ActualFrequency")).toBe(40);

      // 25 Hz, written as the raw register value. The program passes it to the drive, the drive ramps.
      const setpoint = register("Pump01_SpeedSetpoint");
      await writeModbus(edge, "HOLDING_REGISTER", setpoint.address, Math.round(25 / setpoint.scale));
      expect(await until("VFD01_FrequencyRef", (value) => value === 25)).toBe(25);
      expect(await until("VFD01_ActualFrequency", (value) => value === 25)).toBe(25);
      expect(await readHz("VFD01_ActualFrequency")).toBe(25);
      const command = await db.deviceCommand.findFirstOrThrow({ where: { source: "GATEWAY" }, include: { tag: true } });
      expect(command).toMatchObject({ status: "ACCEPTED", requestedValueJson: 25, appliedAt: null });
      expect(command.tag?.name).toBe("Pump01_SpeedSetpoint");

      // What the program drives and what the devices answer cannot be written through the endpoint.
      for (const tag of ["VFD01_Run", "VFD01_FrequencyRef", "VFD01_ActualFrequency"]) {
        const { area, address } = register(tag);
        const refused = await writeModbus(
          edge,
          area === "COIL" ? "COIL" : "HOLDING_REGISTER",
          address,
          area === "COIL" ? false : 0,
        ).then(
          () => undefined,
          (reason: unknown) => reason,
        );
        expect((refused as DomainError).details.exceptionCode, tag).toBe(2);
      }
      await sleep(300);
      expect(await read("VFD01_Run")).toBe(true);
      expect(await read("VFD01_ActualFrequency")).toBe(25);

      // Back to where the next test expects the pump.
      await writeModbus(edge, "HOLDING_REGISTER", setpoint.address, Math.round(40 / setpoint.scale));
      expect(await until("VFD01_ActualFrequency", (value) => value === 40)).toBe(40);
    } finally {
      await endpoints.stopAll();
    }
  }, 60_000);

  it("lets the program react to a drive fault and reset the drive", async () => {
    await injectDeviceFault(simulation, alice, ids.vfd, "OVERCURRENT");
    // The drive reports the trip, and the program withdraws its run command.
    expect(await until("VFD01_Faulted", (value) => value === true)).toBe(true);
    expect(await until("VFD01_Run", (value) => value === false)).toBe(false);
    expect(await until("P01_Running", (value) => value === false)).toBe(false);
    expect(await read("VFD01_ActualFrequency")).toBe(0);

    // With the cause gone the drive stays tripped until the program resets it.
    await clearDeviceFault(simulation, alice, ids.vfd, "OVERCURRENT");
    await sleep(500);
    expect(await read("VFD01_Faulted")).toBe(true);

    await writeTag(runtime, alice, plcId, "Pump01_ResetCommand", true);
    expect(await until("VFD01_Faulted", (value) => value === false)).toBe(false);
    await writeTag(runtime, alice, plcId, "Pump01_ResetCommand", false);
    expect(await until("VFD01_ActualFrequency", (value) => value === 40)).toBe(40);

    const events = await db.runtimeEvent.findMany({
      where: { factoryId, deviceId: ids.vfd },
      orderBy: { occurredAt: "asc" },
    });
    const types = events.map((event) => event.type);
    expect(types).toContain("FAULT_INJECTED");
    expect(types).toContain("FAULT_CLEARED");
    expect(events.some((event) => (event.payloadJson as { to?: string }).to === "FAULTED")).toBe(true);
  }, 60_000);

  it("closes the loop: simulated pressure makes the program trip and stop the pump", async () => {
    // The program limits 50 Hz to 45 Hz; that is 3.24 bar, above its 3.0 bar trip.
    await writeTag(runtime, alice, plcId, "Pump01_SpeedSetpoint", 50);
    expect(await until("Pump01_HighPressureTrip", (value) => value === true)).toBe(true);
    expect(await until("VFD01_Run", (value) => value === false)).toBe(false);
    expect(await until("VFD01_ActualFrequency", (value) => value === 0)).toBe(0);
    expect(await until("PT01_Pressure", (value) => Number(value) < 0.05)).toBeLessThan(0.05);
    // The drive never went past the program's limit.
    const state = await getSimulationState(simulation, alice, factoryId);
    const vfd = state.running ? state.devices.find((device) => device.deviceId === ids.vfd) : undefined;
    expect(vfd).toMatchObject({ state: "STOPPED", inputs: { run: false, frequencySetpoint: 0 } });
  }, 60_000);

  it("de-energizes the devices when the PLC stops, and stores snapshots, not ticks", async () => {
    await writeTag(runtime, alice, plcId, "Pump01_SpeedSetpoint", 20);
    // Hold the reset until the program has seen it in a scan.
    await writeTag(runtime, alice, plcId, "Pump01_ResetCommand", true);
    expect(await until("Pump01_HighPressureTrip", (value) => value === false)).toBe(false);
    await writeTag(runtime, alice, plcId, "Pump01_ResetCommand", false);
    expect(await until("VFD01_ActualFrequency", (value) => value === 20)).toBe(20);

    await stopPlc(runtime, alice, plcId);
    const deadline = Date.now() + 15_000;
    const vfdState = async () => {
      const state = await getSimulationState(simulation, alice, factoryId);
      return state.running ? state.devices.find((device) => device.deviceId === ids.vfd) : undefined;
    };
    while ((await vfdState())?.state !== "STOPPED" && Date.now() < deadline) await sleep(100);
    expect(await vfdState()).toMatchObject({ state: "STOPPED", inputs: { run: false } });
    expect(await db.runtimeEvent.count({ where: { factoryId, deviceId: plcId, type: "CONNECTION_DOWN" } })).toBe(1);

    const ticks = (await getSimulationState(simulation, alice, factoryId)) as { ticks: number };
    await stopFactorySimulation(simulation, alice, factoryId);
    expect(await db.deviceRuntimeSnapshot.count()).toBe(4);
    // Hundreds of ticks, a few dozen stored events.
    expect(ticks.ticks).toBeGreaterThan(200);
    expect(await db.runtimeEvent.count({ where: { factoryId } })).toBeLessThan(80);
    expect(await db.telemetrySample.count()).toBe(0);
  }, 120_000);
});
