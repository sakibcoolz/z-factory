/**
 * Shape the simulator screen of a stored factory renders (docs/design.md → Device
 * simulation UI). Pure types; importable anywhere.
 */
import type { RuntimeState } from "@/lib/domain/runtime-state";
import type { SignalKind, SimulatedType } from "@/lib/domain/simulation";

export type SimulatedSignalView = {
  key: string;
  label: string;
  kind: SignalKind;
  unit: string | null;
  /** Live value from simulator memory; null while the simulation is not running. */
  value: number | boolean | null;
  /** The PLC tag the signal is wired to, e.g. `PLC-01 · VFD_01_RUN`; null when it is not wired. */
  tag: string | null;
};

export type SimulatedFaultView = {
  code: string;
  name: string;
  /** A latching fault trips the device until it is reset. */
  latching: boolean;
  active: boolean;
};

export type SimulatedDeviceView = {
  deviceId: string;
  name: string;
  type: SimulatedType;
  /** The model's own state, e.g. `RAMPING`; null while the simulation is not running. */
  state: string | null;
  faulted: boolean;
  tripped: boolean;
  quality: "GOOD" | "BAD" | null;
  /** Command and setpoint signals: what PLC logic drives. */
  inputs: SimulatedSignalView[];
  /** Feedback signals: what the simulated device answers. */
  outputs: SimulatedSignalView[];
  faults: SimulatedFaultView[];
};

export type SimulationView = {
  running: boolean;
  tickMs: number | null;
  ticks: number | null;
  startedAt: string | null;
  /** Set when the last cycle failed. */
  lastError: string | null;
  devices: SimulatedDeviceView[];
  /** Devices of the factory the simulator leaves alone, and why. */
  skipped: Array<{ deviceId: string; name: string; reason: string }>;
  /** PLCs the simulated devices are wired to. */
  plcs: Array<{ id: string; name: string; runtimeStatus: RuntimeState; endpointReady: boolean }>;
  /** Why the simulation cannot be started right now; null when it can. */
  blocker: string | null;
};
