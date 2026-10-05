// @vitest-environment node
import { randomUUID } from "node:crypto";
import type Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCatalog } from "@/lib/catalog";
import { ingestCatalog } from "@/lib/catalog/ingest";
import { DEMO_TRIP_BAR } from "@/lib/demo/pump-station";
import { createDockerClient } from "@/lib/docker/client";
import { DEFAULT_LIMITS } from "@/lib/docker/policy";
import { RUNTIME_IMAGES } from "@/lib/docker/runtime-images";
import { DomainError } from "@/lib/domain/errors";
import type { GatewayMapDocument } from "@/lib/domain/gateway-view";
import { EventBus } from "@/lib/events/bus";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { readModbus, writeModbus } from "@/lib/protocols/modbus/client";
import { DeviceSimulatorRuntime } from "@/lib/runtimes/device-sim/runtime";
import { GatewayEndpointRuntime } from "@/lib/runtimes/gateway-endpoint/runtime";
import { TagMonitorRuntime } from "@/lib/runtimes/tag-monitor/monitor";
import { createDemoFactory, type DemoFactory } from "@/lib/services/demo-service";
import { listAlarms, listEvents } from "@/lib/services/event-service";
import { type FactoryRuntimeDeps, startFactory, stopFactory } from "@/lib/services/factory-runtime-service";
import { getGatewayMap } from "@/lib/services/gateway-service";
import { getDeviceStates, getLiveTags } from "@/lib/services/live-service";
import { buildPlcExport } from "@/lib/services/plc-export-service";
import { clearDeviceFault, injectDeviceFault } from "@/lib/services/simulation-service";
import { getTopology } from "@/lib/services/topology-service";
import { cidrsOverlap } from "@/lib/validation/network";
import { openTestDb, resetDb } from "./harness";

/**
 * The MVP demo, end to end (TASK-502, docs/demo-runbook.md): the pump station is built
 * from the catalog and started as a factory; an edge client behind the gateway endpoint
 * starts the pump and sets its speed; the program on a real OpenPLC runtime decides, the
 * simulated devices respond, and the client reads the result. Then the interlock trips,
 * a drive fault is injected, and what was recorded is checked.
 * Needs TEST_DATABASE_URL and TEST_DOCKER=1.
 */
const enabled = process.env.TEST_DOCKER === "1" && Boolean(process.env.TEST_DATABASE_URL);
const describeRuntime = enabled ? describe : describe.skip;

const RUN_LABEL = "zfactory.test-run";
const runId = randomUUID();
const alice = { ownerId: "alice" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function freeSubnet(docker: Docker): Promise<string> {
  const used = (await docker.listNetworks()).flatMap((network) =>
    (network.IPAM?.Config ?? []).map((config) => config.Subnet).filter((subnet): subnet is string => Boolean(subnet)),
  );
  for (let third = 21; third < 40; third += 1) {
    const candidate = `10.213.${third}.0/28`;
    if (!used.some((subnet) => !subnet.includes(":") && cidrsOverlap(candidate, subnet))) return candidate;
  }
  throw new Error("No free subnet for the test factory.");
}

describeRuntime("the MVP demo end to end with a real OpenPLC runtime", () => {
  let db: PrismaClient;
  let docker: Docker;
  let deps: FactoryRuntimeDeps;
  let demo: DemoFactory;
  let map: GatewayMapDocument;

  /** The edge device: it knows the endpoint and its register map, nothing else. */
  const register = (tag: string) => {
    const found = map.registers.find((entry) => entry.tag === tag);
    if (!found) throw new Error(`${tag} is not in the gateway map`);
    return found;
  };
  const edge = () => ({ host: map.endpoint.host, port: map.endpoint.port, unitId: map.endpoint.unitId });
  /** A value as the edge device reads it, in engineering units. */
  const read = async (tag: string): Promise<number | boolean> => {
    const { area, address, scale } = register(tag);
    const [raw] = await readModbus(edge(), area, address, 1);
    return typeof raw === "boolean" ? raw : Number((Number(raw) * scale).toFixed(2));
  };
  const write = async (tag: string, value: number | boolean) => {
    const { area, address, scale } = register(tag);
    if (typeof value === "boolean") await writeModbus(edge(), "COIL", address, value);
    else await writeModbus(edge(), area === "COIL" ? "COIL" : "HOLDING_REGISTER", address, Math.round(value / scale));
  };
  async function until(tag: string, condition: (value: number | boolean) => boolean, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    let value = await read(tag);
    while (!condition(value) && Date.now() < deadline) {
      await sleep(150);
      value = await read(tag);
    }
    return value;
  }
  const activeAlarms = async () =>
    (await listAlarms(db, alice, demo.factoryId))
      .filter((alarm) => alarm.clearedAt === null)
      .map((alarm) => alarm.code);
  const eventTypes = async () =>
    (await listEvents(db, alice, demo.factoryId, { limit: 500 })).map((event) => event.type);

  beforeAll(async () => {
    db = openTestDb();
    await resetDb(db);
    await ingestCatalog(db, loadCatalog());
    docker = createDockerClient(process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock");
    const bus = new EventBus();
    const simulator = new DeviceSimulatorRuntime();
    const runtime = {
      db,
      docker,
      bus,
      policy: {
        images: RUNTIME_IMAGES,
        portRange: { min: 15_600, max: 15_699 },
        bindAddresses: ["127.0.0.1"],
        limits: DEFAULT_LIMITS,
        labels: { [RUN_LABEL]: runId },
      },
      runtimeSecret: "integration-test-runtime-secret-0123456789",
    };
    deps = {
      runtime,
      simulation: { db, bus, simulator, tickMs: 50, snapshotIntervalMs: 2000 },
      live: {
        db,
        bus,
        simulator,
        monitor: new TagMonitorRuntime(),
        pollMs: 200,
        sampling: { minIntervalMs: 200, maxIntervalMs: 60_000, deadbandRatio: 0.01 },
      },
      gateway: { ...runtime, endpoints: new GatewayEndpointRuntime() },
    };
    demo = await createDemoFactory(deps.gateway, alice, { subnetCidr: await freeSubnet(docker) });
    map = await getGatewayMap(deps.gateway, alice, demo.gatewayConnectionId);
  }, 120_000);

  afterAll(async () => {
    await deps.gateway.endpoints.stopAll();
    await deps.simulation.simulator.stopAll();
    await deps.live.monitor.stopAll();
    const filters = { label: [`${RUN_LABEL}=${runId}`] };
    for (const container of await docker.listContainers({ all: true, filters })) {
      await docker.getContainer(container.Id).remove({ force: true, v: true });
    }
    for (const network of await docker.listNetworks({ filters })) {
      await docker.getNetwork(network.Id).remove();
    }
    await db.$disconnect();
  }, 120_000);

  it("starts the factory: the PLC runs its program in a container, then the field devices are simulated", async () => {
    // Before the start nothing answers for the PLC.
    const before = await read("Pump_Start").then(
      () => "answered",
      (error: DomainError) => error.details.exceptionCode,
    );
    expect(before).toBe(11);

    const started = await startFactory(deps, alice, demo.factoryId);
    expect(started).toEqual({
      plcs: [{ id: demo.plcId, name: "PLC-01", state: "RUNNING" }],
      simulatedDevices: 4,
      simulationNote: null,
    });
    const plc = await db.deviceInstance.findUniqueOrThrow({ where: { id: demo.plcId }, include: { plcProfile: true } });
    expect(plc.dockerContainerId).toMatch(/^[0-9a-f]{64}$/);
    expect(plc.plcProfile?.runtimeVersion).toContain("OpenPLC Runtime");
    expect((await docker.getContainer(plc.dockerContainerId ?? "").inspect()).State.Running).toBe(true);
    expect((await db.programVersion.findFirstOrThrow({ where: { plcInstanceId: demo.plcId } })).status).toBe(
      "DEPLOYED",
    );
    // The PLC was given a port of its own, not the gateway endpoint's.
    const modbusPort = await db.runtimePort.findFirstOrThrow({ where: { deviceInstanceId: demo.plcId } });
    expect(modbusPort.hostPort).not.toBe(map.endpoint.port);

    // Starting again changes nothing.
    expect((await startFactory(deps, alice, demo.factoryId)).plcs[0]?.state).toBe("RUNNING");
    expect(await read("Pump_Start")).toBe(false);
    expect(await read("VFD_01_FREQ")).toBe(0);
  }, 400_000);

  it("lets the gateway start the pump and set its speed, and read what the drive and the process do", async () => {
    await write("Pump_Speed_SP", 30);
    await write("Pump_Start", true);

    // Setpoint and actual value are different things: the drive is on its ramp first.
    const ramping = await until("VFD_01_FREQ", (value) => Number(value) > 2);
    expect(Number(ramping)).toBeLessThan(30);
    expect(await read("Pump_Speed_SP")).toBe(30);
    expect(await until("VFD_01_REF", (value) => value === 30)).toBe(30);
    expect(await until("VFD_01_FREQ", (value) => value === 30)).toBe(30);
    expect(await read("VFD_01_RUNNING")).toBe(true);
    // 4 bar at 50 Hz, pressure with the square of the speed: 1.44 bar at 30 Hz.
    expect(Number(await until("PT_101_OUT", (value) => Number(value) >= 1.4))).toBeCloseTo(1.4, 1);
    expect(await read("High_Pressure_Trip")).toBe(false);

    // The program limits what it passes on: 80 Hz is asked for, the drive gets none of it beyond its limit.
    const commands = await db.deviceCommand.findMany({ orderBy: { requestedAt: "asc" }, include: { tag: true } });
    expect(
      commands.map((command) => [command.tag?.name, command.source, command.status, command.requestedValueJson]),
    ).toEqual([
      ["Pump_Speed_SP", "GATEWAY", "ACCEPTED", 30],
      ["Pump_Start", "GATEWAY", "ACCEPTED", true],
    ]);
    // Accepted is not applied: what the pump did is in the feedback read above.
    expect(commands.every((command) => command.appliedAt === null)).toBe(true);
  }, 60_000);

  it("shows the same live state to the application: topology, tags and device states", async () => {
    const states = await getDeviceStates(deps.live, demo.factoryId);
    const stateOf = (deviceId: string) => states.find((state) => state.deviceId === deviceId)?.status;
    expect(stateOf(demo.deviceIds.vfd)).toBe("RUNNING");
    expect(stateOf(demo.deviceIds.motor)).toBe("RUNNING");
    expect(stateOf(demo.deviceIds.pump)).toBe("RUNNING");

    const liveTag = async (name: string) =>
      (await getLiveTags(deps.live, alice, demo.factoryId)).tags.find((tag) => tag.name === name);
    await expect.poll(async () => (await liveTag("VFD_01_FREQ"))?.reading.value, { timeout: 10_000 }).toBe(30);
    expect(await liveTag("Pump_Speed_SP")).toMatchObject({
      role: "SETPOINT",
      writable: true,
      reading: { value: 30, quality: "GOOD" },
    });
    expect(await liveTag("VFD_01_FREQ")).toMatchObject({
      role: "FEEDBACK",
      writable: false,
      deviceName: "VFD-01",
      reading: { quality: "GOOD" },
    });

    const topology = await getTopology(db, alice, demo.factoryId);
    const stored = (name: string) => topology.nodes.find((node) => node.name === name)?.runtimeStatus;
    expect([stored("PLC-01"), stored("VFD-01"), stored("MOTOR-01"), stored("PUMP-01")]).toEqual([
      "RUNNING",
      "RUNNING",
      "RUNNING",
      "RUNNING",
    ]);
  }, 60_000);

  it("keeps devices to PLC logic: the gateway cannot write what the program or the field produces", async () => {
    for (const tag of ["VFD_01_RUN", "VFD_01_REF", "VFD_01_FREQ", "PT_101_OUT", "High_Pressure_Trip"]) {
      const { area, address } = register(tag);
      const refused = await writeModbus(
        edge(),
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
    expect(await read("VFD_01_FREQ")).toBe(30);
  }, 60_000);

  it("trips on high pressure whatever the gateway asks for, raises an alarm, and runs again after a reset", async () => {
    // 48 Hz would give 3.7 bar; the interlock is at 3 bar.
    await write("Pump_Speed_SP", 48);
    expect(await until("High_Pressure_Trip", (value) => value === true)).toBe(true);
    expect(await until("VFD_01_RUN", (value) => value === false)).toBe(false);
    expect(await until("VFD_01_FREQ", (value) => value === 0)).toBe(0);
    // The request is still there; the result is not what was asked for.
    expect(await read("Pump_Speed_SP")).toBe(48);
    expect(await read("Pump_Start")).toBe(true);
    await expect.poll(activeAlarms, { timeout: 10_000 }).toContain("TAG:High_Pressure_Trip");
    expect(DEMO_TRIP_BAR).toBe(3);

    // A lower setpoint alone does not restart a tripped pump; the reset does.
    await write("Pump_Speed_SP", 30);
    await sleep(500);
    expect(await read("VFD_01_RUN")).toBe(false);
    await until("PT_101_OUT", (value) => Number(value) < 0.3);
    await write("Pump_Reset", true);
    expect(await until("High_Pressure_Trip", (value) => value === false)).toBe(false);
    await write("Pump_Reset", false);
    expect(await until("VFD_01_FREQ", (value) => value === 30)).toBe(30);
    await expect.poll(activeAlarms, { timeout: 10_000 }).not.toContain("TAG:High_Pressure_Trip");
  }, 90_000);

  it("stops the pump on a drive fault and lets it run again once the fault is gone and reset", async () => {
    await injectDeviceFault(deps.simulation, alice, demo.deviceIds.vfd, "OVERCURRENT");
    expect(await until("VFD_01_FAULT", (value) => value === true)).toBe(true);
    expect(await until("VFD_01_RUN", (value) => value === false)).toBe(false);
    expect(await until("VFD_01_FREQ", (value) => value === 0)).toBe(0);
    await expect.poll(activeAlarms, { timeout: 10_000 }).toContain("FAULT:OVERCURRENT");

    await clearDeviceFault(deps.simulation, alice, demo.deviceIds.vfd, "OVERCURRENT");
    // A latching fault stays until the drive is reset; the program passes the reset on.
    await sleep(400);
    expect(await read("VFD_01_FAULT")).toBe(true);
    await write("Pump_Reset", true);
    expect(await until("VFD_01_FAULT", (value) => value === false)).toBe(false);
    await write("Pump_Reset", false);
    expect(await until("VFD_01_FREQ", (value) => value === 30)).toBe(30);
    await expect.poll(activeAlarms, { timeout: 10_000 }).toEqual([]);
  }, 90_000);

  it("has recorded commands, faults and alarms, and sampled telemetry instead of every scan", async () => {
    const types = await eventTypes();
    for (const type of [
      "DEVICE_STARTING",
      "PLC_PROGRAM_DEPLOYED",
      "SIMULATION_STARTED",
      "GATEWAY_COMMAND_RECEIVED",
      "COMMAND_ACCEPTED",
      "COMMAND_REJECTED",
      "VFD_STATE_CHANGED",
      "FAULT_INJECTED",
      "FAULT_CLEARED",
      "ALARM_RAISED",
      "ALARM_CLEARED",
    ]) {
      expect(types, type).toContain(type);
    }
    const alarms = await listAlarms(db, alice, demo.factoryId);
    expect(alarms.map((alarm) => alarm.code).sort()).toEqual(["FAULT:OVERCURRENT", "TAG:High_Pressure_Trip"]);
    expect(alarms.every((alarm) => alarm.clearedAt !== null)).toBe(true);

    // Telemetry is sampled on change, not written per scan: minutes of 50 ms scans, some hundred rows.
    const samples = await db.telemetrySample.count({ where: { factoryId: demo.factoryId } });
    expect(samples).toBeGreaterThan(10);
    expect(samples).toBeLessThan(3000);
    const frequency = await db.tag.findFirstOrThrow({ where: { plcInstanceId: demo.plcId, name: "VFD_01_FREQ" } });
    expect(await db.telemetrySample.count({ where: { tagId: frequency.id } })).toBeGreaterThan(3);
    // One snapshot row per simulated device, overwritten, never a row per tick.
    expect(await db.deviceRuntimeSnapshot.count()).toBeLessThanOrEqual(4);
  }, 60_000);

  it("produces the engineering export of the demo PLC", async () => {
    const exported = JSON.parse(JSON.stringify(await buildPlcExport(db, alice, demo.plcId, { includeRuntime: true })));
    const text = JSON.stringify(exported);
    for (const expected of [
      "PLC-01",
      "CPU 1511-1 PN",
      "VFD-01",
      "PT-101",
      "MOTOR-01",
      "PUMP-01",
      "Pump_Speed_SP",
      "VFD_01_FREQ",
      "DRIVES",
    ]) {
      expect(text, expected).toContain(expected);
    }
    expect(exported.schema).toBe("z-factory.plc-export");
    expect(text).not.toMatch(/c0ffee|docker\.sock|runtimeSecret/);
    expect(text).not.toContain(
      (await db.deviceInstance.findUniqueOrThrow({ where: { id: demo.plcId } })).dockerContainerId,
    );
  }, 60_000);

  it("stops the factory: simulation first, then the PLC; the gateway is told that the PLC does not answer", async () => {
    const stopped = await stopFactory(deps, alice, demo.factoryId);
    expect(stopped.plcs).toEqual([{ id: demo.plcId, name: "PLC-01", state: "STOPPED" }]);
    expect(deps.simulation.simulator.isRunning(demo.factoryId)).toBe(false);
    const devices = await db.deviceInstance.findMany({ where: { factoryId: demo.factoryId } });
    expect(
      devices.filter((device) => device.name !== "GATEWAY-01").every((device) => device.runtimeStatus === "STOPPED"),
    ).toBe(true);
    const container = await docker
      .getContainer(devices.find((device) => device.id === demo.plcId)?.dockerContainerId ?? "")
      .inspect();
    expect(container.State.Running).toBe(false);

    await sleep(2200);
    const afterStop = await read("VFD_01_FREQ").then(
      () => "answered",
      (error: DomainError) => error.details.exceptionCode,
    );
    expect(afterStop).toBe(11);
    expect(await eventTypes()).toContain("SIMULATION_STOPPED");
    // Stopping twice is not an error.
    expect((await stopFactory(deps, alice, demo.factoryId)).plcs[0]?.state).toBe("STOPPED");
  }, 120_000);
});
