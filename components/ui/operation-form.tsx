"use client";

import { useActionState, useEffect, useState } from "react";
import { EMPTY_OPERATION_STATE, type OperationState } from "@/lib/plc/operation-state";

export type OperationButton = {
  /** Submitted as the form's `operation` field. */
  operation: string;
  label: string;
  /** Shown on the button while its operation runs, e.g. "Starting…". */
  pendingLabel: string;
  variant?: "default" | "primary" | "danger" | "ghost";
  disabled?: boolean;
  /** Why the button is disabled, or what it does. */
  title?: string;
  /** Asked before the operation runs; the button then needs a second press. */
  confirm?: string;
};

type OperationFormProps = {
  /** Server action; it stays on the page and returns what happened. */
  action: (state: OperationState, formData: FormData) => Promise<OperationState>;
  buttons: readonly OperationButton[];
  size?: "md" | "sm";
  /** Shown while an operation runs, e.g. why it can take long. */
  pendingHint?: string;
  /** Accessible name of the button group. */
  label: string;
  /** Values submitted with every operation, e.g. what the operation applies to. */
  fields?: Readonly<Record<string, string>>;
};

/** Seconds since `running` became true; long operations show that they are still going. */
function useElapsedSeconds(running: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!running) return;
    const startedAt = Date.now();
    const timer = setInterval(() => setSeconds(Math.round((Date.now() - startedAt) / 1000)), 1000);
    return () => {
      clearInterval(timer);
      setSeconds(0);
    };
  }, [running]);
  return seconds;
}

/**
 * A row of operation buttons sharing one server action. While an operation runs every
 * button is disabled, the pressed one says what is happening and for how long, and the
 * result (or the reason for a failure) is announced below.
 */
export function OperationForm({ action, buttons, size = "md", pendingHint, label, fields }: OperationFormProps) {
  const [state, formAction, pending] = useActionState(action, EMPTY_OPERATION_STATE);
  const [pressed, setPressed] = useState<string>();
  const [confirming, setConfirming] = useState<string>();
  const seconds = useElapsedSeconds(pending);
  const asked = buttons.find((button) => button.operation === confirming);

  return (
    <form action={formAction} className="flex flex-col gap-1.5" aria-label={label}>
      {Object.entries(fields ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <div className="flex flex-wrap items-center gap-1.5">
        {buttons.map((button) => {
          const running = pending && pressed === button.operation;
          const needsConfirm = Boolean(button.confirm) && confirming !== button.operation;
          return (
            <button
              key={button.operation}
              type="submit"
              name="operation"
              value={button.operation}
              className="zf-btn"
              data-variant={button.variant ?? "default"}
              data-size={size}
              disabled={pending || button.disabled}
              title={button.title}
              onClick={(event) => {
                if (needsConfirm) {
                  // The first press of a confirmed operation only asks; nothing is submitted.
                  event.preventDefault();
                  setConfirming(button.operation);
                } else {
                  setPressed(button.operation);
                  setConfirming(undefined);
                }
              }}
            >
              {running
                ? `${button.pendingLabel}${seconds >= 3 ? ` ${seconds} s` : ""}`
                : confirming === button.operation
                  ? `Confirm: ${button.label.toLowerCase()}`
                  : button.label}
            </button>
          );
        })}
        {asked && !pending ? (
          <button
            type="button"
            className="zf-btn"
            data-variant="ghost"
            data-size={size}
            onClick={() => setConfirming(undefined)}
          >
            Keep
          </button>
        ) : null}
      </div>
      <div role="status" aria-live="polite" className="flex flex-col gap-1">
        {asked && !pending ? <p className="zf-error whitespace-normal">{asked.confirm}</p> : null}
        {pending && pendingHint ? <p className="zf-sub">{pendingHint}</p> : null}
        {!pending && !asked && state.message ? <p className="zf-error whitespace-normal">{state.message}</p> : null}
        {!pending && !asked && state.notice ? <p className="zf-notice whitespace-normal">{state.notice}</p> : null}
      </div>
    </form>
  );
}
