import "server-only";
import { z } from "zod";
import type { Actor } from "@/lib/auth/actor";
import { processBridgeRepository, type ProcessTagRecord } from "@/lib/db/repositories/process-bridge-repository";
import { type ModuleRecord, processModuleRepository } from "@/lib/db/repositories/process-module-repository";
import { DomainError } from "@/lib/domain/errors";
import type { NewRuntimeEvent } from "@/lib/domain/events";
import {
  checkProcessMappings,
  type ProcessMapping,
  type ProcessMappingIssue,
  type ProcessSignalTag,
  processFlow,
} from "@/lib/domain/process-bridge";
import {
  effectiveSignals,
  type ModuleIssueRule,
  type ModuleSignal,
  resolveModuleConfig,
} from "@/lib/domain/process-module";
import { PROCESS_SIM_CONTRACT_VERSION, PROCESS_SIM_MODELS, type ProcessSimConfig } from "@/lib/domain/process-sim";
import type { RuntimeState } from "@/lib/domain/runtime-state";
import type { EventBus } from "@/lib/events/bus";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { type ModbusEndpoint, readModbus, writeModbus, writeModbusRegisters } from "@/lib/protocols/modbus/client";
import type { PlcIo, SignalBinding } from "@/lib/runtimes/device-sim/bridge";
import type {
  ProcessBridgeRuntime,
  ProcessBridgeStatus,
  ProcessModulePlan,
} from "@/lib/runtimes/process-bridge/runtime";
import type { ProcessSimClient } from "@/lib/runtimes/process-sim/client";
import { toModuleTypeDefinition } from "@/lib/process-modules/ingest";
import { publishedModbusEndpoint } from "@/lib/runtimes/openplc/adapter";
import { recordEvents } from "./event-service";
import { getFactory } from "./factory-service";
import { toModuleDetail } from "./process-module-service";

/**
 * The process bridge of a factory (TASK-603, docs/process-simulation.md → Bridge): runs the
 * factory's process modules in the simulation service and keeps them in a closed loop
 * with the PLCs through the tags their signals are mapped to.
 *
 * Mappings are given to the service as `{ moduleId, signalKey, tagId }`; storing them
 * is the module I/O registry (TASK-605). Whatever supplies them, the rules of
 * `lib/domain/process-bridge.ts` decide whether the bridge accepts them, and a module
 * with a refused or missing required mapping does not start.
 */

export type ProcessBridgeDeps = {
  db: PrismaClient;
  bridge: ProcessBridgeRuntime;
  /** Null when `PROCESS_SIM_URL` is not configured: the bridge cannot start. */
  client: ProcessSimClient | null;
  /** Real time between exchanges, and the simulated time per model tick. */
  cycleMs?: number;
  tickMs?: number;
  snapshotIntervalMs?: number;
  bus?: EventBus;
};

export type ProcessMappingInput = { moduleId: string; signalKey: string; tagId: string };

const mappingSchema = z.array(
  z.strictObject({ moduleId: z.uuid(), signalKey: z.string().min(1).max(64), tagId: z.uuid() }),
);

/** What keeps a module from running: a mapping the rules refuse, or the module itself incomplete. */
export type ProcessBlockIssue = {
  rule: ProcessMappingIssue["rule"] | ModuleIssueRule;
  message: string;
  /** The signal the issue is about; null for an issue of the module itself. */
  signalKey: string | null;
};

export type ProcessBridgePlan = {
  modules: ProcessModulePlan[];
  plcs: Map<string, { name: string; endpoint: ModbusEndpoint | null; runtimeStatus: RuntimeState }>;
  /** Modules the bridge cannot run as they are, and what is wrong with each. */
  blocked: Array<{ moduleId: string; name: string; issues: ProcessBlockIssue[] }>;
  /** Modules of the factory the bridge leaves alone, and why. */
  skipped: Array<{ moduleId: string; name: string; reason: string }>;
};

export type ProcessBridgeState = { running: false } | ({ running: true } & ProcessBridgeStatus);

export const DEFAULT_PROCESS_TICK_MS = 100;

const notFound = (what: string) => new DomainError("NOT_FOUND", `The ${what} does not exist.`);

function toSignalTag(tag: ProcessTagRecord): ProcessSignalTag {
  return {
    id: tag.id,
    plcId: tag.plcInstanceId,
    name: tag.name,
    dataType: tag.dataType,
    role: tag.role,
    accessMode: tag.accessMode,
    logicalAddress: tag.logicalAddress,
    protocolArea: tag.protocolArea,
    protocolAddress: tag.protocolAddress,
    wordCount: tag.wordCount,
    byteOrder: tag.byteOrder,
    wordOrder: tag.wordOrder,
    scale: tag.scale,
    offset: tag.offset,
    unit: tag.unit,
    sourceDeviceInstanceId: tag.sourceDeviceInstanceId,
  };
}

/** The binding the PLC bridge carries for one accepted mapping. */
function toBinding(moduleId: string, signal: ModuleSignal, tag: ProcessSignalTag): SignalBinding {
  return {
    deviceId: moduleId,
    signal: signal.key,
    direction: processFlow(signal.direction) === "INTO_PROCESS" ? "IN" : "OUT",
    kind: signal.dataType === "BOOL" ? "BOOL" : "NUMBER",
    plcId: tag.plcId,
    tagName: tag.name,
    area: tag.protocolArea ?? "HOLDING_REGISTER",
    address: tag.protocolAddress ?? 0,
    wordCount: tag.wordCount,
    encoding: {
      dataType: tag.dataType,
      byteOrder: tag.byteOrder,
      wordOrder: tag.wordOrder,
      scale: tag.scale,
      offset: tag.offset,
    },
  };
}

/** The numeric settings of a module, read through its type; the model's other parameters keep their defaults. */
function modelParameters(record: ModuleRecord): Record<string, number> {
  const type = toModuleTypeDefinition(record.processModuleType);
  const stored = z.record(z.string(), z.unknown()).safeParse(record.configJson);
  const known = new Set(type.configFields.map((field) => field.key));
  const values = Object.fromEntries(
    Object.entries(stored.success ? stored.data : {}).filter(([key]) => known.has(key)),
  );
  return Object.fromEntries(
    Object.entries(resolveModuleConfig(type.configFields, values)).flatMap(([key, value]) =>
      typeof value === "number" ? [[key, value]] : typeof value === "boolean" ? [[key, value ? 1 : 0]] : [],
    ),
  );
}

/**
 * What the bridge would run for this factory with these mappings, from persisted
 * configuration only. A module whose type has no process model is skipped; a module that
 * is incomplete (a required role without a device), has a mapping the rules refuse, or a
 * required signal without one, is blocked.
 */
export async function planProcessBridge(
  db: PrismaClient,
  actor: Actor,
  factoryId: string,
  mappingInput: unknown,
  options: { tickMs?: number } = {},
): Promise<ProcessBridgePlan> {
  const factory = await getFactory(db, actor, factoryId);
  const parsed = mappingSchema.safeParse(mappingInput);
  if (!parsed.success) {
    throw new DomainError("VALIDATION", "Each mapping names a module, one of its signals and a tag.", {
      rule: "process-mapping-input",
    });
  }
  const mappings = parsed.data;
  const records = await processModuleRepository.listModules(db, factory.id);
  const tags = new Map(
    (
      await processBridgeRepository.findTags(db, factory.id, [...new Set(mappings.map((mapping) => mapping.tagId))])
    ).map((tag) => [tag.id, tag]),
  );
  const moduleIds = new Set(records.map((record) => record.id));
  const stray = mappings.find((mapping) => !moduleIds.has(mapping.moduleId));
  if (stray) throw notFound("process module");

  const plan: ProcessBridgePlan = { modules: [], plcs: new Map(), blocked: [], skipped: [] };
  const tickMs = options.tickMs ?? DEFAULT_PROCESS_TICK_MS;

  for (const record of records) {
    const type = toModuleTypeDefinition(record.processModuleType);
    const model = type.simulatorModelType ? PROCESS_SIM_MODELS[type.simulatorModelType] : undefined;
    if (!type.simulatorModelType || !model) {
      plan.skipped.push({
        moduleId: record.id,
        name: record.name,
        reason: `Module type ${type.code} v${type.version} has no process model.`,
      });
      continue;
    }
    const own = mappings.filter((mapping) => mapping.moduleId === record.id);
    const issues: ProcessBlockIssue[] = toModuleDetail(record).issues.map((issue) => ({
      rule: issue.rule,
      message: issue.message,
      signalKey: null,
    }));
    const resolved: ProcessMapping[] = [];
    for (const mapping of own) {
      const tag = tags.get(mapping.tagId);
      if (!tag) {
        // Not found, or a tag of another factory: the module cannot be wired to it either way.
        issues.push({
          rule: "modbus-mapping",
          signalKey: mapping.signalKey,
          message: "The tag does not exist in this factory.",
        });
        continue;
      }
      resolved.push({ signalKey: mapping.signalKey, tag: toSignalTag(tag) });
    }
    const signals = effectiveSignals(type.signals, record.profile);
    issues.push(...checkProcessMappings(type.signals, resolved, { profile: record.profile }));
    if (issues.length > 0) {
      plan.blocked.push({ moduleId: record.id, name: record.name, issues });
      continue;
    }

    const bindings: SignalBinding[] = [];
    for (const mapping of resolved) {
      const signal = signals.find((candidate) => candidate.key === mapping.signalKey);
      if (!signal) continue;
      bindings.push(toBinding(record.id, signal, mapping.tag));
      const tag = tags.get(mapping.tag.id);
      const plc = tag?.plc.deviceInstance;
      if (plc && !plan.plcs.has(plc.id)) {
        const port = plc.runtimePorts.find((candidate) => candidate.protocol === "MODBUS_TCP" && candidate.hostPort);
        plan.plcs.set(plc.id, {
          name: plc.name,
          endpoint: port?.hostPort ? publishedModbusEndpoint(port.bindAddress, port.hostPort) : null,
          runtimeStatus: plc.runtimeStatus,
        });
      }
    }
    const config: ProcessSimConfig = {
      contractVersion: PROCESS_SIM_CONTRACT_VERSION,
      instanceId: record.id,
      factoryId: factory.id,
      moduleType: type.code,
      modelType: model.modelType,
      modelVersion: model.modelVersion,
      // The module's settings are its configuration; a change to them is a reload, not a version.
      configVersion: 1,
      tickMs,
      clock: "manual",
      parameters: modelParameters(record),
    };
    plan.modules.push({ moduleId: record.id, name: record.name, config, signals, bindings });
  }
  return plan;
}

function modbusIo(endpoint: ModbusEndpoint): PlcIo {
  return {
    read: (area, address, count) => readModbus(endpoint, area, address, count),
    writeCoil: (address, value) => writeModbus(endpoint, "COIL", address, value),
    writeRegisters: (address, words) => writeModbusRegisters(endpoint, address, words),
  };
}

/** Why this plan cannot be started, if anything stands in the way. */
function startBlocker(plan: ProcessBridgePlan): DomainError | undefined {
  if (plan.blocked.length > 0) {
    const [first] = plan.blocked;
    return new DomainError(
      "VALIDATION",
      `${first!.name} cannot run: ${first!.issues.map((issue) => issue.message).join(" ")}`,
      {
        rule: "process-mapping",
        modules: plan.blocked.map((module) => ({
          moduleId: module.moduleId,
          name: module.name,
          issues: module.issues.map((issue) => ({ rule: issue.rule, signal: issue.signalKey, message: issue.message })),
        })),
      },
    );
  }
  if (plan.modules.length === 0) {
    return new DomainError("CONFLICT", "This factory has no process module the bridge can run.", {
      rule: "nothing-to-bridge",
    });
  }
  for (const [plcId, plc] of plan.plcs) {
    if (!plc.endpoint) {
      return new DomainError("CONFLICT", `Start ${plc.name} first: its Modbus endpoint is not configured yet.`, {
        rule: "plc-endpoint-required",
        plcId,
      });
    }
  }
  return undefined;
}

async function recordFactoryEvent(deps: ProcessBridgeDeps, event: NewRuntimeEvent): Promise<void> {
  await recordEvents(deps, [event]);
}

/**
 * Starts the process bridge of a factory: loads every module with a process model into
 * the simulation service and begins the closed loop with the PLCs. Every PLC a module is
 * mapped to must have its Modbus endpoint configured (it is, once the PLC has been
 * started); a PLC that is not running drives nothing until it comes up.
 */
export async function startProcessBridge(
  deps: ProcessBridgeDeps,
  actor: Actor,
  factoryId: string,
  mappings: unknown,
  options: { autoTick?: boolean } = {},
): Promise<ProcessBridgeState & { skipped: ProcessBridgePlan["skipped"] }> {
  if (!deps.client) {
    throw new DomainError("CONFLICT", "The process simulation service is not configured (PROCESS_SIM_URL).", {
      rule: "process-sim-not-configured",
    });
  }
  const plan = await planProcessBridge(deps.db, actor, factoryId, mappings, { tickMs: deps.tickMs });
  if (deps.bridge.isRunning(factoryId)) {
    throw new DomainError("CONFLICT", "The process bridge of this factory is already running.", {
      rule: "process-bridge-running",
    });
  }
  const blocked = startBlocker(plan);
  if (blocked) throw blocked;
  const plcs = new Map<string, PlcIo>();
  for (const [plcId, plc] of plan.plcs) {
    if (plc.endpoint) plcs.set(plcId, modbusIo(plc.endpoint));
  }

  await deps.bridge.start(factoryId, {
    modules: plan.modules,
    plcs,
    client: deps.client,
    cycleMs: deps.cycleMs,
    snapshotIntervalMs: deps.snapshotIntervalMs,
    autoTick: options.autoTick,
    hooks: {
      onEvents: async (events) => {
        await recordEvents(deps, events);
      },
    },
  });

  const moduleIds = plan.modules.map((module) => module.moduleId);
  await processBridgeRepository.setModuleStatus(deps.db, moduleIds, "RUNNING");
  await recordFactoryEvent(deps, {
    type: "PROCESS_BRIDGE_STARTED",
    factoryId,
    deviceId: null,
    payload: {
      modules: moduleIds.length,
      signals: plan.modules.reduce((sum, module) => sum + module.bindings.length, 0),
      plcs: plcs.size,
    },
  });
  return { ...(await getProcessBridgeState(deps, actor, factoryId)), skipped: plan.skipped };
}

/** Stops the bridge and unloads the models; the modules are marked stopped. */
export async function stopProcessBridge(deps: ProcessBridgeDeps, actor: Actor, factoryId: string): Promise<void> {
  await getFactory(deps.db, actor, factoryId);
  const modules = await deps.bridge.stop(factoryId);
  await processBridgeRepository.setModuleStatus(
    deps.db,
    modules.map((module) => module.moduleId),
    "STOPPED",
  );
  await recordFactoryEvent(deps, {
    type: "PROCESS_BRIDGE_STOPPED",
    factoryId,
    deviceId: null,
    payload: { modules: modules.length },
  });
}

/** Live module states, straight from bridge memory. */
export async function getProcessBridgeState(
  deps: ProcessBridgeDeps,
  actor: Actor,
  factoryId: string,
): Promise<ProcessBridgeState> {
  await getFactory(deps.db, actor, factoryId);
  const status = deps.bridge.status(factoryId);
  return status ? { running: true, ...status } : { running: false };
}
