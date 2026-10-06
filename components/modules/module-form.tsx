"use client";

import { type ReactNode, useActionState, useState } from "react";
import type { ModuleConfigField } from "@/lib/domain/process-module";
import type { ModuleTypeDetail } from "@/lib/domain/process-module-view";
import { EMPTY_OPERATION_STATE, type OperationState } from "@/lib/plc/operation-state";

type Action = (state: OperationState, formData: FormData) => Promise<OperationState>;

function Field({
  label,
  htmlFor,
  children,
  hint,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="zf-f">
      <label htmlFor={htmlFor} className="zf-k">
        {label}
      </label>
      {children}
      {hint ? <span className="zf-sub">{hint}</span> : null}
    </div>
  );
}

const limits = (field: ModuleConfigField) =>
  [field.min !== null ? `≥ ${field.min}` : null, field.max !== null ? `≤ ${field.max}` : null]
    .filter(Boolean)
    .join(" · ");

/** One setting of the type as a form field; its kind travels with it so the action types the value. */
export function ConfigFieldInput({
  field,
  value,
  idPrefix,
  disabled,
}: {
  field: ModuleConfigField;
  value: unknown;
  idPrefix: string;
  disabled?: boolean;
}) {
  const id = `${idPrefix}-config-${field.key}`;
  const current = value ?? field.defaultValue ?? "";
  const hint = [field.unit, limits(field), field.defaultValue !== null ? `default ${String(field.defaultValue)}` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <Field label={field.label} htmlFor={id} hint={hint || undefined}>
      <input type="hidden" name={`configType.${field.key}`} value={field.type} />
      {field.type === "boolean" ? (
        <select
          id={id}
          name={`config.${field.key}`}
          className="zf-input"
          defaultValue={String(current)}
          disabled={disabled}
        >
          <option value="true">yes</option>
          <option value="false">no</option>
        </select>
      ) : field.type === "choice" ? (
        <select
          id={id}
          name={`config.${field.key}`}
          className="zf-input mono"
          defaultValue={String(current)}
          disabled={disabled}
        >
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          name={`config.${field.key}`}
          type={field.type === "text" ? "text" : "number"}
          step={field.type === "integer" ? 1 : "any"}
          min={field.min ?? undefined}
          max={field.max ?? undefined}
          className={`zf-input${field.type === "text" ? "" : " mono"}`}
          defaultValue={String(current)}
          disabled={disabled}
        />
      )}
    </Field>
  );
}

/** Creates a module: the type decides the profiles and settings offered; nothing else is process-specific. */
export function NewModuleForm({ types, action }: { types: ModuleTypeDetail[]; action: Action }) {
  const [state, formAction, pending] = useActionState(action, EMPTY_OPERATION_STATE);
  const [typeId, setTypeId] = useState(types[0]?.id ?? "");
  const type = types.find((candidate) => candidate.id === typeId);
  return (
    <form action={formAction} className="flex flex-col gap-2" aria-label="New process module">
      <div className="grid grid-cols-4 gap-2.5">
        <Field label="Type" htmlFor="module-type">
          <select
            id="module-type"
            name="typeId"
            className="zf-input"
            value={typeId}
            onChange={(event) => setTypeId(event.target.value)}
            disabled={pending || types.length === 0}
          >
            {types.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {`${candidate.name} (${candidate.code} v${candidate.version})`}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Name" htmlFor="module-name" hint="Unique within the factory, like a device name.">
          <input
            id="module-name"
            name="name"
            className="zf-input mono"
            placeholder="PUMP-HOUSE-01"
            required
            disabled={pending}
          />
        </Field>
        <Field label="Location" htmlFor="module-location">
          <input id="module-location" name="location" className="zf-input" placeholder="optional" disabled={pending} />
        </Field>
        {type && type.profiles.length > 0 ? (
          <Field label="Profile" htmlFor="module-profile" hint="Decides which roles and signals the module has.">
            <select
              id="module-profile"
              name="profile"
              className="zf-input mono"
              defaultValue={type.profiles[0]}
              disabled={pending}
            >
              {type.profiles.map((profile) => (
                <option key={profile} value={profile}>
                  {profile}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
      </div>
      {type ? (
        <>
          {type.description ? <p className="zf-sub">{type.description}</p> : null}
          {type.configFields.length > 0 ? (
            <div className="grid grid-cols-4 gap-2.5">
              {type.configFields.map((field) => (
                <ConfigFieldInput
                  key={`${type.id}-${field.key}`}
                  field={field}
                  value={null}
                  idPrefix="new"
                  disabled={pending}
                />
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <p className="zf-sub">No module type is installed. Run the seed to install the shipped types.</p>
      )}
      {state.message ? (
        <p className="zf-error" role="alert">
          {state.message}
        </p>
      ) : null}
      <div>
        <button type="submit" className="zf-btn" data-variant="primary" data-size="sm" disabled={pending || !type}>
          {pending ? "Creating…" : "Create module"}
        </button>
      </div>
    </form>
  );
}
