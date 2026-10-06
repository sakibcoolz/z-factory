"use client";

import { useActionState } from "react";
import type { ParameterField } from "@/lib/domain/device-parameters";
import { EMPTY_OPERATION_STATE, type OperationState } from "@/lib/plc/operation-state";

type ParametersFormProps = {
  fields: ParameterField[];
  values: Record<string, number>;
  /** Server action; it stays on the page and returns what happened. */
  action: (state: OperationState, formData: FormData) => Promise<OperationState>;
};

const limits = (field: ParameterField) =>
  [
    field.min !== null ? `${field.minInclusive ? "≥" : ">"} ${field.min}` : null,
    field.max !== null ? `≤ ${field.max}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

/** The parameters of a configurable device, one field each; saving stores a new immutable version. */
export function ParametersForm({ fields, values, action }: ParametersFormProps) {
  const [state, formAction, pending] = useActionState(action, EMPTY_OPERATION_STATE);
  return (
    <form action={formAction} className="flex flex-col gap-2" aria-label="Parameters">
      <table className="zf-tbl">
        <thead>
          <tr>
            <th>Parameter</th>
            <th>Value</th>
            <th>Unit</th>
            <th>Limits</th>
            <th>Default</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((field) => (
            <tr key={field.key}>
              <td>
                <label htmlFor={`parameter-${field.key}`}>{field.label}</label>
                {field.description ? <span className="zf-sub block">{field.description}</span> : null}
              </td>
              <td>
                <input
                  id={`parameter-${field.key}`}
                  name={field.key}
                  type="number"
                  step="any"
                  className="zf-input mono"
                  defaultValue={values[field.key] ?? field.defaultValue}
                  required
                  disabled={pending}
                />
              </td>
              <td className="mono">{field.unit ?? "—"}</td>
              <td className="mono">{limits(field) || "—"}</td>
              <td className="mono">{field.defaultValue}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {state.message ? (
        <p className="zf-error" role="alert">
          {state.message}
        </p>
      ) : null}
      {state.notice ? (
        <p className="zf-sub" role="status">
          {state.notice}
        </p>
      ) : null}
      <div>
        <button type="submit" className="zf-btn" data-variant="primary" data-size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save as new version"}
        </button>
      </div>
    </form>
  );
}
