import "server-only";
import { randomUUID } from "node:crypto";
import { DomainError } from "@/lib/domain/errors";
import type { RuntimeEventEnvelope } from "@/lib/domain/events";
import type { TagQuality } from "@/lib/domain/tag";
import { type BridgeOptions, type LinkChange, PlcBridge, type PlcIo, type SignalBinding } from "./bridge";
import { type DeviceSnapshot, FactorySimulation, type SimEvent, type SimulationConfig } from "./engine";

/**
 * The shared device-simulator runtime: one instance hosts the simulations of many
 * factories inside the server process. Each factory has its own devices, its own PLC
 * bridge and its own tick; nothing is shared between factories but the engine code.
 *
 * Live state exists only here. Persistence happens through the hooks, for meaningful
 * events and periodic snapshots, never per tick.
 */

export type SimulationHooks = {
  onEvents?: (events: RuntimeEventEnvelope[]) => void | Promise<void>;
  onSnapshot?: (factoryId: string, devices: DeviceSnapshot[], capturedAt: Date) => void | Promise<void>;
};

export type StartOptions = {
  config: SimulationConfig;
  bindings: readonly SignalBinding[];
  plcs: ReadonlyMap<string, PlcIo>;
  tickMs?: number;
  snapshotIntervalMs?: number;
  hooks?: SimulationHooks;
  bridge?: BridgeOptions;
  /** `false`: no timer; the caller advances the simulation with `tick()`. */
  autoTick?: boolean;
};

export type SimulationStatus = {
  factoryId: string;
  tickMs: number;
  ticks: number;
  startedAt: string;
  /** Message of the last failed cycle, or null when the last cycle succeeded. */
  lastError: string | null;
  devices: DeviceSnapshot[];
};

export type SimulatorClock = { now: () => number; date: () => Date };

export const DEFAULT_TICK_MS = 100;
export const DEFAULT_SNAPSHOT_INTERVAL_MS = 10_000;
/** A late tick never advances the models by more than this, so a stall cannot cause a jump. */
const MAX_STEP_MS = 1000;

type Running = {
  factoryId: string;
  simulation: FactorySimulation;
  bridge: PlcBridge;
  hooks: SimulationHooks;
  tickMs: number;
  snapshotIntervalMs: number;
  timer: ReturnType<typeof setInterval> | undefined;
  inFlight: Promise<void> | undefined;
  lastTickAt: number;
  sinceSnapshotMs: number;
  ticks: number;
  startedAt: Date;
  lastError: string | null;
};

export class DeviceSimulatorRuntime {
  private readonly running = new Map<string, Running>();

  constructor(private readonly clock: SimulatorClock = { now: () => performance.now(), date: () => new Date() }) {}

  private require(factoryId: string): Running {
    const running = this.running.get(factoryId);
    if (!running) {
      throw new DomainError("CONFLICT", "The device simulation of this factory is not running.", {
        rule: "simulation-not-running",
      });
    }
    return running;
  }

  isRunning(factoryId: string): boolean {
    return this.running.has(factoryId);
  }

  /** Builds the factory's simulation and starts its tick. Throws when the configuration is invalid. */
  start(factoryId: string, options: StartOptions): void {
    if (this.running.has(factoryId)) {
      throw new DomainError("CONFLICT", "The device simulation of this factory is already running.", {
        rule: "simulation-running",
      });
    }
    const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    const running: Running = {
      factoryId,
      simulation: new FactorySimulation(options.config),
      bridge: new PlcBridge(options.bindings, options.plcs, { now: this.clock.now, ...options.bridge }),
      hooks: options.hooks ?? {},
      tickMs,
      snapshotIntervalMs: options.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS,
      timer: undefined,
      inFlight: undefined,
      lastTickAt: this.clock.now(),
      sinceSnapshotMs: 0,
      ticks: 0,
      startedAt: this.clock.date(),
      lastError: null,
    };
    this.running.set(factoryId, running);
    if (options.autoTick !== false) {
      running.timer = setInterval(() => void this.tick(factoryId), tickMs);
      // The simulation must not keep the server process alive on shutdown.
      running.timer.unref?.();
    }
  }

  /**
   * Stops the tick, waits for a cycle in flight, de-energizes the feedback the PLCs hold
   * and takes a final snapshot.
   */
  async stop(factoryId: string): Promise<DeviceSnapshot[]> {
    const running = this.require(factoryId);
    clearInterval(running.timer);
    this.running.delete(factoryId);
    await running.inFlight;
    await running.bridge.release();
    const devices = running.simulation.snapshot();
    await this.guard(running, () => running.hooks.onSnapshot?.(factoryId, devices, this.clock.date()));
    return devices;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((factoryId) => this.stop(factoryId)));
  }

  simulation(factoryId: string): FactorySimulation {
    return this.require(factoryId).simulation;
  }

  status(factoryId: string): SimulationStatus | null {
    const running = this.running.get(factoryId);
    if (!running) return null;
    return {
      factoryId,
      tickMs: running.tickMs,
      ticks: running.ticks,
      startedAt: running.startedAt.toISOString(),
      lastError: running.lastError,
      devices: running.simulation.snapshot(),
    };
  }

  /**
   * How the feedback a device writes into one PLC is doing (TASK-803): STALE while no
   * simulation of the factory runs (the PLC holds old or released values), DISCONNECTED
   * while the bridge cannot reach that PLC, BAD while the device's own signal is lost.
   */
  feedbackQuality(factoryId: string, deviceId: string, plcId: string): TagQuality {
    const running = this.running.get(factoryId);
    if (!running || !running.simulation.has(deviceId)) return "STALE";
    if (running.bridge.linkUp(plcId) === false) return "DISCONNECTED";
    return running.simulation.quality(deviceId) === "BAD" ? "BAD" : "GOOD";
  }

  /** A failing hook is recorded, never thrown: persistence trouble must not stop the simulation. */
  private async guard(running: Running, action: () => void | Promise<void> | undefined): Promise<void> {
    try {
      await action();
    } catch (error) {
      running.lastError = error instanceof Error ? error.message : "hook failed";
    }
  }

  private envelope(running: Running, event: SimEvent): RuntimeEventEnvelope {
    return {
      version: 1,
      id: randomUUID(),
      type: event.type,
      factoryId: running.factoryId,
      deviceId: event.deviceId,
      severity: event.severity,
      occurredAt: this.clock.date().toISOString(),
      payload: event.payload,
    };
  }

  /** Publishes events of this factory's simulation through its hooks. */
  async publish(factoryId: string, events: readonly SimEvent[]): Promise<RuntimeEventEnvelope[]> {
    const running = this.require(factoryId);
    const envelopes = events.map((event) => this.envelope(running, event));
    if (envelopes.length > 0) await running.hooks.onEvents?.(envelopes);
    return envelopes;
  }

  private async cycle(running: Running, dtMs: number | undefined): Promise<void> {
    const now = this.clock.now();
    const elapsedMs = dtMs ?? Math.min(Math.max(now - running.lastTickAt, 0), MAX_STEP_MS);
    running.lastTickAt = now;

    const { inputs, changes } = await running.bridge.readInputs();
    for (const [deviceId, signals] of inputs) running.simulation.setInputs(deviceId, signals);
    const events = running.simulation.step(elapsedMs / 1000);
    changes.push(...(await running.bridge.writeOutputs((deviceId) => running.simulation.outputs(deviceId))));
    running.ticks += 1;
    running.lastError = null;

    const linkEvents: SimEvent[] = changes.map((change: LinkChange) => ({
      type: change.up ? "CONNECTION_UP" : "CONNECTION_DOWN",
      deviceId: change.plcId,
      severity: change.up ? "INFO" : "WARNING",
      payload: { link: "device-simulator" },
    }));
    const envelopes = [...linkEvents, ...events].map((event) => this.envelope(running, event));
    if (envelopes.length > 0) await this.guard(running, () => running.hooks.onEvents?.(envelopes));

    running.sinceSnapshotMs += elapsedMs;
    if (running.sinceSnapshotMs >= running.snapshotIntervalMs) {
      running.sinceSnapshotMs = 0;
      const devices = running.simulation.snapshot();
      await this.guard(running, () => running.hooks.onSnapshot?.(running.factoryId, devices, this.clock.date()));
    }
  }

  /**
   * One cycle: read PLC outputs, advance the devices, write feedback, report changes.
   * A cycle that is still exchanging with a PLC makes the next timer tick a no-op.
   * `dtMs` fixes the simulated time step (tests); by default it is the real elapsed time.
   */
  async tick(factoryId: string, dtMs?: number): Promise<void> {
    const running = this.running.get(factoryId);
    if (!running || running.inFlight) return;
    running.inFlight = this.cycle(running, dtMs)
      .catch((error: unknown) => {
        running.lastError = error instanceof Error ? error.message : "simulation cycle failed";
      })
      .finally(() => {
        running.inFlight = undefined;
      });
    await running.inFlight;
  }
}

const globalRuntime = globalThis as typeof globalThis & { zfactoryDeviceSimulator?: DeviceSimulatorRuntime };

/** The shared simulator of this server process (kept across development reloads). */
export function getDeviceSimulator(): DeviceSimulatorRuntime {
  globalRuntime.zfactoryDeviceSimulator ??= new DeviceSimulatorRuntime();
  return globalRuntime.zfactoryDeviceSimulator;
}
