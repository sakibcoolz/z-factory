import type { LiveDeviceState } from "@/lib/domain/live";
import { type RuntimeState, runtimeStateLabel, runtimeStateTone, type StateTone } from "@/lib/domain/runtime-state";
import { type EdgeTone, edgeTone } from "@/lib/topology/flow";

/**
 * How runtime state is shown in the 3D view. The rules are the ones of the pills and the
 * 2D topology (`runtimeStateTone`, `edgeTone`); what this adds is honesty about how
 * current a state is: a state the live stream does not vouch for is never shown as healthy.
 */

export type DeviceAppearance = {
  /** The state as last known. */
  status: RuntimeState;
  tone: StateTone;
  /** Text shown with the device, e.g. `Running`, `Running · stale`, `No answer`. */
  label: string;
  /** Whether the live stream vouches for this state right now. */
  live: boolean;
  /** A fault draws attention to itself. */
  pulse: boolean;
};

/** States that say "all is well" or "on its way": the ones that must not be shown when unconfirmed. */
const UNCONFIRMED_AS_STALE = new Set<RuntimeState>(["RUNNING", "STARTING", "STOPPING"]);

/**
 * `stored` is the state the page was rendered with, `live` what the stream last said,
 * `streamLive` whether the stream is connected now.
 */
export function deviceAppearance(
  stored: RuntimeState,
  live: Pick<LiveDeviceState, "status" | "quality"> | undefined,
  streamLive: boolean,
): DeviceAppearance {
  const status = live?.status ?? stored;

  if (!streamLive || !live) {
    // Nobody confirms the state: a fault or a stop is still shown, health is not.
    const stale = UNCONFIRMED_AS_STALE.has(status);
    return {
      status,
      tone: stale ? "deg" : runtimeStateTone(status),
      label: stale ? `${runtimeStateLabel(status)} · stale` : runtimeStateLabel(status),
      live: false,
      pulse: false,
    };
  }
  if (live.quality === "DISCONNECTED" && status !== "STOPPED" && status !== "FAULTED") {
    // The runtime should be there and does not answer.
    return { status, tone: "disc", label: "No answer", live: true, pulse: false };
  }
  const tone = runtimeStateTone(status);
  return { status, tone, label: runtimeStateLabel(status), live: true, pulse: tone === "flt" };
}

export type ConnectionAppearance = {
  tone: EdgeTone;
  /** A healthy connection between two running devices shows flow; nothing else moves. */
  animated: boolean;
};

/** What a connection may conclude from one of its ends: a confirmed state, or a fault however old. */
function endState(end: DeviceAppearance | undefined): RuntimeState | undefined {
  if (!end) return undefined;
  if (end.status === "FAULTED") return "FAULTED";
  return end.live && end.tone !== "disc" ? end.status : undefined;
}

/**
 * The same rule as the 2D topology: red when either end is faulted, active when both
 * ends run. An end whose state is unconfirmed or that does not answer makes the
 * connection idle, never active.
 */
export function connectionAppearance(
  source: DeviceAppearance | undefined,
  target: DeviceAppearance | undefined,
): ConnectionAppearance {
  const tone = edgeTone(endState(source), endState(target));
  return { tone, animated: tone === "active" };
}

/** Whether anything in the scene moves, so the renderer only runs continuously when it has to. */
export function sceneIsAnimated(
  devices: Iterable<DeviceAppearance>,
  connections: Iterable<ConnectionAppearance>,
): boolean {
  for (const device of devices) if (device.pulse) return true;
  for (const connection of connections) if (connection.animated) return true;
  return false;
}
