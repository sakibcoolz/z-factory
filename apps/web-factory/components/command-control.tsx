"use client";

import { useActionState, useRef } from "react";
import { issueCommandAction } from "@/app/(signed-in)/actions";
import type { FormState } from "@/lib/form-state";

/**
 * Sends a command or setpoint to one writable tag (TASK-905). On and off for a command
 * bit, a number in the tag's range for a setpoint. The form carries a request key: sent
 * twice (a double click, a resubmission), it is still one command; the key is renewed
 * after each answer, so the next intended command is a new one.
 */
export function CommandControl({
  plcId,
  tag,
  name,
  boolean,
  min,
  max,
  unit,
}: {
  plcId: string;
  tag: string;
  name: string;
  boolean: boolean;
  min: number | null;
  max: number | null;
  unit: string | null;
}) {
  // The state carries the key of the next command: a new one with every answer.
  const [state, action, busy] = useActionState(
    async (previous: FormState & { key: string }, data: FormData) => ({
      ...(await issueCommandAction(plcId, tag, previous, data)),
      key: crypto.randomUUID(),
    }),
    // Empty until the browser makes one on the first send (a random key would differ
    // between the server's render and the browser's).
    { key: "" },
  );
  const firstKey = useRef<string | null>(null);
  return (
    <form
      action={action}
      className="command"
      onSubmit={(event) => {
        const keyField = event.currentTarget.elements.namedItem("requestKey") as HTMLInputElement;
        if (!keyField.value) keyField.value = firstKey.current ??= crypto.randomUUID();
        const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
        const value =
          submitter?.value || (event.currentTarget.elements.namedItem("value") as HTMLInputElement | null)?.value;
        if (!window.confirm(`Send ${name} = ${value}${unit && !boolean ? ` ${unit}` : ""} to the PLC?`)) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="requestKey" defaultValue={state.key} key={state.key} />
      {boolean ? (
        <>
          <button type="submit" name="value" value="on" disabled={busy}>
            On
          </button>
          <button type="submit" name="value" value="off" disabled={busy}>
            Off
          </button>
        </>
      ) : (
        <>
          <input
            name="value"
            type="number"
            step="any"
            required
            min={min ?? undefined}
            max={max ?? undefined}
            aria-label={`New value for ${name}`}
            className="mono"
          />
          <button type="submit" disabled={busy}>
            Set
          </button>
        </>
      )}
      {state.error ? (
        <span className="error" role="alert">
          {state.error}
        </span>
      ) : null}
      {state.notice ? <span className="notice">{state.notice}</span> : null}
    </form>
  );
}
