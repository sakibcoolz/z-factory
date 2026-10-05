/** Runtime states every device/factory can visibly be in (docs/design.md → Runtime state). */
export const RUNTIME_STATES = [
  "STOPPED",
  "STARTING",
  "RUNNING",
  "DEGRADED",
  "FAULTED",
  "STOPPING",
  "DISCONNECTED",
] as const;

export type RuntimeState = (typeof RUNTIME_STATES)[number];

/** Human-readable label, e.g. `RUNNING` -> `Running`. */
export function runtimeStateLabel(state: RuntimeState): string {
  return state.charAt(0) + state.slice(1).toLowerCase();
}

/** How a state is shown everywhere: the tone names of the design system's state colours. */
export type StateTone = "run" | "deg" | "flt" | "start" | "off" | "disc";

const STATE_TONE: Record<RuntimeState, StateTone> = {
  STOPPED: "off",
  STARTING: "start",
  RUNNING: "run",
  DEGRADED: "deg",
  FAULTED: "flt",
  STOPPING: "start",
  DISCONNECTED: "disc",
};

/** One rule for pills, the 2D topology and the 3D view: green runs, red is a fault, amber is degraded, purple is disconnected. */
export function runtimeStateTone(state: RuntimeState): StateTone {
  return STATE_TONE[state];
}
