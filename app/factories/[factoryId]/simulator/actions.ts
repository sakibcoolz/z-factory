"use server";

import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/auth/actor";
import { DomainError, isDomainError } from "@/lib/domain/errors";
import { routes } from "@/lib/navigation/routes";
import { type OperationState, toOperationState } from "@/lib/plc/operation-state";
import { getSimulationDeps } from "@/lib/services/runtime-deps";
import {
  clearDeviceFault,
  injectDeviceFault,
  resetSimulatedDevice,
  startFactorySimulation,
  stopFactorySimulation,
} from "@/lib/services/simulation-service";

/**
 * Operator actions on the device simulation of a stored factory. They act on the
 * simulated field equipment only: no action here writes a PLC tag or decides for the
 * PLC program. Every fault injection, clearing and reset is recorded as an event.
 */

function logUnexpected(action: string, error: unknown) {
  if (!isDomainError(error)) console.error(JSON.stringify({ level: "error", action, error: String(error) }));
}

const field = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Starts or stops the factory's device simulation. The operation is the pressed button. */
export async function simulationAction(
  factoryId: string,
  _previous: OperationState,
  formData: FormData,
): Promise<OperationState> {
  const operation = field(formData, "operation");
  try {
    const actor = await requireActor();
    const deps = getSimulationDeps();
    if (operation === "start") {
      const started = await startFactorySimulation(deps, actor, factoryId);
      const count = started.running ? started.devices.length : 0;
      return { notice: `The simulation is running ${plural(count, "device")}.` };
    }
    if (operation === "stop") {
      await stopFactorySimulation(deps, actor, factoryId);
      return { notice: "The simulation is stopped. The last device states were stored." };
    }
    throw new DomainError("VALIDATION", "Unknown simulation operation.");
  } catch (error) {
    logUnexpected(`simulation.${operation}`, error);
    return toOperationState(error);
  } finally {
    revalidatePath(routes.factory(factoryId), "layout");
  }
}

/**
 * Fault injection, clearing and operator reset on one simulated device. The pressed
 * button carries the operation as `inject:<code>`, `clear:<code>` or `reset`.
 */
export async function deviceFaultAction(
  factoryId: string,
  deviceId: string,
  _previous: OperationState,
  formData: FormData,
): Promise<OperationState> {
  const [operation = "", code = ""] = field(formData, "operation").split(":");
  try {
    const actor = await requireActor();
    const deps = getSimulationDeps();
    switch (operation) {
      case "inject":
        await injectDeviceFault(deps, actor, deviceId, code);
        return { notice: `Fault ${code} injected.` };
      case "clear":
        await clearDeviceFault(deps, actor, deviceId, code);
        return { notice: `Fault ${code} cleared.` };
      case "reset":
        await resetSimulatedDevice(deps, actor, deviceId);
        return { notice: "Device reset." };
      default:
        throw new DomainError("VALIDATION", "Unknown device operation.");
    }
  } catch (error) {
    logUnexpected(`simulation.device.${operation}`, error);
    return toOperationState(error);
  } finally {
    revalidatePath(routes.simulator(factoryId));
  }
}
