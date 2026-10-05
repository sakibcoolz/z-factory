"use server";

import { revalidatePath } from "next/cache";
import { type Actor, requireActor } from "@/lib/auth/actor";
import { getDb } from "@/lib/db/client";
import { DomainError, isDomainError } from "@/lib/domain/errors";
import { runtimeStateLabel } from "@/lib/domain/runtime-state";
import { routes } from "@/lib/navigation/routes";
import { type OperationState, toOperationState } from "@/lib/plc/operation-state";
import {
  checkProgram,
  createProgramVersion,
  deployProgramVersion,
  refreshPlcState,
  removePlcRuntime,
  restartPlc,
  saveAndDeployProgram,
  selectProgramVersion,
  startPlc,
  stopPlc,
} from "@/lib/services/plc-runtime-service";
import { stopPlcMonitoring, syncFactoryMonitoring } from "@/lib/services/live-service";
import { getLiveDeps, getRuntimeDeps } from "@/lib/services/runtime-deps";

/**
 * Program and runtime operations of a stored PLC. Each action passes the authorization
 * boundary first and stays on the page: it returns what happened or why it did not.
 * Starting a runtime can take minutes the first time (image pull, program build); the
 * action answers when the operation has finished.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Runtime failures keep their detail (build log lines, Docker cause) in the server log only. */
function logFailure(action: string, error: unknown) {
  if (!isDomainError(error)) {
    console.error(JSON.stringify({ level: "error", action, error: String(error) }));
  } else if (error.code === "RUNTIME_FAILURE") {
    console.error(JSON.stringify({ level: "error", action, message: error.message, details: error.details }));
  }
}

/**
 * A PLC that was started gets its tags read, one that was stopped does not any more.
 * Live values are a consequence of the operation, never a reason for it to fail.
 */
async function syncLive(factoryId: string) {
  try {
    await syncFactoryMonitoring(getLiveDeps(), factoryId);
  } catch (error) {
    console.error(JSON.stringify({ level: "error", action: "live.sync", error: String(error) }));
  }
}

/** The PLC is about to go away on purpose: stop reading it first. It is read again if it stays up. */
async function pauseLive(actor: Actor, plcId: string) {
  try {
    await stopPlcMonitoring(getLiveDeps(), actor, plcId);
  } catch (error) {
    console.error(JSON.stringify({ level: "error", action: "live.pause", error: String(error) }));
  }
}

const field = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Editor actions: `check` compiles only, `save` stores a version, `deploy` stores and runs it. */
export async function programAction(
  factoryId: string,
  plcId: string,
  _previous: OperationState,
  formData: FormData,
): Promise<OperationState> {
  const intent = field(formData, "intent");
  // A submitted textarea arrives with CRLF line ends; programs are stored with LF.
  const input = { sourceText: field(formData, "sourceText").replace(/\r\n?/g, "\n") };
  try {
    const actor = await requireActor();
    switch (intent) {
      case "check": {
        const result = await checkProgram(getDb(), actor, plcId, input);
        if (!result.success) {
          return { message: "The program does not compile.", diagnostics: [...result.errors, ...result.warnings] };
        }
        return {
          notice:
            result.warnings.length > 0
              ? `The program compiles with ${plural(result.warnings.length, "warning")}. Nothing was saved.`
              : "The program compiles. Nothing was saved.",
          diagnostics: result.warnings,
        };
      }
      case "save": {
        const created = await createProgramVersion(getDb(), actor, plcId, input);
        return {
          notice: `Saved as version ${created.version}. It is used by the next start or deploy.`,
          savedVersion: created.version,
        };
      }
      case "deploy": {
        const deployed = await saveAndDeployProgram(getRuntimeDeps(), actor, plcId, input);
        return {
          notice: deployed.saved
            ? `Saved as version ${deployed.version} and deployed. The PLC is running it.`
            : `Version ${deployed.version} deployed. The PLC is running it.`,
          savedVersion: deployed.version,
        };
      }
      default:
        throw new DomainError("VALIDATION", "Unknown program action.");
    }
  } catch (error) {
    logFailure(`plc.program.${intent}`, error);
    return toOperationState(error);
  } finally {
    if (intent === "deploy") await syncLive(factoryId);
    if (intent !== "check") revalidatePath(routes.plc(factoryId, plcId), "layout");
  }
}

/** Versions screen: `select` a stored version for the next start, or `deploy` it now. */
export async function programVersionAction(
  factoryId: string,
  plcId: string,
  programVersionId: string,
  _previous: OperationState,
  formData: FormData,
): Promise<OperationState> {
  const operation = field(formData, "operation");
  try {
    const actor = await requireActor();
    if (!UUID.test(programVersionId)) throw new DomainError("NOT_FOUND", "The program version does not exist.");
    if (operation === "deploy") {
      const deployed = await deployProgramVersion(getRuntimeDeps(), actor, plcId, programVersionId);
      return { notice: `Version ${deployed.version} deployed. The PLC is running it.` };
    }
    if (operation === "select") {
      const selected = await selectProgramVersion(getDb(), actor, plcId, programVersionId);
      return { notice: `Version ${selected.version} is used by the next start or deploy.` };
    }
    throw new DomainError("VALIDATION", "Unknown version operation.");
  } catch (error) {
    logFailure(`plc.version.${operation}`, error);
    return toOperationState(error);
  } finally {
    revalidatePath(routes.plc(factoryId, plcId), "layout");
  }
}

/** Runtime screen: the lifecycle of the PLC's runtime. The operation is the pressed button. */
export async function runtimeAction(
  factoryId: string,
  plcId: string,
  _previous: OperationState,
  formData: FormData,
): Promise<OperationState> {
  const operation = field(formData, "operation");
  try {
    const actor = await requireActor();
    const deps = getRuntimeDeps();
    if (operation === "stop" || operation === "restart" || operation === "remove") await pauseLive(actor, plcId);
    switch (operation) {
      case "start": {
        const { state } = await startPlc(deps, actor, plcId);
        return { notice: `The runtime is started: ${runtimeStateLabel(state).toLowerCase()}.` };
      }
      case "deploy": {
        const { version } = await deployProgramVersion(deps, actor, plcId);
        return { notice: `Version ${version} deployed. The PLC is running it.` };
      }
      case "stop":
        await stopPlc(deps, actor, plcId);
        return { notice: "The runtime is stopped. Its container and program are kept." };
      case "restart": {
        const { state } = await restartPlc(deps, actor, plcId);
        return { notice: `The runtime was restarted: ${runtimeStateLabel(state).toLowerCase()}.` };
      }
      case "remove":
        await removePlcRuntime(deps, actor, plcId);
        return { notice: "The runtime is removed. Program versions and the Modbus endpoint are kept." };
      case "refresh": {
        const { state } = await refreshPlcState(deps, actor, plcId);
        return { notice: `The runtime reports: ${runtimeStateLabel(state).toLowerCase()}.` };
      }
      default:
        throw new DomainError("VALIDATION", "Unknown runtime operation.");
    }
  } catch (error) {
    logFailure(`plc.runtime.${operation}`, error);
    return toOperationState(error);
  } finally {
    await syncLive(factoryId);
    revalidatePath(routes.factory(factoryId), "layout");
  }
}
