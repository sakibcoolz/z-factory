import "server-only";
import { randomUUID } from "node:crypto";
import { DomainError, isDomainError } from "@/lib/domain/errors";
import type { EventSeverity, RuntimeEventEnvelope } from "@/lib/domain/events";
import { fromModelValue, type ProcessQuality, toModelValue } from "@/lib/domain/process-bridge";
import type { ModuleSignal } from "@/lib/domain/process-module";
import type {
  ProcessSimConfig,
  ProcessSimSignalState,
  ProcessSimSnapshot,
  ProcessSimStatus,
} from "@/lib/domain/process-sim";
import { type BridgeOptions, PlcBridge, type PlcIo, type SignalBinding } from "@/lib/runtimes/device-sim/bridge";
import type { TagQuality } from "@/lib/domain/tag";
import type { Signals } from "@/lib/runtimes/device-sim/engine";
import type { ProcessSimClient } from "@/lib/runtimes/process-sim/client";

/**
 * The process bridge of a factory (TASK-603, docs/process-simulation.md → Bridge): the
 * closed loop between the process models running in the simulation service and the PLCs.
 * Every cycle it reads the tags PLC logic drives, hands them to the models as inputs,
 * advances the models by exactly one cycle of simulated time, and writes what they
 * produce back into the PLCs as feedback. The models' clocks are manual: the bridge is
 * the only thing that advances them, so a slow or missing exchange never lets a model run
 * ahead of the PLC it is wired to.
 *
 * One instance hosts the bridges of many factories inside the server process. Live
 * state exists here only; events and snapshots are persisted through hooks.
 */

/** `payload.link` of the connection events the process bridge records. */
export const PROCESS_BRIDGE_LINK = "process-bridge";

export type ProcessModulePlan = {
  moduleId: string;
  name: string;
  /** What the service loads; `clock` is forced to manual. */
  config: ProcessSimConfig;
  /** The module type's signals in the module's profile; ALARM signals become alarms. */
  signals: readonly ModuleSignal[];
  /** The module's mapped signals, with `deviceId` set to the module id. */
  bindings: readonly SignalBinding[];
};

export type ProcessModuleSnapshot = {
  moduleId: string;
  name: string;
  /** The service's status of the instance; UNAVAILABLE while the service cannot be reached. */
  status: ProcessSimStatus | "UNAVAILABLE";
  quality: ProcessQuality;
  tick: number;
  timeS: number;
  inputs: Record<string, number>;
  outputs: Record<string, number>;
  /** Keys of the ALARM signals that are active. */
  alarms: string[];
  /** Measured outputs a test has overridden (Phase 08); `outputs` carry their effective values. */
  overrides: ProcessSimSignalState[];
  /** The PLCs the module exchanges with and whether each answered last. */
  plcs: Array<{ plcId: string; up: boolean | null }>;
  /** Why the last exchange with the service failed, or null. */
  error: string | null;
};

export type ProcessBridgeHooks = {
  onEvents?: (events: RuntimeEventEnvelope[]) => void | Promise<void>;
  onSnapshot?: (factoryId: string, modules: ProcessModuleSnapshot[], capturedAt: Date) => void | Promise<void>;
};

export type ProcessBridgeStartOptions = {
  modules: readonly ProcessModulePlan[];
  plcs: ReadonlyMap<string, PlcIo>;
  client: ProcessSimClient;
  /** Real time between exchanges; each advances the models by the same simulated time. */
  cycleMs?: number;
  snapshotIntervalMs?: number;
  hooks?: ProcessBridgeHooks;
  bridge?: BridgeOptions;
  /** `false`: no timer; the caller advances the bridge with `tick()`. */
  autoTick?: boolean;
};

export type ProcessBridgeStatus = {
  factoryId: string;
  cycleMs: number;
  cycles: number;
  startedAt: string;
  lastError: string | null;
  modules: ProcessModuleSnapshot[];
};

export const DEFAULT_CYCLE_MS = 200;
export const DEFAULT_SNAPSHOT_INTERVAL_MS = 10_000;

type ModuleState = {
  plan: ProcessModulePlan;
  /** Simulated ticks per cycle, so one cycle is one `cycleMs` of model time. */
  ticks: number;
  plcIds: string[];
  alarmSignals: ModuleSignal[];
  lastInputs: string | undefined;
  snapshot: ProcessSimSnapshot | undefined;
  quality: ProcessQuality;
  activeAlarms: Set<string>;
  eventSeq: number;
  error: string | null;
  /** The service forgot the instance (it restarted): load it again before the next step. */
  reload: boolean;
};

type Running = {
  factoryId: string;
  client: ProcessSimClient;
  bridge: PlcBridge;
  modules: ModuleState[];
  links: Map<string, boolean | null>;
  hooks: ProcessBridgeHooks;
  cycleMs: number;
  snapshotIntervalMs: number;
  timer: ReturnType<typeof setInterval> | undefined;
  inFlight: Promise<void> | undefined;
  sinceSnapshotMs: number;
  cycles: number;
  startedAt: Date;
  lastError: string | null;
};

type Clock = { date: () => Date; now: () => number };

type NewEvent = {
  type: string;
  deviceId: string | null;
  severity: EventSeverity;
  payload: Record<string, unknown>;
};

const message = (error: unknown) => (error instanceof Error ? error.message : "process simulation failed");

export class ProcessBridgeRuntime {
  private readonly running = new Map<string, Running>();

  constructor(private readonly clock: Clock = { now: () => performance.now(), date: () => new Date() }) {}

  private require(factoryId: string): Running {
    const running = this.running.get(factoryId);
    if (!running) {
      throw new DomainError("CONFLICT", "The process bridge of this factory is not running.", {
        rule: "process-bridge-not-running",
      });
    }
    return running;
  }

  isRunning(factoryId: string): boolean {
    return this.running.has(factoryId);
  }

  /**
   * Loads every module into the service and starts the cycle. When a module cannot be
   * loaded, the ones loaded before it are unloaded again and the error is thrown.
   */
  async start(factoryId: string, options: ProcessBridgeStartOptions): Promise<void> {
    if (this.running.has(factoryId)) {
      throw new DomainError("CONFLICT", "The process bridge of this factory is already running.", {
        rule: "process-bridge-running",
      });
    }
    const cycleMs = options.cycleMs ?? DEFAULT_CYCLE_MS;
    const modules = options.modules.map((plan) => toState(plan, cycleMs));

    const loaded: string[] = [];
    try {
      for (const state of modules) {
        await load(options.client, state);
        loaded.push(state.plan.moduleId);
      }
    } catch (error) {
      await Promise.all(loaded.map((id) => options.client.unload(id).catch(() => undefined)));
      throw error;
    }

    const running: Running = {
      factoryId,
      client: options.client,
      bridge: new PlcBridge(
        modules.flatMap((state) => state.plan.bindings),
        options.plcs,
        { now: this.clock.now, ...options.bridge },
      ),
      modules,
      links: new Map([...options.plcs.keys()].map((plcId) => [plcId, null])),
      hooks: options.hooks ?? {},
      cycleMs,
      snapshotIntervalMs: options.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS,
      timer: undefined,
      inFlight: undefined,
      sinceSnapshotMs: 0,
      cycles: 0,
      startedAt: this.clock.date(),
      lastError: null,
    };
    this.running.set(factoryId, running);
    if (options.autoTick !== false) {
      running.timer = setInterval(() => void this.tick(factoryId), cycleMs);
      // The bridge must not keep the server process alive on shutdown.
      running.timer.unref?.();
    }
  }

  /**
   * Stops the cycle, waits for an exchange in flight, de-energizes the feedback the PLCs
   * hold, unloads the models and takes a final snapshot.
   */
  async stop(factoryId: string): Promise<ProcessModuleSnapshot[]> {
    const running = this.require(factoryId);
    clearInterval(running.timer);
    this.running.delete(factoryId);
    await running.inFlight;
    await running.bridge.release();
    const modules = running.modules.map((state) => toSnapshot(running, state));
    // The service may be gone; the bridge is stopped either way.
    await Promise.all(
      running.modules.map((state) => running.client.unload(state.plan.moduleId).catch(() => undefined)),
    );
    await this.guard(running, () => running.hooks.onSnapshot?.(factoryId, modules, this.clock.date()));
    return modules;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((factoryId) => this.stop(factoryId)));
  }

  status(factoryId: string): ProcessBridgeStatus | null {
    const running = this.running.get(factoryId);
    if (!running) return null;
    return {
      factoryId,
      cycleMs: running.cycleMs,
      cycles: running.cycles,
      startedAt: running.startedAt.toISOString(),
      lastError: running.lastError,
      modules: running.modules.map((state) => toSnapshot(running, state)),
    };
  }

  /**
   * How the feedback a module writes into its PLCs is doing (TASK-803): the module's quality
   * while the bridge runs, STALE when it does not (the PLC holds old or released values).
   */
  feedbackQuality(factoryId: string, moduleId: string): TagQuality {
    const state = this.running.get(factoryId)?.modules.find((candidate) => candidate.plan.moduleId === moduleId);
    return state ? state.quality : "STALE";
  }

  /** A failing hook is recorded, never thrown: persistence trouble must not stop the loop. */
  private async guard(running: Running, action: () => void | Promise<void> | undefined): Promise<void> {
    try {
      await action();
    } catch (error) {
      running.lastError = message(error);
    }
  }

  private envelope(running: Running, event: NewEvent): RuntimeEventEnvelope {
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

  /** One module's exchange with the service: inputs in, one cycle of time, outputs out. */
  private async advance(running: Running, state: ModuleState, inputs: Signals, events: NewEvent[]): Promise<void> {
    const { client } = running;
    const id = state.plan.moduleId;
    const values = Object.fromEntries(
      state.plan.bindings
        .filter((binding) => binding.direction === "IN")
        .map((binding) => [binding.signal, toModelValue(inputs[binding.signal])]),
    );
    const serialized = JSON.stringify(values);
    try {
      if (state.reload) {
        await load(client, state);
        state.reload = false;
        state.lastInputs = undefined;
      }
      if (serialized !== state.lastInputs) {
        await client.setInputs(id, values);
        state.lastInputs = serialized;
      }
      state.snapshot = await client.step(id, state.ticks);
      state.error = null;
    } catch (error) {
      state.error = message(error);
      // The service restarted and knows nothing of the instance: bring it back next cycle.
      if (isDomainError(error, "NOT_FOUND")) state.reload = true;
      return;
    }

    const subject = { module: state.plan.name, moduleId: id };
    for (const signal of state.alarmSignals) {
      const active = fromModelValue(state.snapshot.outputs[signal.key], "BOOL") === true;
      if (active === state.activeAlarms.has(signal.key)) continue;
      if (active) state.activeAlarms.add(signal.key);
      else state.activeAlarms.delete(signal.key);
      events.push({
        type: active ? "PROCESS_ALARM_RAISED" : "PROCESS_ALARM_CLEARED",
        deviceId: null,
        severity: active ? "WARNING" : "INFO",
        payload: { ...subject, code: signal.key, name: signal.name, tick: state.snapshot.tick },
      });
    }

    if (state.snapshot.lastEventSeq > state.eventSeq) {
      try {
        const fresh = await client.events(id, state.eventSeq);
        for (const event of fresh) {
          state.eventSeq = Math.max(state.eventSeq, event.seq);
          // Alarms are derived from the ALARM signals above; the model's own alarm events would repeat them.
          if (event.type === "ALARM_RAISED" || event.type === "ALARM_CLEARED") continue;
          events.push({
            type: "PROCESS_STATE_CHANGED",
            deviceId: null,
            severity: "INFO",
            payload: {
              ...subject,
              event: event.type,
              message: event.message,
              tick: event.tick,
              ...(event.values ? { values: event.values } : {}),
            },
          });
        }
      } catch (error) {
        state.error = message(error);
      }
    }
  }

  private async cycle(running: Running): Promise<void> {
    const events: NewEvent[] = [];
    const { inputs, changes } = await running.bridge.readInputs();
    await Promise.all(
      running.modules.map((state) => this.advance(running, state, inputs.get(state.plan.moduleId) ?? {}, events)),
    );
    changes.push(
      ...(await running.bridge.writeOutputs((moduleId) => {
        const state = running.modules.find((candidate) => candidate.plan.moduleId === moduleId);
        if (!state?.snapshot) return {};
        return Object.fromEntries(
          state.plan.bindings
            .filter((binding) => binding.direction === "OUT")
            .map((binding) => [
              binding.signal,
              fromModelValue(state.snapshot?.outputs[binding.signal], binding.kind === "BOOL" ? "BOOL" : "FLOAT32"),
            ]),
        );
      })),
    );
    running.cycles += 1;
    running.lastError = null;

    for (const change of changes) {
      running.links.set(change.plcId, change.up);
      events.unshift({
        type: change.up ? "CONNECTION_UP" : "CONNECTION_DOWN",
        deviceId: change.plcId,
        severity: change.up ? "INFO" : "WARNING",
        payload: { link: PROCESS_BRIDGE_LINK },
      });
    }
    for (const state of running.modules) {
      const quality = qualityOf(running, state);
      if (quality === state.quality) continue;
      events.push({
        type: "PROCESS_QUALITY_CHANGED",
        deviceId: null,
        severity: quality === "GOOD" ? "INFO" : "WARNING",
        payload: {
          module: state.plan.name,
          moduleId: state.plan.moduleId,
          from: state.quality,
          to: quality,
          ...(state.error ? { message: state.error } : {}),
        },
      });
      state.quality = quality;
    }

    const envelopes = events.map((event) => this.envelope(running, event));
    if (envelopes.length > 0) await this.guard(running, () => running.hooks.onEvents?.(envelopes));

    running.sinceSnapshotMs += running.cycleMs;
    if (running.sinceSnapshotMs >= running.snapshotIntervalMs) {
      running.sinceSnapshotMs = 0;
      const modules = running.modules.map((state) => toSnapshot(running, state));
      await this.guard(running, () => running.hooks.onSnapshot?.(running.factoryId, modules, this.clock.date()));
    }
  }

  /**
   * One cycle: read what the PLCs drive, advance the models by one cycle of simulated time,
   * write their feedback, report what changed. A cycle still in flight makes the next
   * timer tick a no-op; simulated time then simply waits for the exchange.
   */
  async tick(factoryId: string): Promise<void> {
    const running = this.running.get(factoryId);
    if (!running || running.inFlight) return;
    running.inFlight = this.cycle(running)
      .catch((error: unknown) => {
        running.lastError = message(error);
      })
      .finally(() => {
        running.inFlight = undefined;
      });
    await running.inFlight;
  }
}

function toState(plan: ProcessModulePlan, cycleMs: number): ModuleState {
  return {
    plan,
    ticks: Math.max(1, Math.round(cycleMs / plan.config.tickMs)),
    plcIds: [...new Set(plan.bindings.map((binding) => binding.plcId))],
    alarmSignals: plan.signals.filter((signal) => signal.direction === "ALARM"),
    lastInputs: undefined,
    snapshot: undefined,
    quality: "GOOD",
    activeAlarms: new Set(),
    eventSeq: 0,
    error: null,
    reload: false,
  };
}

/** Loads a module's model with a manual clock and starts it; what it was before is replaced. */
async function load(client: ProcessSimClient, state: ModuleState): Promise<void> {
  const snapshot = await client.load({ ...state.plan.config, clock: "manual" });
  state.eventSeq = snapshot.lastEventSeq;
  state.snapshot = await client.start(state.plan.moduleId);
}

/**
 * STALE while the service could not advance the model (its values are from an earlier
 * cycle), DISCONNECTED while a PLC the module exchanges with does not answer (the PLC gets
 * no feedback and its commands count as de-energized), GOOD otherwise.
 */
function qualityOf(running: Running, state: ModuleState): ProcessQuality {
  if (state.error !== null || !state.snapshot) return "STALE";
  if (state.plcIds.some((plcId) => running.links.get(plcId) === false)) return "DISCONNECTED";
  return "GOOD";
}

function toSnapshot(running: Running, state: ModuleState): ProcessModuleSnapshot {
  return {
    moduleId: state.plan.moduleId,
    name: state.plan.name,
    status: state.snapshot && state.error === null ? state.snapshot.status : "UNAVAILABLE",
    quality: state.quality,
    tick: state.snapshot?.tick ?? 0,
    timeS: state.snapshot?.timeS ?? 0,
    inputs: state.snapshot?.inputs ?? {},
    outputs: state.snapshot?.outputs ?? {},
    alarms: [...state.activeAlarms].sort(),
    overrides: state.snapshot?.overrides ?? [],
    plcs: state.plcIds.map((plcId) => ({ plcId, up: running.links.get(plcId) ?? null })),
    error: state.error,
  };
}

const globalRuntime = globalThis as typeof globalThis & { zfactoryProcessBridge?: ProcessBridgeRuntime };

/** The shared process bridge of this server process (kept across development reloads). */
export function getProcessBridge(): ProcessBridgeRuntime {
  globalRuntime.zfactoryProcessBridge ??= new ProcessBridgeRuntime();
  return globalRuntime.zfactoryProcessBridge;
}
