"use client";

import { useActionState, useState } from "react";
import { RefusalExplanation } from "@/components/ui/refusal";
import type { DeleteFactoryState } from "@/lib/factories/form-state";
import { Button } from "@/components/ui/button";

type DeleteFactoryProps = {
  factoryName: string;
  /** Server action; it redirects to the factory list on success. */
  action: (state: DeleteFactoryState) => Promise<DeleteFactoryState>;
};

/** Two-step delete: the first click only asks; the second submits. */
export function DeleteFactory({ factoryName, action }: DeleteFactoryProps) {
  const [state, formAction, pending] = useActionState(action, {});
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button type="button" className="zf-btn" data-variant="ghost" data-size="sm" onClick={() => setConfirming(true)}>
        Delete
      </button>
    );
  }

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-1.5">
      <span className="zf-error" role="alert">
        {state.message ?? `Delete ${factoryName} and its devices? This cannot be undone.`}
        {state.message && state.explanation ? <RefusalExplanation explanation={state.explanation} /> : null}
      </span>
      <Button size="sm" variant="danger" type="submit" disabled={pending}>
        {pending ? "Deleting…" : "Confirm delete"}
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
