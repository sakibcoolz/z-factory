"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { type ActionState, EMPTY_ACTION_STATE } from "@/lib/plc/form-state";

type ConfirmActionProps = {
  /** Label of the first button, e.g. "Remove". */
  label: string;
  /** What is asked before the action runs. */
  question: string;
  confirmLabel: string;
  /** Server action; it redirects on success and returns a message otherwise. */
  action: (state: ActionState) => Promise<ActionState>;
};

/** Two-step destructive action: the first click only asks; the second submits. */
export function ConfirmAction({ label, question, confirmLabel, action }: ConfirmActionProps) {
  const [state, formAction, pending] = useActionState(action, EMPTY_ACTION_STATE);
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button type="button" className="zf-btn" data-variant="ghost" data-size="sm" onClick={() => setConfirming(true)}>
        {label}
      </button>
    );
  }
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-1.5">
      <span className="zf-error whitespace-normal" role="alert">
        {state.message ?? question}
      </span>
      <Button size="sm" variant="danger" type="submit" disabled={pending}>
        {pending ? "Working…" : confirmLabel}
      </Button>
      <button
        type="button"
        className="zf-btn"
        data-variant="ghost"
        data-size="sm"
        onClick={() => setConfirming(false)}
        disabled={pending}
      >
        Keep
      </button>
    </form>
  );
}
