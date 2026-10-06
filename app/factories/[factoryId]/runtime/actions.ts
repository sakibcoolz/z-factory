"use server";

import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/auth/actor";
import { DomainError, isDomainError } from "@/lib/domain/errors";
import { routes } from "@/lib/navigation/routes";
import { type OperationState, toOperationState } from "@/lib/plc/operation-state";
import { startFactory, stopFactory } from "@/lib/services/factory-runtime-service";
import { getFactoryRuntimeDeps } from "@/lib/services/runtime-deps";

/**
 * Starts or stops a stored factory as a whole. Neither writes a PLC tag: starting brings
 * up controllers, simulated field and gateway endpoints; what the plant then does is
 * decided by PLC logic and whoever writes its commands.
 */
export async function factoryRuntimeAction(
  factoryId: string,
  _previous: OperationState,
  formData: FormData,
): Promise<OperationState> {
  const operation = formData.get("operation");
  try {
    const actor = await requireActor();
    const deps = getFactoryRuntimeDeps();
    if (operation === "start") {
      const result = await startFactory(deps, actor, factoryId);
      const plcs = `${result.plcs.length} PLC${result.plcs.length === 1 ? "" : "s"} running`;
      const devices = `${result.simulatedDevices} simulated device${result.simulatedDevices === 1 ? "" : "s"} running`;
      const modules =
        result.processModules > 0
          ? `, ${result.processModules} process module${result.processModules === 1 ? "" : "s"} running`
          : "";
      const notes = [
        result.simulationNote ? `The device simulation was not started: ${result.simulationNote}` : null,
        result.processNote ? `The process bridge was not started: ${result.processNote}` : null,
      ].filter((note) => note !== null);
      return { notice: `${plcs}, ${devices}${modules}.${notes.length > 0 ? ` ${notes.join(" ")}` : ""}` };
    }
    if (operation === "stop") {
      await stopFactory(deps, actor, factoryId);
      return { notice: "The simulation and every PLC runtime are stopped. The last device states were stored." };
    }
    throw new DomainError("VALIDATION", "Unknown factory operation.");
  } catch (error) {
    if (!isDomainError(error)) {
      console.error(JSON.stringify({ level: "error", action: `factory.${String(operation)}`, error: String(error) }));
    } else if (error.code === "RUNTIME_FAILURE") {
      console.error(JSON.stringify({ level: "error", action: `factory.${String(operation)}`, message: error.message }));
    }
    return toOperationState(error);
  } finally {
    revalidatePath(routes.factory(factoryId), "layout");
  }
}
