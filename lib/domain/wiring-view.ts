/**
 * Shapes the wiring service returns and the wiring editor renders (TASK-307). Pure types;
 * importable anywhere.
 */
import type { WireEndpointKind, WireEndpointType } from "@/lib/validation/wiring";

/** One end of a stored wire. */
export type WireEndView = {
  deviceId: string;
  deviceName: string;
  type: WireEndpointType;
  /** Id of the terminal definition, the I/O point or the port. */
  endpointId: string;
  label: string;
  /** `PT-101 / OUT` */
  name: string;
};

/** One stored wire between two exact endpoints. */
export type WireView = {
  id: string;
  kind: WireEndpointKind;
  from: WireEndView;
  to: WireEndView;
  /** The tag a PLC I/O wire carries, and its address in the program. */
  tagName: string | null;
  logicalAddress: string | null;
};

export type WiringEndpointView = {
  /** Unique within its device: `<type>:<id>`. */
  key: string;
  type: WireEndpointType;
  id: string;
  label: string;
  kind: WireEndpointKind;
  /** `digital output · 24 V DC` */
  summary: string;
  maxConnections: number;
  /** The wires on it now, to any device. */
  wires: Array<{ wireId: string; otherName: string }>;
};

export type WiringDeviceView = { deviceId: string; name: string; endpoints: WiringEndpointView[] };

/** Everything the editor needs to wire two devices pin by pin. */
export type PairWiringView = {
  first: WiringDeviceView;
  second: WiringDeviceView;
  /** The wires between the two devices. */
  wires: WireView[];
  /**
   * Why an endpoint of the first device cannot be wired to one of the second:
   * `refusals[firstKey][secondKey]`. A pair that is absent can be wired.
   */
  refusals: Record<string, Record<string, string>>;
  /** The rule behind each refusal, keyed the same way (TASK-1007). */
  rules: Record<string, Record<string, string>>;
  /** The wire that is being replaced: it does not count against its endpoints. */
  replacingWireId: string | null;
};
