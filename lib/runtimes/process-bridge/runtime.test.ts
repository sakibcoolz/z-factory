// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DomainError } from "@/lib/domain/errors";
import type { RuntimeEventEnvelope } from "@/lib/domain/events";
import type { ModuleSignal } from "@/lib/domain/process-module";
import {
  PROCESS_SIM_CONTRACT_VERSION,
  type ProcessSimConfig,
  type ProcessSimEvent,
  type ProcessSimSnapshot,
} from "@/lib/domain/process-sim";
import type { ModbusArea } from "@/lib/domain/tag";
import { decodeValue } from "@/lib/protocols/modbus/codec";
import type { PlcIo, SignalBinding } from "@/lib/runtimes/device-sim/bridge";
import type { ProcessSimClient } from "@/lib/runtimes/process-sim/client";
import { type ProcessModulePlan, ProcessBridgeRuntime } from "./runtime";

/** An in-memory PLC: coils and holding registers, a request log and a switch to make it unreachable. */
class FakePlc implements PlcIo {
  readonly coils = new Array<boolean>(17000).fill(false);
  readonly holding = new Array<number>(5000).fill(0);
  readonly log: string[] = [];
  reachable = true;

  private check() {
    if (!this.reachable) throw new Error("unreachable");
  }

  async read(area: ModbusArea, address: number, count: number) {
    this.check();
    this.log.push(`read ${area} ${address}+${count}`);
    const source = area === "COIL" ? this.coils : this.holding;
    return source.slice(address, address + count);
  }

  async writeCoil(address: number, value: boolean) {
    this.check();
    this.log.push(`coil ${address}=${value}`);
    this.coils[address] = value;
  }

  async writeRegisters(address: number, words: readonly number[]) {
    this.check();
    this.log.push(`registers ${address}+${words.length}`);
    words.forEach((word, index) => (this.holding[address + index] = word));
  }
}

type Instance = {
  config: ProcessSimConfig;
  status: ProcessSimSnapshot["status"];
  tick: number;
  inputs: Record<string, number>;
  outputs: Record<string, number>;
  events: ProcessSimEvent[];
};

/**
 * A stand-in for the simulation service with a toy pump model: it runs when told to, its
 * pressure is 6 bar while running, and the low-pressure alarm is active while it stands
 * still after having run. It records every call and can be made to fail or to forget.
 */
class FakeService {
  readonly instances = new Map<string, Instance>();
  readonly calls: string[] = [];
  failing: string | null = null;

  private fail() {
    if (this.failing) throw new DomainError("RUNTIME_FAILURE", this.failing, { rule: "process-sim-unreachable" });
  }

  private get(id: string): Instance {
    const instance = this.instances.get(id);
    if (!instance) throw new DomainError("NOT_FOUND", "no such instance", { rule: "process-sim" });
    return instance;
  }

  private snapshot(instance: Instance): ProcessSimSnapshot {
    return {
      instanceId: instance.config.instanceId,
      factoryId: instance.config.factoryId,
      moduleType: instance.config.moduleType,
      modelType: instance.config.modelType,
      modelVersion: instance.config.modelVersion,
      configVersion: instance.config.configVersion,
      tickMs: instance.config.tickMs,
      clock: instance.config.clock,
      status: instance.status,
      tick: instance.tick,
      timeS: (instance.tick * instance.config.tickMs) / 1000,
      inputs: { ...instance.inputs },
      outputs: { ...instance.outputs },
      state: {},
      lastEventSeq: instance.events.length,
      loadedAt: "2026-10-06T00:00:00.000Z",
    };
  }

  private record(instance: Instance, type: string, message: string) {
    instance.events.push({ seq: instance.events.length + 1, tick: instance.tick, timeS: 0, type, message });
  }

  readonly client: ProcessSimClient = {
    health: async () => ({
      status: "ok",
      version: "test",
      contractVersion: 1,
      deviceContractVersion: 1,
      uptimeS: 0,
      instances: 0,
      modelTypes: [],
      factories: 0,
      devices: 0,
      profiles: [],
    }),
    metrics: async () => ({
      instances: 0,
      byStatus: {},
      ticksTotal: 0,
      lastTickMicros: 0,
      modelTypes: [],
      devices: {
        factories: 0,
        factoriesByStatus: {},
        devices: 0,
        devicesByStatus: {},
        maxDevices: 0,
        ticksTotal: 0,
        lastTickMicros: 0,
        stalled: 0,
        profiles: [],
      },
    }),
    // The bridge binds process modules; the device runtime (TASK-1009) is not its concern.
    devices: {} as ProcessSimClient["devices"],
    list: async () => [...this.instances.values()].map((instance) => this.snapshot(instance)),
    load: async (config) => {
      this.calls.push(`load ${config.instanceId}`);
      this.fail();
      if (config.modelType === "BROKEN") {
        throw new DomainError("VALIDATION", "unknown model", { rule: "process-sim-configuration" });
      }
      const instance: Instance = {
        config,
        status: "LOADED",
        tick: 0,
        inputs: { DUTY_RUN_CMD: 0, DUTY_SPEED_SETPOINT: 100, ...config.inputs },
        outputs: { DUTY_RUNNING: 0, DISCHARGE_PRESSURE: 0, LOW_PRESSURE: 0 },
        events: [],
      };
      this.instances.set(config.instanceId, instance);
      return this.snapshot(instance);
    },
    inspect: async (id) => this.snapshot(this.get(id)),
    unload: async (id) => {
      this.calls.push(`unload ${id}`);
      this.instances.delete(id);
    },
    start: async (id) => {
      this.calls.push(`start ${id}`);
      const instance = this.get(id);
      instance.status = "RUNNING";
      return this.snapshot(instance);
    },
    stop: async (id) => {
      const instance = this.get(id);
      instance.status = "STOPPED";
      return this.snapshot(instance);
    },
    reset: async (id) => this.snapshot(this.get(id)),
    step: async (id, ticks = 1) => {
      this.calls.push(`step ${id} ${ticks}`);
      this.fail();
      const instance = this.get(id);
      const run = instance.inputs.DUTY_RUN_CMD === 1;
      const wasRunning = instance.outputs.DUTY_RUNNING === 1;
      instance.tick += ticks;
      instance.outputs = {
        DUTY_RUNNING: run ? 1 : 0,
        DISCHARGE_PRESSURE: run ? 6 : 0,
        LOW_PRESSURE: !run && (wasRunning || instance.outputs.LOW_PRESSURE === 1) ? 1 : 0,
      };
      if (run && !wasRunning) this.record(instance, "PUMP_STARTED", "duty pump started");
      if (!run && wasRunning) {
        this.record(instance, "PUMP_STOPPED", "duty pump stopped");
        this.record(instance, "ALARM_RAISED", "discharge pressure low");
      }
      return this.snapshot(instance);
    },
    setInputs: async (id, inputs) => {
      this.calls.push(`inputs ${id} ${JSON.stringify(inputs)}`);
      this.fail();
      const instance = this.get(id);
      Object.assign(instance.inputs, inputs);
      return this.snapshot(instance);
    },
    events: async (id, after = 0) => this.get(id).events.filter((event) => event.seq > after),
    overrides: async () => [],
    setOverride: async () => Promise.reject(new Error("not used")),
    clearOverride: async () => Promise.reject(new Error("not used")),
  };
}

const signal = (
  key: string,
  direction: ModuleSignal["direction"],
  dataType: ModuleSignal["dataType"],
): ModuleSignal => ({
  key,
  name: key.toLowerCase().replaceAll("_", " "),
  description: null,
  direction,
  dataType,
  role: direction === "OUTPUT" ? "COMMAND" : direction === "ALARM" ? "ALARM" : "FEEDBACK",
  unit: null,
  signalType: null,
  required: true,
  rangeMin: null,
  rangeMax: null,
  roleKey: null,
  profiles: [],
});

const SIGNALS = [
  signal("DUTY_RUN_CMD", "OUTPUT", "BOOL"),
  signal("DUTY_SPEED_SETPOINT", "OUTPUT", "FLOAT32"),
  signal("DUTY_RUNNING", "INPUT", "BOOL"),
  signal("DISCHARGE_PRESSURE", "INPUT", "FLOAT32"),
  signal("LOW_PRESSURE", "ALARM", "BOOL"),
];

/** PLC-01: run at %QX0.0, setpoint at %QW0 (0.01 %), running to %MX0.0, pressure to %MD0 as FLOAT32, alarm to %MX0.1. */
const binding = (
  signalKey: string,
  partial: Omit<SignalBinding, "deviceId" | "signal" | "plcId" | "tagName" | "wordCount">,
): SignalBinding => ({
  deviceId: "module-1",
  signal: signalKey,
  plcId: "plc-1",
  tagName: signalKey,
  wordCount: partial.encoding.dataType === "BOOL" || partial.encoding.dataType.endsWith("16") ? 1 : 2,
  ...partial,
});
const BINDINGS: SignalBinding[] = [
  binding("DUTY_RUN_CMD", { direction: "IN", kind: "BOOL", area: "COIL", address: 0, encoding: { dataType: "BOOL" } }),
  binding("DUTY_SPEED_SETPOINT", {
    direction: "IN",
    kind: "NUMBER",
    area: "HOLDING_REGISTER",
    address: 0,
    encoding: { dataType: "INT16", scale: 0.01 },
  }),
  binding("DUTY_RUNNING", {
    direction: "OUT",
    kind: "BOOL",
    area: "COIL",
    address: 8192,
    encoding: { dataType: "BOOL" },
  }),
  binding("DISCHARGE_PRESSURE", {
    direction: "OUT",
    kind: "NUMBER",
    area: "HOLDING_REGISTER",
    address: 2048,
    encoding: { dataType: "FLOAT32" },
  }),
  binding("LOW_PRESSURE", {
    direction: "OUT",
    kind: "BOOL",
    area: "COIL",
    address: 8193,
    encoding: { dataType: "BOOL" },
  }),
];

const config = (instanceId: string, tickMs = 50, modelType = "PUMP_HOUSE"): ProcessSimConfig => ({
  contractVersion: PROCESS_SIM_CONTRACT_VERSION,
  instanceId,
  factoryId: "factory-1",
  moduleType: "PUMP_HOUSE",
  modelType,
  modelVersion: 1,
  configVersion: 1,
  tickMs,
  clock: "wall",
  parameters: { ratedFlow: 50 },
});

const plan = (overrides: Partial<ProcessModulePlan> = {}): ProcessModulePlan => ({
  moduleId: "module-1",
  name: "Pump house 1",
  config: config("module-1"),
  signals: SIGNALS,
  bindings: BINDINGS,
  ...overrides,
});

function harness(options: { cycleMs?: number; modules?: ProcessModulePlan[]; plc?: FakePlc } = {}) {
  const plc = options.plc ?? new FakePlc();
  const service = new FakeService();
  const events: RuntimeEventEnvelope[] = [];
  let now = 0;
  const runtime = new ProcessBridgeRuntime({ now: () => now, date: () => new Date(now) });
  const start = () =>
    runtime.start("factory-1", {
      modules: options.modules ?? [plan()],
      plcs: new Map([["plc-1", plc]]),
      client: service.client,
      cycleMs: options.cycleMs ?? 200,
      autoTick: false,
      bridge: { retryMs: 1000 },
      hooks: { onEvents: (fresh) => void events.push(...fresh) },
    });
  const tick = async (times = 1) => {
    for (let index = 0; index < times; index += 1) {
      now += options.cycleMs ?? 200;
      await runtime.tick("factory-1");
    }
  };
  const types = () => events.map((event) => event.type);
  return { plc, service, events, runtime, start, tick, types };
}

describe("process bridge runtime", () => {
  it("loads the models with a manual clock, starts them, and unloads them on stop", async () => {
    const h = harness();
    await h.start();
    expect(h.service.calls).toEqual(["load module-1", "start module-1"]);
    expect(h.service.instances.get("module-1")?.config.clock).toBe("manual");
    expect(h.runtime.isRunning("factory-1")).toBe(true);
    expect(h.runtime.status("factory-1")?.modules[0]).toMatchObject({
      moduleId: "module-1",
      status: "RUNNING",
      quality: "GOOD",
      tick: 0,
    });

    const final = await h.runtime.stop("factory-1");
    expect(final).toHaveLength(1);
    expect(h.service.calls.at(-1)).toBe("unload module-1");
    expect(h.service.instances.size).toBe(0);
    expect(h.runtime.status("factory-1")).toBeNull();
    await expect(h.runtime.stop("factory-1")).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("advances every model by exactly one cycle of simulated time per exchange", async () => {
    // 200 ms cycles over a 50 ms model tick: four ticks per cycle, whatever real time does.
    const h = harness({ cycleMs: 200 });
    await h.start();
    await h.tick(3);
    expect(h.service.calls.filter((call) => call.startsWith("step"))).toEqual([
      "step module-1 4",
      "step module-1 4",
      "step module-1 4",
    ]);
    expect(h.runtime.status("factory-1")?.modules[0]).toMatchObject({ tick: 12, timeS: 0.6 });
    expect(h.runtime.status("factory-1")?.cycles).toBe(3);
    await h.runtime.stop("factory-1");
  });

  it("carries the PLC's command and setpoint into the model and the model's feedback back, scaled and typed", async () => {
    const h = harness();
    await h.start();
    await h.tick();
    // Nothing commanded: the model stands still and says so.
    expect(h.plc.coils[8192]).toBe(false);
    expect(decodeValue(h.plc.holding.slice(2048, 2050), { dataType: "FLOAT32" })).toBe(0);

    h.plc.coils[0] = true;
    h.plc.holding[0] = 7550; // 75.50 %
    await h.tick();
    expect(h.service.calls.filter((call) => call.startsWith("inputs"))).toEqual([
      'inputs module-1 {"DUTY_RUN_CMD":0,"DUTY_SPEED_SETPOINT":0}',
      'inputs module-1 {"DUTY_RUN_CMD":1,"DUTY_SPEED_SETPOINT":75.5}',
    ]);
    expect(h.plc.coils[8192]).toBe(true);
    expect(decodeValue(h.plc.holding.slice(2048, 2050), { dataType: "FLOAT32" })).toBe(6);
    expect(h.runtime.status("factory-1")?.modules[0]).toMatchObject({
      inputs: { DUTY_RUN_CMD: 1, DUTY_SPEED_SETPOINT: 75.5 },
      outputs: { DUTY_RUNNING: 1, DISCHARGE_PRESSURE: 6 },
    });
    // Unchanged inputs are not sent again; feedback that did not change is not written again.
    const before = h.service.calls.length;
    const writes = h.plc.log.filter((entry) => !entry.startsWith("read")).length;
    await h.tick();
    expect(h.service.calls.slice(before)).toEqual(["step module-1 4"]);
    expect(h.plc.log.filter((entry) => !entry.startsWith("read")).length).toBe(writes);
    await h.runtime.stop("factory-1");
  });

  it("reports the model's events once each and derives alarms from the ALARM signals", async () => {
    const h = harness();
    await h.start();
    h.plc.coils[0] = true;
    await h.tick();
    // First contact with the PLC is reported, then what the model did.
    expect(h.events.map((event) => [event.type, event.payload.event])).toEqual([
      ["CONNECTION_UP", undefined],
      ["PROCESS_STATE_CHANGED", "PUMP_STARTED"],
    ]);
    expect(h.events[1]?.payload).toMatchObject({
      module: "Pump house 1",
      moduleId: "module-1",
      message: "duty pump started",
    });

    h.plc.coils[0] = false;
    await h.tick();
    // The model's own ALARM_RAISED event is not repeated: the alarm comes from the LOW_PRESSURE signal.
    expect(h.types().slice(2)).toEqual(["PROCESS_ALARM_RAISED", "PROCESS_STATE_CHANGED"]);
    expect(h.events[2]).toMatchObject({
      severity: "WARNING",
      deviceId: null,
      payload: { module: "Pump house 1", code: "LOW_PRESSURE", name: "low pressure" },
    });
    expect(h.plc.coils[8193]).toBe(true);
    expect(h.runtime.status("factory-1")?.modules[0]?.alarms).toEqual(["LOW_PRESSURE"]);

    await h.tick();
    expect(h.types()).toHaveLength(4);
    h.plc.coils[0] = true;
    await h.tick();
    expect(h.types().slice(4)).toEqual(["PROCESS_ALARM_CLEARED", "PROCESS_STATE_CHANGED"]);
    expect(h.plc.coils[8193]).toBe(false);
    await h.runtime.stop("factory-1");
  });

  it("marks a module DISCONNECTED while its PLC does not answer, and de-energizes its commands", async () => {
    const h = harness();
    await h.start();
    h.plc.coils[0] = true;
    await h.tick();
    expect(h.runtime.status("factory-1")?.modules[0]?.quality).toBe("GOOD");

    h.plc.reachable = false;
    await h.tick();
    // The pump loses its command, stops, and the model raises its alarm: the loss is reported, not hidden.
    expect(h.types().slice(2)).toEqual([
      "CONNECTION_DOWN",
      "PROCESS_ALARM_RAISED",
      "PROCESS_STATE_CHANGED",
      "PROCESS_QUALITY_CHANGED",
    ]);
    expect(h.events[2]).toMatchObject({ deviceId: "plc-1", severity: "WARNING", payload: { link: "process-bridge" } });
    expect(h.events[5]?.payload).toMatchObject({ from: "GOOD", to: "DISCONNECTED" });
    // The PLC drives nothing it cannot be read from: the pump stops.
    expect(h.runtime.status("factory-1")?.modules[0]).toMatchObject({
      quality: "DISCONNECTED",
      status: "RUNNING",
      inputs: { DUTY_RUN_CMD: 0 },
      plcs: [{ plcId: "plc-1", up: false }],
    });

    // Back after the retry time: the link comes up and the feedback is written again in full.
    h.plc.reachable = true;
    await h.tick(6);
    expect(h.types().filter((type) => type === "CONNECTION_UP")).toHaveLength(2);
    expect(h.runtime.status("factory-1")?.modules[0]?.quality).toBe("GOOD");
    expect(h.plc.coils[8192]).toBe(true);
    await h.runtime.stop("factory-1");
  });

  it("marks a module STALE while the service fails, keeps its last values, and reloads it when the service forgot it", async () => {
    const h = harness();
    await h.start();
    h.plc.coils[0] = true;
    await h.tick();

    h.service.failing = "service down";
    await h.tick();
    expect(h.types().slice(2)).toEqual(["PROCESS_QUALITY_CHANGED"]);
    expect(h.events[2]?.payload).toMatchObject({ from: "GOOD", to: "STALE", message: "service down" });
    const stale = h.runtime.status("factory-1")?.modules[0];
    expect(stale).toMatchObject({ quality: "STALE", status: "UNAVAILABLE", error: "service down", tick: 4 });
    // The PLC keeps the last feedback; nothing is invented while the model cannot be stepped.
    expect(h.plc.coils[8192]).toBe(true);

    // The service came back empty: the instance is loaded and started again, then stepped on.
    h.service.failing = null;
    h.service.instances.clear();
    await h.tick();
    expect(h.runtime.status("factory-1")?.modules[0]?.quality).toBe("STALE");
    await h.tick();
    expect(h.service.calls.slice(-5)).toEqual([
      "step module-1 4",
      "load module-1",
      "start module-1",
      'inputs module-1 {"DUTY_RUN_CMD":1,"DUTY_SPEED_SETPOINT":0}',
      "step module-1 4",
    ]);
    expect(h.runtime.status("factory-1")?.modules[0]).toMatchObject({ quality: "GOOD", status: "RUNNING", tick: 4 });
    expect(h.types().at(-1)).toBe("PROCESS_QUALITY_CHANGED");
    expect(h.events.at(-1)?.payload).toMatchObject({ from: "STALE", to: "GOOD" });
    await h.runtime.stop("factory-1");
  });

  it("says how a module's feedback is doing, and releases it on stop (TASK-803)", async () => {
    const h = harness();
    await h.start();
    h.plc.coils[0] = true;
    h.plc.holding[0] = 7550;
    await h.tick();
    expect(h.runtime.feedbackQuality("factory-1", "module-1")).toBe("GOOD");
    expect(h.plc.coils[8192]).toBe(true);

    h.service.failing = "service down";
    await h.tick();
    expect(h.runtime.feedbackQuality("factory-1", "module-1")).toBe("STALE");
    h.service.failing = null;
    await h.tick();
    h.plc.reachable = false;
    await h.tick();
    expect(h.runtime.feedbackQuality("factory-1", "module-1")).toBe("DISCONNECTED");
    h.plc.reachable = true;
    await h.tick(6);
    expect(h.runtime.feedbackQuality("factory-1", "module-1")).toBe("GOOD");
    expect(h.plc.coils[8192]).toBe(true);

    await h.runtime.stop("factory-1");
    // The PLC no longer runs on a process that is gone: running, pressure and alarm drop.
    expect(h.plc.coils[8192]).toBe(false);
    expect(h.plc.coils[8193]).toBe(false);
    expect(decodeValue(h.plc.holding.slice(2048, 2050), { dataType: "FLOAT32" })).toBe(0);
    // Its commands stay the program's: the bridge never writes them.
    expect(h.plc.coils[0]).toBe(true);
    expect(h.plc.holding[0]).toBe(7550);
    expect(h.runtime.feedbackQuality("factory-1", "module-1")).toBe("STALE");
  });

  it("refuses to start twice, and unloads what it loaded when a later module is refused", async () => {
    const h = harness({
      modules: [plan(), plan({ moduleId: "module-2", name: "Broken", config: config("module-2", 50, "BROKEN") })],
    });
    await expect(h.start()).rejects.toMatchObject({ code: "VALIDATION" });
    expect(h.service.calls).toEqual(["load module-1", "start module-1", "load module-2", "unload module-1"]);
    expect(h.runtime.isRunning("factory-1")).toBe(false);

    const ok = harness();
    await ok.start();
    await expect(ok.start()).rejects.toMatchObject({ code: "CONFLICT", details: { rule: "process-bridge-running" } });
    await ok.runtime.stopAll();
    expect(ok.runtime.isRunning("factory-1")).toBe(false);
  });

  it("runs the modules of a factory against the same PLC without mixing their signals", async () => {
    const second: SignalBinding[] = BINDINGS.map((entry) => ({
      ...entry,
      deviceId: "module-2",
      tagName: `B_${entry.signal}`,
      address: entry.address + (entry.area === "COIL" ? 16 : 16),
    }));
    const h = harness({
      modules: [
        plan(),
        plan({ moduleId: "module-2", name: "Pump house 2", config: config("module-2"), bindings: second }),
      ],
    });
    await h.start();
    h.plc.coils[16] = true;
    await h.tick();
    const [first, other] = h.runtime.status("factory-1")?.modules ?? [];
    expect(first).toMatchObject({ moduleId: "module-1", outputs: { DUTY_RUNNING: 0 } });
    expect(other).toMatchObject({ moduleId: "module-2", outputs: { DUTY_RUNNING: 1 } });
    expect(h.plc.coils[8192]).toBe(false);
    expect(h.plc.coils[8208]).toBe(true);
    await h.runtime.stop("factory-1");
  });
});
