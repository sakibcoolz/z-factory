"use client";

import { type ReactNode, useActionState } from "react";
import { EMPTY_OPERATION_STATE, type OperationState } from "@/lib/plc/operation-state";

type FieldsFormProps = {
  /** Server action; it stays on the page and returns what happened. */
  action: (state: OperationState, formData: FormData) => Promise<OperationState>;
  /** Accessible name of the form. */
  label: string;
  submitLabel: string;
  pendingLabel: string;
  disabled?: boolean;
  /** The form's fields. */
  children: ReactNode;
};

/** A small form of fields with one submit button; the result or the reason for a failure is announced below. */
export function FieldsForm({ action, label, submitLabel, pendingLabel, disabled, children }: FieldsFormProps) {
  const [state, formAction, pending] = useActionState(action, EMPTY_OPERATION_STATE);
  return (
    <form action={formAction} className="flex flex-col gap-1.5" aria-label={label}>
      <div className="flex flex-wrap items-end gap-2">
        {children}
        <button type="submit" className="zf-btn" data-variant="primary" data-size="sm" disabled={pending || disabled}>
          {pending ? pendingLabel : submitLabel}
        </button>
      </div>
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
    </form>
  );
}
