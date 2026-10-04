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
