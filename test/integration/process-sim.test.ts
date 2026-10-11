// @vitest-environment node
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BEHAVIOR_PROFILES } from "@/lib/domain/behavior-contract";
import {
  DEVICE_SIM_CONTRACT_VERSION,
  type DeviceSimConfig,
  expectedParameterSchema,
  PROCESS_SIM_CONTRACT_VERSION,
  PROCESS_SIM_MODELS,
  type ProcessSimConfig,
} from "@/lib/domain/process-sim";
import { type DeviceConfig, FactorySimulation } from "@/lib/runtimes/device-sim/engine";
import { createProcessSimClient, type ProcessSimClient } from "@/lib/runtimes/process-sim/client";
import { toDeviceSimDevices } from "@/lib/runtimes/process-sim/devices";

/**
 * Z-Factory against the running process simulation service (TASK-602): the built binary
 * is started here, driven through the server's client, and restarted. Runs when
 * PROCESS_SIM_BIN points at the binary (`go build -o … ./cmd/process-sim`); CI builds it.
 */
const binary = process.env.PROCESS_SIM_BIN;
const describeSim = binary ? describe : describe.skip;
const TOKEN = "integration-token-0123456789";

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

function startService(port: number): ChildProcess {
  const child = spawn(binary ?? "", [], {
    env: {
      ...process.env,
      PROCESS_SIM_ADDR: `127.0.0.1:${port}`,
      PROCESS_SIM_TOKEN: TOKEN,
      PROCESS_SIM_MAX_INSTANCES: "4",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.resume();
  child.stderr?.resume();
  return child;
}

async function waitForHealth(client: ProcessSimClient): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await client.health();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

const stopService = (child: ChildProcess) =>
  new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });

const config = (instanceId: string, overrides: Partial<ProcessSimConfig> = {}): ProcessSimConfig => ({
  contractVersion: PROCESS_SIM_CONTRACT_VERSION,
  instanceId,
  factoryId: "factory-1",
  moduleType: "PUMP_HOUSE",
  ...PROCESS_SIM_MODELS.PUMP_HOUSE!,
  configVersion: 1,
  tickMs: 100,
  clock: "manual",
  parameters: { ratedFlow: 80, ratedPressure: 5, rampTimeS: 10 },
  inputs: { DUTY_RUN_CMD: 1 },
  ...overrides,
});

describeSim("process simulation service", () => {
  let port: number;
  let child: ChildProcess;
  let client: ProcessSimClient;
  /** The outputs of a pump after 50 ticks at full setpoint, to compare other runs with. */
  let reference: Record<string, number> = {};

  beforeAll(async () => {
    port = await freePort();
    child = startService(port);
    client = createProcessSimClient({ url: `http://127.0.0.1:${port}`, token: TOKEN });
    await waitForHealth(client);
  }, 20_000);
  afterAll(async () => {
    await stopService(child);
  });

  it("reports its health and the models it has, and refuses the wrong token", async () => {
    const health = await client.health();
    expect(health).toMatchObject({
      status: "ok",
      contractVersion: PROCESS_SIM_CONTRACT_VERSION,
      modelTypes: ["PUMP_HOUSE", "TANK"],
    });
    const stranger = createProcessSimClient({ url: `http://127.0.0.1:${port}`, token: "wrong-token-0123456789" });
    await expect(stranger.list()).rejects.toMatchObject({ details: { rule: "process-sim-token" } });
    // The health check needs no token, so a probe can use it; everything else does.
    expect((await stranger.health()).status).toBe("ok");
  });

  it("runs independent instances deterministically: the same configuration and steps give the same values", async () => {
    await client.load(config("pump-a"));
    await client.load(config("pump-b"));
    const tank = await client.load(
      config("tank-1", {
        moduleType: "TANK",
        ...PROCESS_SIM_MODELS.TANK!,
        parameters: { volume: 40, inflowRate: 3600, valveTravelS: 1 },
        inputs: { INLET_VALVE_CMD: 1 },
        tickMs: 1000,
      }),
    );
    expect(tank).toMatchObject({ status: "LOADED", tick: 0, configVersion: 1 });

    await client.start("pump-a");
    await client.start("pump-b");
    await client.start("tank-1");
    const a = await client.step("pump-a", 50);
    const t = await client.step("tank-1", 10);
    const b = await client.step("pump-b", 50);

    expect(a.outputs).toMatchObject({ DUTY_RUNNING: 1, DUTY_SPEED: 50, FLOW: 40, DISCHARGE_PRESSURE: 1.25 });
    expect(b.outputs).toEqual(a.outputs);
    expect(b.state).toEqual(a.state);
    reference = a.outputs;
    expect(t.outputs).toMatchObject({ LEVEL: 25, INLET_VALVE_OPEN: 1 });
    // Stepping one instance moved no other.
    expect((await client.inspect("tank-1")).tick).toBe(10);
    expect((await client.inspect("pump-b")).tick).toBe(50);

    // Inputs change the course; a wrong input is refused.
    await client.setInputs("pump-a", { DUTY_SPEED_SETPOINT: 20 });
    const slowed = await client.step("pump-a", 50);
    expect(slowed.outputs.DUTY_SPEED).toBe(20);
    await expect(client.setInputs("pump-a", { LEVEL: 1 })).rejects.toMatchObject({ code: "VALIDATION" });
    const events = await client.events("pump-a");
    expect(events.map((event) => event.type)).toEqual(["PUMP_STARTED"]);
    const metrics = await client.metrics();
    expect(metrics).toMatchObject({ instances: 3, byStatus: { RUNNING: 3 } });
    expect(metrics.ticksTotal).toBe(160);
  });

  it("stops, continues, resets and unloads; refuses what the contract does not take", async () => {
    const stopped = await client.stop("pump-b");
    expect(stopped).toMatchObject({ status: "STOPPED", tick: 50 });
    await expect(client.step("pump-b", 1)).rejects.toMatchObject({ code: "CONFLICT" });
    await client.start("pump-b");
    expect((await client.step("pump-b", 10)).tick).toBe(60);

    const reset = await client.reset("pump-b");
    expect(reset).toMatchObject({ status: "LOADED", tick: 0, outputs: {}, inputs: { DUTY_RUN_CMD: 1 } });
    await client.start("pump-b");
    expect((await client.step("pump-b", 50)).outputs).toEqual(reference);

    await expect(client.load({ ...config("bad"), modelVersion: 9 })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(client.load({ ...config("bad"), parameters: { boilerPower: 1 } })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(client.load({ ...config("bad"), contractVersion: 2 as never })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    // The instance limit of this service is four.
    await client.load(config("pump-c"));
    await expect(client.load(config("pump-d"))).rejects.toMatchObject({ code: "VALIDATION" });
    await client.unload("pump-c");
    await expect(client.inspect("pump-c")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await client.list()).map((snapshot) => snapshot.instanceId)).toEqual(["pump-a", "pump-b", "tank-1"]);
  });

  it("starts empty after a restart: Z-Factory owns the configuration and loads it again", async () => {
    await stopService(child);
    child = startService(port);
    await waitForHealth(client);

    expect(await client.list()).toEqual([]);
    await client.load(config("pump-a", { configVersion: 2 }));
    await client.start("pump-a");
    expect((await client.step("pump-a", 50)).outputs.DUTY_SPEED).toBe(50);
  }, 30_000);
});

/** VFD → motor → pump with a pressure transmitter and a pressure switch, as the server's simulator configures it. */
const CHAIN: DeviceConfig[] = [
  { id: "vfd", name: "VFD-01", type: "VFD", params: { accelTimeS: 4, decelTimeS: 6 } },
  { id: "motor", name: "M-01", type: "MOTOR", driveId: "vfd" },
  { id: "pump", name: "P-01", type: "PUMP", motorId: "motor", params: { ratedFlow: 120, ratedPressure: 6 } },
  {
    id: "pt",
    name: "PT-01",
    type: "SENSOR",
    measuresId: "pump",
    params: { source: { kind: "MEASURED", signal: "pressure" }, timeConstantS: 0.5, rangeMin: 0, rangeMax: 10 },
  },
  {
    id: "ps",
    name: "PS-01",
    type: "SWITCH",
    measuresId: "pump",
    params: { source: { kind: "MEASURED", signal: "pressure", onAbove: 3, offBelow: 1 } },
  },
  { id: "xv", name: "XV-01", type: "VALVE", params: { travelTimeS: 2 } },
  { id: "tt", name: "TT-01", type: "SENSOR", params: { source: { kind: "RANDOM", min: 10, max: 20, seed: 7 } } },
];

const factoryConfig = (factoryId: string, overrides: Partial<DeviceSimConfig> = {}): DeviceSimConfig => ({
  contractVersion: DEVICE_SIM_CONTRACT_VERSION,
  factoryId,
  configVersion: 1,
  tickMs: 100,
  clock: "manual",
  devices: toDeviceSimDevices(CHAIN),
  ...overrides,
});

const toNumber = (value: number | boolean) => (typeof value === "boolean" ? (value ? 1 : 0) : value);

describeSim("the catalog device runtime (TASK-1009)", () => {
  let port: number;
  let child: ChildProcess;
  let client: ProcessSimClient;

  beforeAll(async () => {
    port = await freePort();
    child = startService(port);
    client = createProcessSimClient({ url: `http://127.0.0.1:${port}`, token: TOKEN });
    await waitForHealth(client);
  }, 20_000);
  afterAll(async () => {
    await stopService(child);
  });

  it("describes its profiles: the server's simulated types, with their signals and faults", async () => {
    const health = await client.health();
    expect(health).toMatchObject({ deviceContractVersion: DEVICE_SIM_CONTRACT_VERSION, factories: 0, devices: 0 });
    expect(health.profiles).toEqual(Object.keys(BEHAVIOR_PROFILES).sort());
    const vfd = await client.devices.profile("VFD");
    expect(vfd.signals.map((signal) => signal.key)).toEqual([
      "run",
      "reverse",
      "frequencySetpoint",
      "faultReset",
      "running",
      "atSetpoint",
      "faulted",
      "actualFrequency",
      "outputCurrent",
    ]);
    expect(vfd.faults.map((fault) => fault.code)).toEqual(["OVERCURRENT", "OVERTEMPERATURE"]);
    await expect(client.devices.profile("BOILER")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("describes every profile exactly as the behaviour contract does (TASK-1010)", async () => {
    for (const contract of Object.values(BEHAVIOR_PROFILES)) {
      const described = await client.devices.profile(contract.key);
      const where = contract.key;
      expect(described.version, where).toBe(contract.version);
      expect(described.summary, where).toBe(contract.summary);
      expect(described.states, where).toEqual([...contract.states]);
      expect(described.forcible, where).toBe(contract.forcible);
      expect(described.forcedKind, where).toEqual(contract.forcedKind);
      // Signals: key, direction, kind, label, unit (the contract's ranges stay on the server).
      const signal = (item: { key: string; direction: string; kind: string; label: string; unit?: string }) => [
        item.key,
        item.direction,
        item.kind,
        item.label,
        item.unit ?? null,
      ];
      expect(described.signals.map(signal), where).toEqual(contract.signals.map(signal));
      // Faults: the runtime knows code, name, severity, latching and silence; reset and effect follow from latching.
      const fault = (item: { code: string; name: string; severity: string; latching: boolean; silent?: boolean }) => [
        item.code,
        item.name,
        item.severity,
        item.latching,
        item.silent ?? false,
      ];
      expect(described.faults.map(fault), where).toEqual(contract.faults.map(fault));
      // Links by role, what they accept and what they mean.
      expect(
        (described.links ?? []).map((link) => [link.role, link.accepts ?? null, link.meaning]),
        where,
      ).toEqual(contract.links.map((link) => [link.role, link.accepts ? [...link.accepts] : null, link.meaning]));
      // The parameter schema, field by field, and the defaults body it implies.
      expect(described.parameterSchema, where).toEqual(expectedParameterSchema(contract.parameters));
      const defaults = Object.fromEntries(
        contract.parameters
          .filter((parameter) => !(parameter.kind === "NUMBER" && parameter.default === null))
          .map((parameter) => [parameter.key, parameter.default]),
      );
      expect(described.parameters, where).toEqual(defaults);
    }
  });

  it("gives the same values as the server's own simulator for the same configuration and inputs", async () => {
    const reference = new FactorySimulation({ factoryId: "parity", devices: CHAIN });
    await client.devices.load(factoryConfig("parity"));
    await client.devices.start("parity");
    const inputs = { run: true, frequencySetpoint: 42 };
    reference.setInputs("vfd", inputs);
    await client.devices.setInputs("parity", "vfd", { run: 1, frequencySetpoint: 42 });
    reference.setInputs("xv", { open: true });
    await client.devices.setInputs("parity", "xv", { open: 1 });
    for (let step = 0; step < 95; step += 1) reference.step(0.1);
    const snapshot = await client.devices.step("parity", 95);

    for (const device of snapshot.devices) {
      const expected = reference.outputs(device.deviceId);
      for (const [key, value] of Object.entries(expected)) {
        expect(device.outputs[key], `${device.deviceId}.${key}`).toBeCloseTo(toNumber(value), 6);
      }
      expect(device.status).toBe("OK");
    }
    expect(snapshot.devices.find((device) => device.deviceId === "ps")?.outputs.state).toBe(1);
    expect(snapshot.devices.find((device) => device.deviceId === "xv")?.outputs.opened).toBe(1);
  });

  it("isolates factories, takes devices in and out while running, and names the rule of a refusal", async () => {
    await client.devices.load(factoryConfig("other"));
    expect((await client.devices.inspect("parity")).tick).toBe(95);
    await client.devices.start("other");
    await client.devices.step("other", 10);
    expect((await client.devices.inspect("parity")).tick).toBe(95);

    await client.devices.upsertDevice("other", { deviceId: "fan", name: "FN-01", profile: "FAN", profileVersion: 1 });
    expect((await client.devices.inspect("other")).deviceCount).toBe(CHAIN.length + 1);
    await expect(client.devices.removeDevice("other", "motor")).rejects.toMatchObject({
      code: "CONFLICT",
      details: { rule: "linked-device" },
    });
    await client.devices.removeDevice("other", "fan");
    await expect(client.devices.setInputs("other", "vfd", { flow: 1 })).rejects.toMatchObject({
      code: "VALIDATION",
      details: { rule: "input-signal" },
    });
    await expect(
      client.devices.load(
        factoryConfig("bad", { devices: [{ deviceId: "x", name: "X", profile: "BOILER", profileVersion: 1 }] }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION", details: { rule: "profile" } });

    const injected = await client.devices.injectFault("other", "pump", "DRY_RUN");
    expect(injected.activeFaults).toEqual(["DRY_RUN"]);
    await client.devices.step("other", 1);
    expect((await client.devices.device("other", "pump")).outputs.flow).toBe(0);
    await client.devices.clearFault("other", "pump", "DRY_RUN");
    const forced = await client.devices.force("other", "tt", 15.5);
    expect(forced.forced).toBe(15.5);
    await client.devices.step("other", 1);
    expect((await client.devices.device("other", "tt")).outputs.value).toBe(15.5);
    await client.devices.force("other", "tt", null);

    const events = await client.devices.events("other");
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["FAULT_INJECTED", "FAULT_CLEARED", "SIMULATED_INPUT_FORCED", "SIMULATED_INPUT_RELEASED"]),
    );
    const metrics = await client.metrics();
    expect(metrics.devices).toMatchObject({ factories: 2, devices: CHAIN.length * 2, stalled: 0 });
    expect(metrics.devices.devicesByStatus).toEqual({ OK: CHAIN.length * 2 });

    const reset = await client.devices.reset("other");
    expect(reset).toMatchObject({ status: "LOADED", tick: 0 });
    await client.devices.unload("other");
    await client.devices.unload("parity");
    expect(await client.devices.list()).toEqual([]);
  });
});
