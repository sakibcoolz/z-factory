"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActor } from "@/lib/auth/actor";
import { getDb } from "@/lib/db/client";
import { DomainError, isDomainError } from "@/lib/domain/errors";
import { routes } from "@/lib/navigation/routes";
import { type OperationState, toOperationState } from "@/lib/plc/operation-state";
import { configFields, formField as field } from "@/lib/process-modules/form";
import {
  bindModuleSignal,
  importModuleIo,
  rebindModuleSignal,
  releaseModuleSignal,
} from "@/lib/services/module-io-service";
import {
  clearProcessOverride,
  setProcessOverride,
  startProcessBridge,
  stopProcessBridge,
} from "@/lib/services/process-bridge-service";
import {
  addModuleInterlock,
  assignModuleDevice,
  deleteModule,
  removeModuleInterlock,
  unassignModuleDevice,
  updateModule,
  updateModuleInterlock,
} from "@/lib/services/process-module-service";
import { getProcessBridgeDeps } from "@/lib/services/runtime-deps";

/**
 * The module editor's actions (TASK-604). Every one goes through the module service or the
 * I/O registry, which hold the rules; the screen only says what was asked.
 */

function logUnexpected(action: string, error: unknown) {
  if (!isDomainError(error)) console.error(JSON.stringify({ level: "error", action, error: String(error) }));
}

async function run(
  factoryId: string,
  moduleId: string,
  name: string,
  action: () => Promise<string>,
): Promise<OperationState> {
  try {
    return { notice: await action() };
  } catch (error) {
    logUnexpected(`module.${name}`, error);
    return toOperationState(error);
  } finally {
    revalidatePath(routes.module(factoryId, moduleId), "layout");
    revalidatePath(routes.modules(factoryId));
  }
}

/** Renames or moves the module, changes its settings or selects another profile. */
export async function updateModuleAction(
  factoryId: string,
  moduleId: string,
  _previous: OperationState,
  formData: FormData,
): Promise<OperationState> {
  return run(factoryId, moduleId, "update", async () => {
    const profile = field(formData, "profile");
    const updated = await updateModule(getDb(), await requireActor(), moduleId, {
      name: field(formData, "name") || undefined,
      location: field(formData, "location") || null,
      profile: profile || undefined,
      config: configFields(formData),
    });
    return `${updated.name} was saved.`;
  });
}

/** Deletes the module; its devices and tags stay in the factory. */
export async function deleteModuleAction(factoryId: string, moduleId: string): Promise<void> {
  try {
    await deleteModule(getDb(), await requireActor(), moduleId);
  } catch (error) {
    logUnexpected("module.delete", error);
    if (isDomainError(error, "NOT_FOUND")) redirect(routes.modules(factoryId));
    throw error;
  }
  revalidatePath(routes.factory(factoryId), "layout");
  redirect(routes.modules(factoryId));
}

/** Gives a factory device a role in the module, or takes it out of one. */
export async function moduleDeviceAction(
  factoryId: string,
  moduleId: string,
  _previous: OperationState,
  formData: FormData,
): Promise<OperationState> {
  const operation = field(formData, "operation");
  return run(factoryId, moduleId, operation === "unassign" ? "unassign" : "assign", async () => {
    const db = getDb();
    const actor = await requireActor();
    if (operation === "unassign") {
      await unassignModuleDevice(db, actor, moduleId, field(formData, "assignmentId"));
      return "The device was taken out of its role. It stays in the factory.";
    }
    const roleKey = field(formData, "roleKey");
    const deviceId = field(formData, "deviceId");
    if (!deviceId) throw new DomainError("VALIDATION", "Choose a device for the role.", { field: "deviceId" });
    const detail = await assignModuleDevice(db, actor, moduleId, { roleKey, deviceId });
    const role = detail.roles.find((candidate) => candidate.key === roleKey);
    return `${role?.devices.find((device) => device.deviceId === deviceId)?.name ?? "The device"} now fills ${role?.name ?? roleKey}.`;
  });
}

/** Binds, rebinds or releases one signal of the module. */
export async function moduleSignalAction(
  factoryId: string,
  moduleId: string,
  _previous: OperationState,
  formData: FormData,
): Promise<OperationState> {
  const operation = field(formData, "operation");
  const signalKey = field(formData, "signalKey");
  return run(factoryId, moduleId, `signal.${operation}`, async () => {
    const db = getDb();
    const actor = await requireActor();
    if (operation === "release") {
      await releaseModuleSignal(db, actor, moduleId, signalKey);
      return `${signalKey} was released; its tag is free again.`;
    }
    const tagId = field(formData, "tagId");
    if (!tagId) throw new DomainError("VALIDATION", "Choose a tag for the signal.", { field: "tagId" });
    const registry =
      operation === "rebind"
        ? await rebindModuleSignal(db, actor, moduleId, { signalKey, tagId })
        : await bindModuleSignal(db, actor, moduleId, { signalKey, tagId });
    const row = registry.rows.find((candidate) => candidate.signal.key === signalKey);
    return `${row?.signal.name ?? signalKey} is bound to ${row?.binding?.plcName ?? "the PLC"} · ${row?.binding?.tagName ?? "the tag"}.${registry.readyToRun ? " Every required signal is bound: the module can run." : ""}`;
  });
}

/** Adds, enables, disables or removes an interlock of the module. */
export async function moduleInterlockAction(
  factoryId: string,
  moduleId: string,
  _previous: OperationState,
  formData: FormData,
): Promise<OperationState> {
  const operation = field(formData, "operation");
  return run(factoryId, moduleId, `interlock.${operation}`, async () => {
    const db = getDb();
    const actor = await requireActor();
    const interlockId = field(formData, "interlockId");
    if (operation === "remove") {
      await removeModuleInterlock(db, actor, moduleId, interlockId);
      return "The interlock was removed.";
    }
    if (operation === "enable" || operation === "disable") {
      await updateModuleInterlock(db, actor, moduleId, interlockId, { enabled: operation === "enable" });
      return operation === "enable" ? "The interlock is enabled." : "The interlock is disabled.";
    }
    const value = field(formData, "value");
    await addModuleInterlock(db, actor, moduleId, {
      code: field(formData, "code"),
      name: field(formData, "name"),
      severity: field(formData, "severity") || undefined,
      expression: {
        when: [
          {
            signal: field(formData, "whenSignal"),
            operator: field(formData, "operator"),
            ...(value === "" ? {} : { value: Number(value) }),
          },
        ],
        blocks: [field(formData, "blocks")],
      },
    });
    return `The interlock ${field(formData, "code")} was added.`;
  });
}

/** Replaces the module's bindings with those of an exported document. */
export async function importModuleIoAction(
  factoryId: string,
  moduleId: string,
  _previous: OperationState,
  formData: FormData,
): Promise<OperationState> {
  return run(factoryId, moduleId, "import", async () => {
    const file = formData.get("document");
    const text = file instanceof File ? await file.text() : field(formData, "document");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new DomainError("VALIDATION", "The file is not JSON.", { field: "document" });
    }
    const registry = await importModuleIo(getDb(), await requireActor(), moduleId, parsed);
    const bound = registry.rows.filter((row) => row.state === "BOUND").length;
    return `${bound} binding${bound === 1 ? "" : "s"} restored.${registry.readyToRun ? " The module can run." : ""}`;
  });
}

/** Starts or stops the process bridge of the factory, which runs every module that is ready. */
export async function processBridgeAction(
  factoryId: string,
  moduleId: string,
  _previous: OperationState,
  formData: FormData,
): Promise<OperationState> {
  const operation = field(formData, "operation");
  return run(factoryId, moduleId, `bridge.${operation}`, async () => {
    const actor = await requireActor();
    const deps = getProcessBridgeDeps();
    if (operation === "stop") {
      await stopProcessBridge(deps, actor, factoryId);
      return "The process bridge is stopped; the models are unloaded.";
    }
    const state = await startProcessBridge(deps, actor, factoryId);
    const count = state.running ? state.modules.length : 0;
    return `The process bridge runs ${count} module${count === 1 ? "" : "s"}.${state.skipped.length > 0 ? ` Left alone: ${state.skipped.map((entry) => entry.name).join(", ")}.` : ""}`;
  });
}

/**
 * Overrides a value the PLC reads, or clears it (Phase 08, TASK-802). Only the simulation
 * changes: the PLC program sees the new value and decides; no PLC output is written.
 */
export async function overrideAction(
  factoryId: string,
  moduleId: string,
  signal: string,
  _previous: OperationState,
  formData: FormData,
): Promise<OperationState> {
  const operation = field(formData, "operation");
  return run(factoryId, moduleId, `override.${operation}`, async () => {
    const actor = await requireActor();
    const deps = getProcessBridgeDeps();
    if (operation === "clear") {
      const state = await clearProcessOverride(deps, actor, moduleId, signal);
      return `${signal} is back to AUTO: ${state.effective}${state.unit ? ` ${state.unit}` : ""} from the model.`;
    }
    const number = (name: string) => {
      const value = field(formData, name);
      if (value === "")
        throw new DomainError("VALIDATION", `Enter ${name === "value" ? "a value" : name}.`, { field: name });
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new DomainError("VALIDATION", `${value} is not a number.`, { field: name });
      return parsed;
    };
    const mode = field(formData, "mode");
    const state =
      mode === "SCENARIO"
        ? await setProcessOverride(deps, actor, moduleId, signal, {
            mode: "SCENARIO",
            profile: { kind: "RAMP", from: number("from"), to: number("to"), durationS: number("durationS") },
          })
        : await setProcessOverride(deps, actor, moduleId, signal, { mode: "MANUAL_OVERRIDE", value: number("value") });
    return `${signal} is in ${state.mode}: the PLC now reads ${state.effective}${state.unit ? ` ${state.unit}` : ""}; the model calculates ${state.calculated}.`;
  });
}
