// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DomainError } from "@/lib/domain/errors";
import type { RuntimeEventEnvelope } from "@/lib/domain/events";
import type { ModbusArea } from "@/lib/domain/tag";
import { PlcBridge, type PlcIo, type SignalBinding } from "./bridge";
import type { DeviceConfig, DeviceSnapshot, Signals } from "./engine";
import { DeviceSimulatorRuntime } from "./runtime";

/** An in-memory PLC: coils and holding registers, a request log and a switch to make it unreachable. */
class FakePlc implements PlcIo {
  readonly coils = new Array<boolean>(9000).fill(false);
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

const devices: DeviceConfig[] = [
  { id: "vfd", name: "VFD-01", type: "VFD", params: { accelTimeS: 5 } },
  { id: "motor", name: "M-01", type: "MOTOR", driveId: "vfd" },
  { id: "pump", name: "P-01", type: "PUMP", motorId: "motor" },
];

/** PLC-01: run at %QX0.0, setpoint at %QW0 (0.1 Hz), feedback from %MW0 (holding 1024…) and %MX0.0. */
const bindings: SignalBinding[] = [
  {
    deviceId: "vfd",
    signal: "run",
    direction: "IN",
    kind: "BOOL",
    area: "COIL",
    address: 0,
    encoding: { dataType: "BOOL" },
  },
  {
    deviceId: "vfd",
    signal: "frequencySetpoint",
    direction: "IN",
    kind: "NUMBER",
    area: "HOLDING_REGISTER",
    address: 0,
    encoding: { dataType: "INT16", scale: 0.1 },
  },
  {
    deviceId: "vfd",
    signal: "actualFrequency",
    direction: "OUT",
    kind: "NUMBER",
    area: "HOLDING_REGISTER",
    address: 1024,
    encoding: { dataType: "INT16", scale: 0.1 },
  },
  {
    deviceId: "motor",
    signal: "actualSpeed",
    direction: "OUT",
    kind: "NUMBER",
    area: "HOLDING_REGISTER",
    address: 1025,
    encoding: { dataType: "UINT16" },
  },
  {
    deviceId: "pump",
    signal: "pressure",
    direction: "OUT",
    kind: "NUMBER",
    area: "HOLDING_REGISTER",
    address: 2048,
    encoding: { dataType: "FLOAT32" },
  },
  {
    deviceId: "vfd",
    signal: "running",
    direction: "OUT",
    kind: "BOOL",
    area: "COIL",
    address: 8192,
    encoding: { dataType: "BOOL" },
  },
].map((binding, index) => ({
  ...binding,
  plcId: "plc",
  tagName: `tag${index}`,
  wordCount: binding.encoding.dataType === "FLOAT32" ? 2 : 1,
})) as SignalBinding[];

const float = (plc: FakePlc, address: number) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt16BE(plc.holding[address] ?? 0, 0);
  buffer.writeUInt16BE(plc.holding[address + 1] ?? 0, 2);
  return buffer.readFloatBE(0);
};

function setup(options: { snapshotIntervalMs?: number } = {}) {
  const plc = new FakePlc();
  const events: RuntimeEventEnvelope[] = [];
  const snapshots: DeviceSnapshot[][] = [];
  let now = 0;
  const runtime = new DeviceSimulatorRuntime({ now: () => now, date: () => new Date(1_800_000_000_000 + now) });
  runtime.start("factory", {
    config: { factoryId: "factory", devices },
    bindings,
    plcs: new Map([["plc", plc]]),
    autoTick: false,
    snapshotIntervalMs: options.snapshotIntervalMs,
    bridge: { refreshEveryTicks: 1000 },
    hooks: {
      onEvents: (batch) => void events.push(...batch),
      onSnapshot: (_factoryId, snapshot) => void snapshots.push(snapshot),
    },
  });
  const advance = async (seconds: number) => {
    for (let step = 0; step < Math.round(seconds * 10); step += 1) {
      now += 100;
      await runtime.tick("factory", 100);
    }
  };
  return { plc, runtime, events, snapshots, advance, elapse: (ms: number) => (now += ms) };
}

describe("server-only boundary", () => {
  it("marks every simulator and event module as server-only", () => {
    for (const relative of ["lib/runtimes/device-sim", "lib/events"]) {
      const directory = join(process.cwd(), relative);
      const files = readdirSync(directory).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        expect(readFileSync(join(directory, file), "utf8").split("\n")[0], file).toBe('import "server-only";');
      }
    }
  });
});

describe("PLC bridge", () => {
  it("reads PLC outputs as typed device inputs with few requests", async () => {
    const plc = new FakePlc();
    plc.coils[0] = true;
    plc.holding[0] = 425;
    const bridge = new PlcBridge(bindings, new Map([["plc", plc]]));

    const { inputs, changes } = await bridge.readInputs();
    expect(inputs.get("vfd")).toEqual({ run: true, frequencySetpoint: 42.5 });
    expect(changes).toEqual([{ plcId: "plc", up: true }]);
    expect(plc.log).toEqual(["read COIL 0+1", "read HOLDING_REGISTER 0+1"]);
  });

  it("writes feedback only when it changed, neighbouring registers in one request", async () => {
    const plc = new FakePlc();
    const bridge = new PlcBridge(bindings, new Map([["plc", plc]]), { refreshEveryTicks: 5 });
    const outputs = {
      vfd: { actualFrequency: 12.34, running: true },
      motor: { actualSpeed: 358 },
      pump: { pressure: 0.25 },
    };
    const read = (deviceId: string) => outputs[deviceId as keyof typeof outputs];

    await bridge.writeOutputs(read);
    expect(plc.log).toEqual(["coil 8192=true", "registers 1024+2", "registers 2048+2"]);
    expect(plc.holding.slice(1024, 1026)).toEqual([123, 358]);
    expect(float(plc, 2048)).toBeCloseTo(0.25, 6);

    plc.log.length = 0;
    await bridge.writeOutputs(read);
    expect(plc.log).toEqual([]);

    outputs.motor.actualSpeed = 400;
    await bridge.writeOutputs(read);
    expect(plc.log).toEqual(["registers 1024+2"]);

    // Fifth cycle since the start: everything is refreshed even though nothing changed.
    plc.log.length = 0;
    await bridge.writeOutputs(read);
    expect(plc.log).toEqual([]);
    await bridge.writeOutputs(read);
    expect(plc.log).toEqual(["coil 8192=true", "registers 1024+2", "registers 2048+2"]);
  });

  it("saturates a value beyond the tag's range instead of failing", async () => {
    const plc = new FakePlc();
    const bridge = new PlcBridge(bindings, new Map([["plc", plc]]));
    await bridge.writeOutputs((deviceId): Signals =>
      deviceId === "vfd" ? { actualFrequency: 99_999, running: false } : { actualSpeed: -5, pressure: Number.NaN },
    );
    expect(plc.holding[1024]).toBe(32767);
    expect(plc.holding[1025]).toBe(0);
    expect(float(plc, 2048)).toBe(0);
  });

  it("de-energizes the inputs of an unreachable PLC, backs off, and rewrites everything on recovery", async () => {
    const plc = new FakePlc();
    plc.coils[0] = true;
    plc.holding[0] = 500;
    let now = 0;
    const bridge = new PlcBridge(bindings, new Map([["plc", plc]]), { retryMs: 2000, now: () => now });
    const outputs = () => ({ actualFrequency: 10, running: true, actualSpeed: 290, pressure: 0.16 });

    await bridge.readInputs();
    await bridge.writeOutputs(outputs);

    plc.reachable = false;
    const down = await bridge.readInputs();
    expect(down.inputs.get("vfd")).toEqual({ run: false, frequencySetpoint: 0 });
    expect(down.changes).toEqual([{ plcId: "plc", up: false }]);

    // Reachable again, but the retry time has not come: no request, no change reported.
    plc.reachable = true;
    plc.log.length = 0;
    now = 1000;
    const waiting = await bridge.readInputs();
    expect(waiting.inputs.get("vfd")).toEqual({ run: false, frequencySetpoint: 0 });
    expect(waiting.changes).toEqual([]);
    expect(await bridge.writeOutputs(outputs)).toEqual([]);
    expect(plc.log).toEqual([]);

    now = 2500;
    const up = await bridge.readInputs();
    expect(up.inputs.get("vfd")).toEqual({ run: true, frequencySetpoint: 50 });
    expect(up.changes).toEqual([{ plcId: "plc", up: true }]);
    plc.log.length = 0;
    await bridge.writeOutputs(outputs);
    expect(plc.log).toEqual(["coil 8192=true", "registers 1024+2", "registers 2048+2"]);
  });
});

describe("shared simulator runtime", () => {
  it("closes the loop: PLC outputs drive the devices and feedback lands in the PLC", async () => {
    const { plc, advance, events, runtime } = setup();
    await advance(1);
    expect(plc.holding[1024]).toBe(0);

    // What PLC logic would do: run the drive at 40.0 Hz.
    plc.coils[0] = true;
    plc.holding[0] = 400;
    await advance(2);
    expect(plc.holding[1024]).toBe(200);
    expect(plc.coils[8192]).toBe(true);

    await advance(8);
    expect(plc.holding.slice(1024, 1026)).toEqual([400, 1160]);
    expect(float(plc, 2048)).toBeCloseTo(4 * 0.8 * 0.8, 3);

    const types = events.map((event) => event.type);
    expect(types).toContain("CONNECTION_UP");
    expect(types).toContain("VFD_STATE_CHANGED");
    expect(types).toContain("MOTOR_STATE_CHANGED");
    expect(types).toContain("PUMP_STATE_CHANGED");
    const event = events.find((candidate) => candidate.type === "VFD_STATE_CHANGED");
    expect(event).toMatchObject({ version: 1, factoryId: "factory", deviceId: "vfd", severity: "INFO" });
    expect(event?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(event?.occurredAt ?? ""))).toBe(false);
    // A handful of meaningful changes, not one event per tick.
    expect(events.length).toBeLessThan(10);
    expect(runtime.status("factory")).toMatchObject({ ticks: 110, lastError: null });
  });

  it("stops the devices when the PLC goes away and resumes when it returns", async () => {
    const { plc, advance, events, elapse } = setup();
    plc.coils[0] = true;
    plc.holding[0] = 500;
    await advance(8);
    expect(plc.holding[1024]).toBe(500);

    plc.reachable = false;
    await advance(1);
    expect(events.filter((event) => event.type === "CONNECTION_DOWN")).toMatchObject([
      { deviceId: "plc", severity: "WARNING" },
    ]);

    plc.reachable = true;
    elapse(3000);
    await advance(0.2);
    expect(events.at(-1)?.type === "CONNECTION_UP" || events.some((event) => event.type === "VFD_STATE_CHANGED")).toBe(
      true,
    );
    // The drive ramped down while its run command was gone and is ramping up again.
    expect(plc.holding[1024]).toBeGreaterThan(300);
    expect(plc.holding[1024]).toBeLessThan(500);
  });

  it("snapshots at its interval and on stop, never per tick", async () => {
    const { advance, snapshots, runtime } = setup({ snapshotIntervalMs: 2000 });
    await advance(5);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]?.map((device) => device.name)).toEqual(["VFD-01", "M-01", "P-01"]);

    const final = await runtime.stop("factory");
    expect(snapshots).toHaveLength(3);
    expect(final).toEqual(snapshots[2]);
    expect(runtime.isRunning("factory")).toBe(false);
    expect(runtime.status("factory")).toBeNull();
    // A tick for a stopped factory is ignored.
    await runtime.tick("factory", 100);
  });

  it("keeps the simulations of different factories apart", async () => {
    const runtime = new DeviceSimulatorRuntime();
    const first = new FakePlc();
    const second = new FakePlc();
    for (const [factoryId, plc] of [
      ["a", first],
      ["b", second],
    ] as const) {
      runtime.start(factoryId, {
        config: { factoryId, devices },
        bindings,
        plcs: new Map([["plc", plc]]),
        autoTick: false,
      });
    }
    first.coils[0] = true;
    first.holding[0] = 300;
    for (let step = 0; step < 50; step += 1) {
      await runtime.tick("a", 100);
      await runtime.tick("b", 100);
    }
    expect(first.holding[1024]).toBe(300);
    expect(second.holding[1024]).toBe(0);
    runtime.simulation("a").injectFault("vfd", "OVERCURRENT");
    await runtime.tick("a", 100);
    await runtime.tick("b", 100);
    expect(runtime.status("a")?.devices[0]).toMatchObject({ state: "FAULTED" });
    expect(runtime.status("b")?.devices[0]).toMatchObject({ state: "STOPPED", faulted: false });
    await runtime.stopAll();
    expect(runtime.isRunning("a")).toBe(false);
  });

  it("refuses a second start, and reports a factory that is not running", async () => {
    const { runtime } = setup();
    expect(() =>
      runtime.start("factory", { config: { factoryId: "factory", devices }, bindings: [], plcs: new Map() }),
    ).toThrow(DomainError);
    try {
      runtime.simulation("other");
      throw new Error("expected a DomainError");
    } catch (error) {
      expect((error as DomainError).details.rule).toBe("simulation-not-running");
    }
  });

  it("keeps running when a persistence hook fails and records the failure", async () => {
    const plc = new FakePlc();
    const runtime = new DeviceSimulatorRuntime();
    runtime.start("factory", {
      config: { factoryId: "factory", devices },
      bindings,
      plcs: new Map([["plc", plc]]),
      autoTick: false,
      hooks: {
        onEvents: () => {
          throw new Error("database is away");
        },
      },
    });
    plc.coils[0] = true;
    plc.holding[0] = 100;
    for (let step = 0; step < 20; step += 1) await runtime.tick("factory", 100);
    expect(plc.holding[1024]).toBe(100);
    // The first cycle's CONNECTION_UP event failed to persist; later cycles had nothing to report.
    expect(runtime.status("factory")?.ticks).toBe(20);
  });

  it("publishes service-originated events through the same hooks", async () => {
    const { runtime, events } = setup();
    const event = runtime.simulation("factory").injectFault("pump", "DRY_RUN");
    const [envelope] = await runtime.publish("factory", [event]);
    expect(envelope).toMatchObject({ type: "FAULT_INJECTED", deviceId: "pump", severity: "WARNING" });
    expect(events).toEqual([envelope]);
  });

  it("ticks on its own timer in real time", async () => {
    const plc = new FakePlc();
    plc.coils[0] = true;
    plc.holding[0] = 500;
    const runtime = new DeviceSimulatorRuntime();
    runtime.start("factory", {
      config: { factoryId: "factory", devices },
      bindings,
      plcs: new Map([["plc", plc]]),
      tickMs: 20,
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await runtime.stop("factory");
    // About 0.4 s at 10 Hz/s: a few hertz, driven by real elapsed time rather than tick count.
    expect(plc.holding[1024]).toBeGreaterThan(15);
    expect(plc.holding[1024]).toBeLessThan(80);
    const frozen = plc.holding[1024];
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(plc.holding[1024]).toBe(frozen);
  });
});
