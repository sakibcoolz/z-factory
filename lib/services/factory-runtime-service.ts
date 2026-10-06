import "server-only";
import type { Actor } from "@/lib/auth/actor";
import { DomainError, isDomainError } from "@/lib/domain/errors";
import type { RuntimeState } from "@/lib/domain/runtime-state";
import { getFactory } from "./factory-service";
import { type GatewayDeps, syncGatewayEndpoints } from "./gateway-service";
import { type LiveDeps, stopPlcMonitoring, syncFactoryMonitoring } from "./live-service";
import { type PlcLinkDeps, startPlcLinkMonitor, stopPlcLinkMonitor } from "./plc-communication-service";
import { type RuntimeDeps, startPlc, stopPlc } from "./plc-runtime-service";
import {
  getProcessBridgeState,
  planProcessBridge,
  type ProcessBridgeDeps,
  startProcessBridge,
  stopProcessBridge,
} from "./process-bridge-service";
import {
  getSimulationState,
  type SimulationDeps,
  startFactorySimulation,
  stopFactorySimulation,
} from "./simulation-service";

/**
 * The lifecycle of a factory as a whole (TASK-502): start brings up every PLC runtime,
 * then the device simulation, then the gateway endpoints; stop takes them down in the
 * reverse order. Each part is the same operation its own screen offers, in the order a
 * plant is started: controllers first, then the field, then the outside world.
 */

export type FactoryRuntimeDeps = {
  runtime: RuntimeDeps;
  simulation: SimulationDeps;
  live: LiveDeps;
  gateway: GatewayDeps;
  /** The process bridge (TASK-603): started after the simulation, from the module I/O registry (TASK-605). */
  process?: ProcessBridgeDeps;
  /** The PLC-to-PLC link monitor (TASK-703): watching starts with the PLCs and stops with them. */
  links?: PlcLinkDeps;
};

export type FactoryRuntimeResult = {
  plcs: Array<{ id: string; name: string; state: RuntimeState }>;
  /** Simulated devices that are running; 0 when the simulation is not. */
  simulatedDevices: number;
  /** Why the simulation did not start, when it did not. */
  simulationNote: string | null;
  /** Process modules running in the bridge; 0 when it is not. */
  processModules: number;
  /** Why the process bridge did not start, when the factory has modules it should run. */
  processNote: string | null;
};

async function listPlcs(deps: FactoryRuntimeDeps, factoryId: string) {
  return deps.runtime.db.deviceInstance.findMany({
    where: { factoryId, plcProfile: { isNot: null } },
    orderBy: { name: "asc" },
    select: { id: true, name: true, runtimeStatus: true, dockerContainerId: true },
  });
}

/**
 * Starts the process bridge when the factory has modules it should run: a factory without
 * modules bound to its PLCs, or without the simulation service, has nothing to start and
 * nothing to report. A module the plan blocks is reported, not skipped silently.
 */
async function startProcess(
  deps: FactoryRuntimeDeps,
  actor: Actor,
  factoryId: string,
): Promise<Pick<FactoryRuntimeResult, "processModules" | "processNote">> {
  const process = deps.process;
  if (!process) return { processModules: 0, processNote: null };
  try {
    if (process.bridge.isRunning(factoryId)) {
      const state = await getProcessBridgeState(process, actor, factoryId);
      return { processModules: state.running ? state.modules.length : 0, processNote: null };
    }
    const plan = await planProcessBridge(process.db, actor, factoryId, undefined, { tickMs: process.tickMs });
    if (plan.modules.length === 0 && plan.blocked.length === 0) return { processModules: 0, processNote: null };
    if (!process.client) {
      return { processModules: 0, processNote: "The process simulation service is not configured (PROCESS_SIM_URL)." };
    }
    const state = await startProcessBridge(process, actor, factoryId);
    return { processModules: state.running ? state.modules.length : 0, processNote: null };
  } catch (error) {
    if (!isDomainError(error)) throw error;
    return { processModules: 0, processNote: error.message };
  }
}

/**
 * Starts the factory. A PLC that already runs is left alone. A PLC that does not start
 * stops the sequence: the field is not simulated against a controller that is missing.
 */
export async function startFactory(
  deps: FactoryRuntimeDeps,
  actor: Actor,
  factoryId: string,
): Promise<FactoryRuntimeResult> {
  const factory = await getFactory(deps.runtime.db, actor, factoryId);
  const plcs = await listPlcs(deps, factory.id);
  if (plcs.length === 0) {
    throw new DomainError("CONFLICT", "This factory has no PLC to start.", { rule: "factory-plc-required" });
  }

  const started: FactoryRuntimeResult["plcs"] = [];
  try {
    for (const plc of plcs) {
      const state = plc.runtimeStatus === "RUNNING" ? "RUNNING" : (await startPlc(deps.runtime, actor, plc.id)).state;
      started.push({ id: plc.id, name: plc.name, state });
    }
  } finally {
    // Whatever was started is read for live values, also when a later PLC failed.
    await syncFactoryMonitoring(deps.live, factory.id);
    // The links run in the PLCs' own runtimes; Z-Factory watches them.
    if (deps.links) startPlcLinkMonitor(deps.links, factory.id);
  }

  let simulatedDevices = 0;
  let simulationNote: string | null = null;
  try {
    const state = deps.simulation.simulator.isRunning(factory.id)
      ? await getSimulationState(deps.simulation, actor, factory.id)
      : await startFactorySimulation(deps.simulation, actor, factory.id);
    simulatedDevices = state.running ? state.devices.length : 0;
  } catch (error) {
    // A factory without simulated devices, or with wiring the simulator refuses, still has its PLCs running.
    if (!isDomainError(error)) throw error;
    simulationNote = error.message;
  }
  const process = await startProcess(deps, actor, factory.id);
  await syncGatewayEndpoints(deps.gateway, factory.id);
  return { plcs: started, simulatedDevices, simulationNote, ...process };
}

/**
 * Stops the factory: the process bridge and the simulation first, so the last states are
 * stored while the PLCs still answer, then every PLC runtime. Gateway endpoints stay open and answer that
 * the PLC does not respond; containers are stopped, not removed.
 */
export async function stopFactory(
  deps: FactoryRuntimeDeps,
  actor: Actor,
  factoryId: string,
): Promise<FactoryRuntimeResult> {
  const factory = await getFactory(deps.runtime.db, actor, factoryId);
  if (deps.links) stopPlcLinkMonitor(deps.links, factory.id);
  if (deps.process?.bridge.isRunning(factory.id)) await stopProcessBridge(deps.process, actor, factory.id);
  if (deps.simulation.simulator.isRunning(factory.id)) await stopFactorySimulation(deps.simulation, actor, factory.id);

  const stopped: FactoryRuntimeResult["plcs"] = [];
  try {
    for (const plc of await listPlcs(deps, factory.id)) {
      if (plc.dockerContainerId && plc.runtimeStatus !== "STOPPED") {
        await stopPlcMonitoring(deps.live, actor, plc.id);
        await stopPlc(deps.runtime, actor, plc.id);
      }
      stopped.push({ id: plc.id, name: plc.name, state: "STOPPED" });
    }
  } finally {
    await syncFactoryMonitoring(deps.live, factory.id);
  }
  return { plcs: stopped, simulatedDevices: 0, simulationNote: null, processModules: 0, processNote: null };
}
