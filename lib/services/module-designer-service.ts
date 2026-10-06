import "server-only";
import type { Actor } from "@/lib/auth/actor";
import { plcConfigRepository } from "@/lib/db/repositories/plc-config-repository";
import type { ModuleDesignerView, ModuleRuntimeView, ModulesScreenView } from "@/lib/domain/module-designer-view";
import type { ModuleIoRegistry } from "@/lib/domain/module-io-view";
import { type ModuleSignal, roleAcceptsCategory } from "@/lib/domain/process-module";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { getFactory } from "./factory-service";
import { getModuleIoRegistry, listBindableTags } from "./module-io-service";
import { getProcessBridgeState, listProcessOverrides, type ProcessBridgeDeps } from "./process-bridge-service";
import { getModule, getModuleType, listModules, listModuleTypes } from "./process-module-service";

/**
 * The process-module screens (TASK-604): everything a module's page shows, read from the
 * module service, the I/O registry and the running bridge. The screen never decides on
 * its own what fits: candidates and assignable devices come with the services' refusals.
 */

/** The module list of a factory and the types a new module can be created from. */
export async function getModulesScreen(db: PrismaClient, actor: Actor, factoryId: string): Promise<ModulesScreenView> {
  const factory = await getFactory(db, actor, factoryId);
  const [modules, summaries] = await Promise.all([listModules(db, actor, factory.id), listModuleTypes(db)]);
  const types = await Promise.all(summaries.filter((type) => type.latest).map((type) => getModuleType(db, type.id)));
  return {
    factory: { id: factory.id, name: factory.name },
    modules: await Promise.all(modules.map((summary) => getModule(db, actor, summary.id))),
    types,
  };
}

async function runtimeOf(process: ProcessBridgeDeps | null, actor: Actor, factoryId: string, moduleId: string) {
  const serviceNote = process?.client
    ? null
    : "The process simulation service is not configured (PROCESS_SIM_URL); the module cannot run.";
  const empty: ModuleRuntimeView = {
    bridgeRunning: false,
    status: null,
    quality: null,
    tick: 0,
    timeS: 0,
    inputs: {},
    outputs: {},
    alarms: [],
    plcs: [],
    error: null,
    serviceNote,
    testInputs: [],
  };
  if (!process) return empty;
  const state = await getProcessBridgeState(process, actor, factoryId);
  if (!state.running) return empty;
  const snapshot = state.modules.find((candidate) => candidate.moduleId === moduleId);
  if (!snapshot) return { ...empty, bridgeRunning: true };
  return {
    bridgeRunning: true,
    status: snapshot.status,
    quality: snapshot.quality,
    tick: snapshot.tick,
    timeS: snapshot.timeS,
    inputs: snapshot.inputs,
    outputs: snapshot.outputs,
    alarms: snapshot.alarms,
    plcs: snapshot.plcs,
    error: snapshot.error,
    serviceNote,
    testInputs: [],
  };
}

/** The measured values of a running module that the PLC reads, with their mode and values (TASK-802). */
async function withTestInputs(
  runtime: ModuleRuntimeView,
  process: ProcessBridgeDeps | null,
  actor: Actor,
  moduleId: string,
  signals: readonly ModuleSignal[],
  registry: ModuleIoRegistry,
): Promise<ModuleRuntimeView> {
  if (!process || !runtime.bridgeRunning || runtime.status === null) return runtime;
  const states = await listProcessOverrides(process, actor, moduleId).catch(() => []);
  const testInputs = states.flatMap((state) => {
    const signal = signals.find((candidate) => candidate.key === state.signal && candidate.direction === "INPUT");
    if (!signal) return [];
    const binding = registry.rows.find((row) => row.signal.key === signal.key)?.binding ?? null;
    return [
      {
        signal: state.signal,
        name: signal.name,
        unit: state.unit || signal.unit || "",
        bool: state.bool,
        min: state.min,
        max: state.max,
        mode: state.mode,
        calculated: state.calculated,
        effective: state.effective,
        value: state.value ?? null,
        profile: state.profile ?? null,
        sinceTimeS: state.sinceTimeS,
        source: state.source ?? null,
        tag: binding ? `${binding.plcName} · ${binding.tagName}` : null,
      },
    ];
  });
  return { ...runtime, testInputs };
}

/** One module's screen: detail, type, registry with candidates, assignable devices, PLC nodes and live state. */
export async function getModuleDesigner(
  db: PrismaClient,
  actor: Actor,
  moduleId: string,
  process: ProcessBridgeDeps | null,
): Promise<ModuleDesignerView> {
  const detail = await getModule(db, actor, moduleId);
  const [factory, type, registry, devices] = await Promise.all([
    getFactory(db, actor, detail.factoryId),
    getModuleType(db, detail.type.id),
    getModuleIoRegistry(db, actor, moduleId),
    plcConfigRepository.listFactoryDevices(db, detail.factoryId),
  ]);

  const candidates: ModuleDesignerView["candidates"] = {};
  for (const row of registry.rows) {
    candidates[row.signal.key] = await listBindableTags(db, actor, moduleId, row.signal.key);
  }

  const assignable: ModuleDesignerView["assignable"] = {};
  for (const role of detail.roles) {
    const taken = new Set(role.devices.map((device) => device.deviceId));
    assignable[role.key] = devices
      .filter((device) => !taken.has(device.id) && roleAcceptsCategory(role, device.deviceModel.family.category.code))
      .map((device) => ({
        deviceId: device.id,
        name: device.name,
        categoryCode: device.deviceModel.family.category.code,
        categoryName: device.deviceModel.family.category.name,
        modelName: device.deviceModel.modelName,
      }));
  }

  const plcs = devices
    .filter((device) => device.deviceModel.architectureType !== null)
    .map((plc) => ({
      plcId: plc.id,
      name: plc.name,
      signals: registry.rows.filter((row) => row.state === "BOUND" && row.binding?.plcId === plc.id).length,
    }));

  return {
    factory: { id: factory.id, name: factory.name },
    module: detail,
    type,
    registry,
    candidates,
    assignable,
    plcs,
    runtime: await withTestInputs(
      await runtimeOf(process, actor, detail.factoryId, moduleId),
      process,
      actor,
      moduleId,
      detail.signals,
      registry,
    ),
  };
}
