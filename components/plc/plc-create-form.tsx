"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { SectionRule } from "@/components/ui/primitives";
import type { PlcModelOption } from "@/lib/domain/plc-config-view";
import type { ActionState } from "@/lib/plc/form-state";

type PlcCreateFormProps = {
  /** Server action; it redirects to the new PLC on success and returns errors otherwise. */
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  architecture: "compact" | "modular";
  models: readonly PlcModelOption[];
  suggestedName: string;
  cancelHref: string;
};

/** 2f / 2g, first step: catalog model, instance name and process role of a new PLC. */
export function PlcCreateForm({ action, architecture, models, suggestedName, cancelHref }: PlcCreateFormProps) {
  const [state, formAction, pending] = useActionState(action, {
    fieldErrors: {},
    values: { deviceModelId: models[0]?.id ?? "", name: suggestedName, role: "" },
  });
  const error = (field: string) => state.fieldErrors[field];
  const fieldError = (field: string) =>
    error(field) ? (
      <p id={`${field}-error`} className="zf-error" role="alert">
        {error(field)}
      </p>
    ) : null;

  return (
    <form action={formAction} className="flex min-h-0 flex-1 flex-col gap-4" noValidate>
      {state.message ? (
        <p className="zf-error" role="alert">
          {state.message}
        </p>
      ) : null}

      <fieldset
        className="flex flex-col gap-2"
        aria-describedby={error("deviceModelId") ? "deviceModelId-error" : undefined}
      >
        <legend className="zf-k mb-2">{`Model · ${architecture}`}</legend>
        {models.map((model) => (
          <label key={model.id} className="zf-cell cursor-pointer flex-row items-start gap-3">
            <input
              type="radio"
              name="deviceModelId"
              value={model.id}
              defaultChecked={model.id === state.values.deviceModelId}
              className="mt-1"
            />
            <span className="flex flex-col gap-1">
              <span className="text-fg-strong">{`${model.manufacturer} ${model.family} ${model.modelName}`}</span>
              <span className="mono text-fg-dim">{[model.sku, model.io, model.ports].filter(Boolean).join(" · ")}</span>
            </span>
            <span className="zf-k ml-auto">{model.verificationStatus.toLowerCase()}</span>
          </label>
        ))}
        {fieldError("deviceModelId")}
      </fieldset>

      <SectionRule>
        <span className="zf-k">Instance · unique in this factory</span>
      </SectionRule>
      <div className="grid max-w-180 grid-cols-2 gap-x-5 gap-y-3">
        <div className="zf-f">
          <label htmlFor="name" className="zf-k">
            Name
          </label>
          <input
            id="name"
            name="name"
            className="zf-input mono"
            defaultValue={state.values.name}
            maxLength={63}
            required
            aria-invalid={Boolean(error("name"))}
            aria-describedby={error("name") ? "name-error" : undefined}
          />
          {fieldError("name")}
        </div>
        <div className="zf-f">
          <label htmlFor="role" className="zf-k">
            Process role
          </label>
          <input
            id="role"
            name="role"
            className="zf-input"
            defaultValue={state.values.role}
            maxLength={120}
            placeholder="e.g. Pump station controller"
            aria-invalid={Boolean(error("role"))}
            aria-describedby={error("role") ? "role-error" : undefined}
          />
          {fieldError("role")}
        </div>
      </div>
      <p className="zf-sub max-w-180">
        The model is the hardware profile; the role says what this PLC does in the process. The PLC runs on OpenPLC, not
        on vendor firmware. Creating it changes configuration only.
      </p>

      <div className="mt-auto flex gap-2 border-t border-line pt-3">
        <Button variant="primary" type="submit" disabled={pending || models.length === 0}>
          {pending ? "Creating…" : "Create PLC"}
        </Button>
        <Button variant="ghost" href={cancelHref}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
