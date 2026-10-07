"use client";

import { useActionState } from "react";
import { EMPTY_FORM_STATE, type FormState } from "@/lib/form-state";

/** A form bound to a server action, showing its pending state and what it answered. */
export function ActionForm({
  action,
  submit,
  pending = "Saving…",
  className = "inline",
  variant = "primary",
  confirm,
  children,
}: {
  action: (state: FormState, data: FormData) => Promise<FormState>;
  submit: string;
  pending?: string;
  className?: string;
  variant?: "primary" | "default" | "danger";
  confirm?: string;
  children?: React.ReactNode;
}) {
  const [state, formAction, busy] = useActionState(action, EMPTY_FORM_STATE);
  return (
    <form
      action={formAction}
      className={className}
      onSubmit={(event) => {
        if (confirm && !window.confirm(confirm)) event.preventDefault();
      }}
    >
      {children}
      <button type="submit" className={variant === "default" ? undefined : variant} disabled={busy}>
        {busy ? pending : submit}
      </button>
      {state.error ? (
        <span className="error" role="alert">
          {state.error}
        </span>
      ) : null}
      {state.notice ? <span className="notice">{state.notice}</span> : null}
    </form>
  );
}
