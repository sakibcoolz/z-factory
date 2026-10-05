/**
 * Which recorded events raise or clear an alarm. Pure rules; the alarm service applies
 * them to the database. An alarm is a condition with a beginning and an end that an
 * operator can acknowledge; an event is a single moment.
 */
import type { EventSeverity, RuntimeEventEnvelope } from "@/lib/domain/events";

/** A fault of a simulated device, e.g. `FAULT:OVERCURRENT`. */
export const FAULT_ALARM_PREFIX = "FAULT:";
/** An ALARM tag the PLC program set, e.g. `TAG:Pump01_HighPressureTrip`. */
export const TAG_ALARM_PREFIX = "TAG:";
/** The PLC's runtime failed: its container died or an operation on it failed. */
export const RUNTIME_FAULT_ALARM = "RUNTIME_FAULT";
/** A PLC with a started runtime does not answer on Modbus. */
export const PLC_LINK_ALARM = "PLC_LINK_DOWN";
/** `payload.link` of the connection events the tag monitor records. */
export const TAG_MONITOR_LINK = "tag-monitor";

export type AlarmEffect =
  | { kind: "RAISE"; deviceId: string | null; code: string; severity: EventSeverity; message: string }
  | { kind: "CLEAR"; deviceId: string | null; code: string }
  /** The device left its faulted state: its fault alarms end, except faults still present. */
  | { kind: "CLEAR_DEVICE_FAULTS"; deviceId: string; stillActive: string[] }
  /** The simulation stopped: its devices and links no longer exist in any state. */
  | { kind: "CLEAR_SIMULATION" };

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const codes = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export function alarmEffects(event: RuntimeEventEnvelope): AlarmEffect[] {
  const { deviceId, payload } = event;
  switch (event.type) {
    case "FAULT_INJECTED": {
      const code = text(payload.code);
      if (!deviceId || !code) return [];
      return [
        {
          kind: "RAISE",
          deviceId,
          code: `${FAULT_ALARM_PREFIX}${code}`,
          severity: event.severity,
          message: text(payload.name) ?? code,
        },
      ];
    }
    case "FAULT_CLEARED": {
      const code = text(payload.code);
      // A latching fault keeps the device tripped: its alarm ends with the reset, not here.
      if (!deviceId || !code || payload.stillTripped === true) return [];
      return [{ kind: "CLEAR", deviceId, code: `${FAULT_ALARM_PREFIX}${code}` }];
    }
    case "DEVICE_RESET":
      return deviceId ? [{ kind: "CLEAR_DEVICE_FAULTS", deviceId, stillActive: codes(payload.activeFaults) }] : [];
    case "DEVICE_FAULTED":
      return [
        {
          kind: "RAISE",
          deviceId,
          code: RUNTIME_FAULT_ALARM,
          severity: "CRITICAL",
          message: text(payload.action) ? `PLC runtime fault during ${text(payload.action)}` : "PLC runtime fault",
        },
      ];
    case "DEVICE_RUNNING":
    case "DEVICE_STOPPED":
    case "DEVICE_STARTING":
      return [{ kind: "CLEAR", deviceId, code: RUNTIME_FAULT_ALARM }];
    // Both the simulator and the tag monitor report their link to a PLC. The monitor runs
    // whenever the PLC should be up, so its link is the one that raises the alarm.
    case "CONNECTION_DOWN":
      if (payload.link !== TAG_MONITOR_LINK) return [];
      return [
        {
          kind: "RAISE",
          deviceId,
          code: PLC_LINK_ALARM,
          severity: "WARNING",
          message: "The PLC does not answer on Modbus",
        },
      ];
    case "CONNECTION_UP":
      return payload.link === TAG_MONITOR_LINK ? [{ kind: "CLEAR", deviceId, code: PLC_LINK_ALARM }] : [];
    case "SIMULATION_STOPPED":
      return [{ kind: "CLEAR_SIMULATION" }];
    default:
      break;
  }

  if (!deviceId || !event.type.endsWith("_STATE_CHANGED")) return [];
  // A PLC runtime reporting a state other than faulted.
  if (text(payload.state) && payload.state !== "FAULTED") {
    return [{ kind: "CLEAR", deviceId, code: RUNTIME_FAULT_ALARM }];
  }
  // A simulated device leaving its faulted state, by operator reset or by the PLC's reset signal.
  if (payload.from === "FAULTED" && payload.to !== "FAULTED") {
    return [{ kind: "CLEAR_DEVICE_FAULTS", deviceId, stillActive: codes(payload.activeFaults) }];
  }
  return [];
}

/** `FAULT:OVERCURRENT` → `OVERCURRENT`, `TAG:HighPressure` → `HighPressure`. */
export function alarmCodeLabel(code: string): string {
  for (const prefix of [FAULT_ALARM_PREFIX, TAG_ALARM_PREFIX]) {
    if (code.startsWith(prefix)) return code.slice(prefix.length);
  }
  return code;
}

export type AlarmState = "ACTIVE_UNACKNOWLEDGED" | "ACTIVE_ACKNOWLEDGED" | "CLEARED_UNACKNOWLEDGED" | "CLEARED";

export function alarmState(alarm: { clearedAt: unknown; acknowledgedAt: unknown }): AlarmState {
  if (alarm.clearedAt === null || alarm.clearedAt === undefined) {
    return alarm.acknowledgedAt ? "ACTIVE_ACKNOWLEDGED" : "ACTIVE_UNACKNOWLEDGED";
  }
  return alarm.acknowledgedAt ? "CLEARED" : "CLEARED_UNACKNOWLEDGED";
}
