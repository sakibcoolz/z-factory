"use client";

import { useActionState, useEffect, useState } from "react";
import { StatePill, type Tone } from "@/components/ui/state-pill";
import type { ScenarioReport, ScenarioRunState } from "@/lib/domain/scenario";

const STEP_TONE: Record<string, Tone> = { PASSED: "run", FAILED: "flt", SKIPPED: "off" };

const show = (value: number | boolean | null | undefined) =>
  value === undefined ? "" : value === null ? "—" : typeof value === "boolean" ? (value ? "ON" : "OFF") : String(value);

function Report({ report }: { report: ScenarioReport }) {
  return (
    <section className="flex flex-col gap-2" aria-label="Scenario report">
      <div className="flex flex-wrap items-center gap-2">
        <b className="mono text-fg-strong">{report.name}</b>
        <StatePill tone={report.status === "PASSED" ? "run" : "flt"}>{report.status.toLowerCase()}</StatePill>
        <span className="zf-sub mono">{`${report.durationS} s · run ${report.runId.slice(0, 8)}`}</span>
      </div>
      {report.failure ? (
        <p className="zf-error" role="alert">
          {report.failure}
        </p>
      ) : null}
      <table className="zf-tbl" aria-label="Steps">
        <thead>
          <tr>
            <th>#</th>
            <th>Step</th>
            <th>Result</th>
            <th>Read</th>
            <th>At</th>
          </tr>
        </thead>
        <tbody>
          {report.steps.map((step) => (
            <tr key={step.index} data-muted={step.status === "SKIPPED"}>
              <td className="mono">{step.index}</td>
              <td className="mono whitespace-normal">
                {step.label}
                {step.message ? <span className="zf-sub block">{step.message}</span> : null}
              </td>
              <td>
                <StatePill tone={STEP_TONE[step.status] ?? "neutral"}>{step.status.toLowerCase()}</StatePill>
              </td>
              <td className="mono">{show(step.observed)}</td>
              <td className="mono">{step.atS === null ? "—" : `${step.atS} s`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="zf-sub">
        {report.overrides.length === 0
          ? "The run changed no simulated value."
          : `Out of AUTO during the run: ${report.overrides
              .map(
                (entry) =>
                  `${entry.target} (${entry.mode.toLowerCase().replace("_", " ")}${
                    entry.value !== undefined
                      ? ` ${show(entry.value)}`
                      : entry.profile
                        ? ` ${entry.profile.from} → ${entry.profile.to} in ${entry.profile.durationS} s`
                        : ""
                  } at ${entry.atS} s)`,
              )
              .join(", ")}. All of them are back in AUTO.`}
      </p>
    </section>
  );
}

/**
 * The scenario editor: a scenario as JSON, run on the server against the running factory.
 * The run takes as long as its steps; the report says what passed, what was read and
 * which values were out of AUTO.
 */
export function ScenarioRunner({
  action,
  initial,
}: {
  action: (state: ScenarioRunState, formData: FormData) => Promise<ScenarioRunState>;
  initial: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!pending) return;
    const startedAt = Date.now();
    const timer = setInterval(() => setSeconds(Math.round((Date.now() - startedAt) / 1000)), 1000);
    return () => {
      clearInterval(timer);
      setSeconds(0);
    };
  }, [pending]);

  return (
    <div className="flex flex-col gap-3">
      <form action={formAction} className="flex flex-col gap-2">
        <label htmlFor="scenario-source" className="zf-k">
          Scenario (JSON)
        </label>
        <textarea
          id="scenario-source"
          name="scenario"
          className="zf-input mono min-h-72 text-xs"
          defaultValue={state.source ?? initial}
          spellCheck={false}
          // Keeps the text the run was made with after the action answered.
          key={state.source ?? "initial"}
        />
        <div className="flex items-center gap-2">
          <button type="submit" className="zf-btn" data-variant="primary" disabled={pending}>
            {pending ? `Running… ${seconds} s` : "Run scenario"}
          </button>
          <span className="zf-sub">
            Steps: WRITE (command or setpoint tag), FORCE (simulated sensor or switch), OVERRIDE / RAMP (process value),
            CLEAR, EXPECT (a PLC tag, within a time), WAIT.
          </span>
        </div>
        {state.message ? (
          <p className="zf-error" role="alert">
            {state.message}
          </p>
        ) : null}
      </form>
      {state.report ? <Report report={state.report} /> : null}
    </div>
  );
}
