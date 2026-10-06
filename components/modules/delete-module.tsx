"use client";

import { useState, useTransition } from "react";

/** Two-step delete of a module: the first click only asks; the second runs the action, which redirects. */
export function DeleteModule({ moduleName, action }: { moduleName: string; action: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();
  if (!confirming) {
    return (
      <button type="button" className="zf-btn" data-variant="ghost" data-size="sm" onClick={() => setConfirming(true)}>
        Delete module
      </button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="zf-error" role="alert">
        {`Delete ${moduleName}? Its roles, interlocks and bindings go; its devices and tags stay in the factory.`}
      </span>
      <button
        type="button"
        className="zf-btn"
        data-variant="danger"
        data-size="sm"
        disabled={pending}
        onClick={() => start(() => action())}
      >
        {pending ? "Deleting…" : "Confirm delete"}
      </button>
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
    </div>
  );
}
