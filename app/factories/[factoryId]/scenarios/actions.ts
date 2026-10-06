"use server";

import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/auth/actor";
import { isDomainError } from "@/lib/domain/errors";
import type { ScenarioRunState } from "@/lib/domain/scenario";
import { routes } from "@/lib/navigation/routes";
import { type OperationState, toOperationState } from "@/lib/plc/operation-state";
import { getScenarioDeps } from "@/lib/services/runtime-deps";
import { clearAllOverrides, runScenario } from "@/lib/services/scenario-service";

/**
 * Closed-loop scenarios of a stored factory (TASK-804). A run asks through command and
 * setpoint tags and the simulation only; what the PLC program decides is read, never
 * written. Every run and every release is recorded as events.
 */

function logUnexpected(action: string, error: unknown) {
  if (!isDomainError(error)) console.error(JSON.stringify({ level: "error", action, error: String(error) }));
}

const MAX_SOURCE = 100_000;

/** Runs the scenario pasted in the form's `scenario` field and answers with its report. */
export async function scenarioRunAction(
  factoryId: string,
  _previous: ScenarioRunState,
  formData: FormData,
): Promise<ScenarioRunState> {
  const raw = formData.get("scenario");
  const source = typeof raw === "string" ? raw.slice(0, MAX_SOURCE) : "";
  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch {
    return { source, message: "The scenario is not valid JSON." };
  }
  try {
    const actor = await requireActor();
    return { source, report: await runScenario(getScenarioDeps(), actor, factoryId, input) };
  } catch (error) {
    logUnexpected("scenario.run", error);
    return { source, message: toOperationState(error).message };
  } finally {
    revalidatePath(routes.scenarios(factoryId));
  }
}

/** Returns every forced and overridden value of the factory to AUTO. */
export async function clearOverridesAction(factoryId: string, _previous: OperationState): Promise<OperationState> {
  try {
    const actor = await requireActor();
    const released = await clearAllOverrides(getScenarioDeps(), actor, factoryId);
    return {
      notice:
        released === 0
          ? "Every value was already in AUTO."
          : `${released} value${released === 1 ? "" : "s"} back in AUTO.`,
    };
  } catch (error) {
    logUnexpected("scenario.clear", error);
    return toOperationState(error);
  } finally {
    revalidatePath(routes.scenarios(factoryId));
  }
}
