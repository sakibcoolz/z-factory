import type { ReactNode } from "react";
import { type RuntimeState, runtimeStateLabel } from "@/lib/domain/runtime-state";
import type { TagQuality } from "@/lib/domain/tag";

export type Tone = "run" | "deg" | "flt" | "start" | "off" | "disc" | "neutral";

const RUNTIME_STATE_TONE: Record<RuntimeState, Tone> = {
  STOPPED: "off",
  STARTING: "start",
  RUNNING: "run",
  DEGRADED: "deg",
  FAULTED: "flt",
  STOPPING: "start",
  DISCONNECTED: "disc",
};

const TAG_QUALITY_TONE: Record<TagQuality, Tone> = {
  GOOD: "run",
  STALE: "deg",
  BAD: "flt",
  DISCONNECTED: "disc",
};

export function runtimeStateTone(state: RuntimeState): Tone {
  return RUNTIME_STATE_TONE[state];
}

export function tagQualityTone(quality: TagQuality): Tone {
  return TAG_QUALITY_TONE[quality];
}

type StatePillProps = {
  tone?: Tone;
  /** Accessible name when the pill is rendered as a bare status dot. */
  label?: string;
  children?: ReactNode;
};

export function StatePill({ tone = "neutral", label, children }: StatePillProps) {
  return (
    <span className="zf-st" data-tone={tone} role={label ? "img" : undefined} aria-label={label}>
      {children}
    </span>
  );
}

type RuntimeStatePillProps = {
  state: RuntimeState;
  /** Render only the status dot; the state name becomes the accessible label. */
  dot?: boolean;
  children?: ReactNode;
};

export function RuntimeStatePill({ state, dot = false, children }: RuntimeStatePillProps) {
  const label = runtimeStateLabel(state);
  if (dot) {
    return <StatePill tone={runtimeStateTone(state)} label={label} />;
  }
  return <StatePill tone={runtimeStateTone(state)}>{children ?? label}</StatePill>;
}
