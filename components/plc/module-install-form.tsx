"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { signalTypeLabel } from "@/lib/catalog/format";
import type { InstallableModuleView } from "@/lib/domain/plc-config-view";
import { type ActionState, EMPTY_ACTION_STATE } from "@/lib/plc/form-state";

type ModuleInstallFormProps = {
  /** Server action; it redirects back to the hardware view on success. */
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  /** Only modules the catalog allows with this CPU. */
  modules: readonly InstallableModuleView[];
  freeSlots: readonly number[];
};

const describe = (module: InstallableModuleView) =>
  module.channels.map((group) => `${group.count} × ${group.ioType} ${signalTypeLabel(group.signalType)}`).join(", ");

/** 2g — installs a compatible module in a free slot of the rack. */
export function ModuleInstallForm({ action, modules, freeSlots }: ModuleInstallFormProps) {
  const [state, formAction, pending] = useActionState(action, EMPTY_ACTION_STATE);
  const full = freeSlots.length === 0;

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2">
      <div className="zf-f min-w-72 flex-1">
        <label htmlFor="moduleModelId" className="zf-k">
          Compatible module
        </label>
        <select
          id="moduleModelId"
          name="moduleModelId"
          className="zf-input"
          defaultValue={state.values.moduleModelId}
          disabled={full}
        >
          {modules.map((module) => (
            <option key={module.id} value={module.id}>
              {`${module.modelName} · ${describe(module)}`}
            </option>
          ))}
        </select>
      </div>
      <div className="zf-f w-28">
        <label htmlFor="slotIndex" className="zf-k">
          Slot
        </label>
        <select
          id="slotIndex"
          name="slotIndex"
          className="zf-input mono"
          defaultValue={state.values.slotIndex}
          disabled={full}
        >
          {freeSlots.map((slot) => (
            <option key={slot} value={slot}>
              {slot}
            </option>
          ))}
        </select>
      </div>
      <Button variant="primary" type="submit" disabled={pending || full || modules.length === 0}>
        {pending ? "Installing…" : "Install module"}
      </Button>
      {full ? <span className="zf-k">every slot is in use</span> : null}
      {state.message || Object.keys(state.fieldErrors).length > 0 ? (
        <p className="zf-error basis-full" role="alert">
          {state.message ?? Object.values(state.fieldErrors).join(" ")}
        </p>
      ) : null}
    </form>
  );
}
