import type { ReactNode } from "react";

type KeyValueProps = {
  rows: ReadonlyArray<readonly [label: ReactNode, value: ReactNode]>;
  /** Drop the padding and bottom rule, for use inside a cell. */
  bare?: boolean;
  className?: string;
};

export function KeyValue({ rows, bare = false, className }: KeyValueProps) {
  return (
    <dl className={className ? `zf-kv ${className}` : "zf-kv"} data-bare={bare}>
      {rows.map(([label, value], index) => (
        <div key={index} className="contents">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

type FieldProps = {
  label: string;
  value: ReactNode;
  mono?: boolean;
  state?: "focus" | "invalid";
  size?: "md" | "sm" | "area";
  className?: string;
};

/** Read-only field rendering; real form controls arrive with the owning feature task. */
export function Field({ label, value, mono = false, state, size = "md", className }: FieldProps) {
  return (
    <div className={className ? `zf-f ${className}` : "zf-f"}>
      <span className="zf-k">{label}</span>
      <div className={mono ? "zf-in mono" : "zf-in"} data-state={state} data-size={size}>
        {value}
      </div>
    </div>
  );
}

type SectionRuleProps = {
  children: ReactNode;
};

/** Kicker label followed by a rule that fills the row. */
export function SectionRule({ children }: SectionRuleProps) {
  return <div className="zf-sec">{children}</div>;
}

type GaugeProps = {
  /** 0–100 */
  percent: number;
  label: string;
};

export function Gauge({ percent, label }: GaugeProps) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div
      className="zf-gauge"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
    >
      <span style={{ width: `${clamped}%` }} />
    </div>
  );
}

type SparkProps = {
  /** Pre-rendered block-character trend; decorative until live telemetry exists. */
  trend: string;
  tone?: "info" | "warn" | "idle";
};

export function Spark({ trend, tone = "info" }: SparkProps) {
  return (
    <span className="zf-spark" data-tone={tone} aria-hidden="true">
      {trend}
    </span>
  );
}

export type PinState = "free" | "occupied" | "selected" | "invalid";

type PinProps = {
  label: string;
  state?: PinState;
};

export function Pin({ label, state = "free" }: PinProps) {
  return (
    <span className="zf-pin" data-state={state} title={state}>
      {label}
    </span>
  );
}

type PinRowProps = {
  pins: ReadonlyArray<{ label: string; state?: PinState }>;
};

export function PinRow({ pins }: PinRowProps) {
  return (
    <div className="zf-pins">
      {pins.map((pin, index) => (
        <Pin key={index} label={pin.label} state={pin.state} />
      ))}
    </div>
  );
}

type PinKeyProps = {
  state: PinState;
  children: ReactNode;
};

export function PinKey({ state, children }: PinKeyProps) {
  return (
    <span>
      <span className="zf-pin" data-state={state} data-size="key" aria-hidden="true" /> {children}
    </span>
  );
}

export type StepState = "done" | "current" | "todo";

type StepListProps = {
  steps: ReadonlyArray<{ marker: string; label: string; state: StepState }>;
  dense?: boolean;
};

export function StepList({ steps, dense = false }: StepListProps) {
  return (
    <ol className="zf-tree">
      {steps.map((step) => (
        <li
          key={step.label}
          className="zf-step"
          data-state={step.state}
          data-dense={dense}
          aria-current={step.state === "current" ? "step" : undefined}
        >
          <span className="zf-step-no">{step.marker}</span>
          {step.label}
        </li>
      ))}
    </ol>
  );
}

export type LogLevel = "info" | "warn" | "crit";

type LogProps = {
  rows: ReadonlyArray<{ time: string; level: LogLevel; label: string; message: ReactNode }>;
};

export function Log({ rows }: LogProps) {
  return (
    <div className="zf-log" role="log">
      {rows.map((row, index) => (
        <div key={index} className="zf-log-row">
          <span className="zf-log-ts">{row.time}</span>
          <span className="zf-log-lv" data-level={row.level}>
            {row.label}
          </span>
          <span>{row.message}</span>
        </div>
      ))}
    </div>
  );
}
