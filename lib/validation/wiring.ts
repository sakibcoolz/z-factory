/**
 * Rules of one wire between two exact endpoints (TASK-307, ADR-0014). An endpoint is a
 * terminal of a device, an I/O point of a PLC, or a communication port. Pure functions:
 * the wiring service asks them before anything is stored, and the wiring editor shows
 * their answer for every possible destination.
 */
import { signalTypeLabel } from "@/lib/catalog/format";
import { signalFits } from "@/lib/domain/catalog";
import type { ConnectionRelationship, IoPointType, IoSignalClass, TerminalKind } from "@/lib/domain/device";

export const WIRE_ENDPOINT_TYPES = ["DEVICE_IO", "PLC_IO_POINT", "PROTOCOL_PORT"] as const;
export type WireEndpointType = (typeof WIRE_ENDPOINT_TYPES)[number];

/** What an endpoint is for. A communication port is a bus endpoint. */
export type WireEndpointKind = TerminalKind | "BUS";

/** Whether the endpoint drives or supplies (OUT), reads or takes (IN), or neither (common, earth, bus). */
export type WireFlow = "OUT" | "IN" | "NONE";

export type WireEndpoint = {
  deviceId: string;
  deviceName: string;
  type: WireEndpointType;
  /** Id of the terminal definition, the PLC I/O point or the communication port. */
  id: string;
  /** Terminal label, channel label or port name. */
  label: string;
  kind: WireEndpointKind;
  flow: WireFlow;
  signalClass: IoSignalClass | null;
  /** The signal standard, or the supply voltage of a power terminal. */
  signalType: string | null;
  /** Further standards a PLC channel can be configured for. */
  acceptedSignalTypes: readonly string[];
  /** Protocols of a communication port. */
  protocols: readonly string[];
  /** How many wires the endpoint takes: 1 unless the catalog marks it as shared. */
  maxConnections: number;
  /**
   * The wires on the endpoint now, each with its other end. A terminal id belongs to a
   * catalog model, so an end is only identified together with its device.
   */
  wires: ReadonlyArray<{ wireId: string; otherDeviceId: string; otherEndpointId: string; otherName: string }>;
};

export type WireRule =
  /** Both endpoints belong to the same device. */
  | "wire-same-device"
  /** A signal terminal and a supply terminal, an earth terminal and a port, … */
  | "wire-kind"
  /** Two outputs, or two inputs. */
  | "wire-direction"
  /** Digital against analog. */
  | "wire-signal-class"
  /** The electrical standard or range of one end is not accepted by the other. */
  | "wire-signal-type"
  /** Two ports without a common protocol. */
  | "wire-protocol"
  /** The two endpoints are already wired to each other. */
  | "wire-duplicate"
  /** An endpoint has all the wires it takes. */
  | "wire-occupied";

export type WireRefusal = { rule: WireRule; message: string };

/** `PT-101 / OUT`: how an endpoint is named in every message. */
export const endpointName = (endpoint: Pick<WireEndpoint, "deviceName" | "label">) =>
  `${endpoint.deviceName} / ${endpoint.label}`;

const KIND_TEXT: Record<WireEndpointKind, string> = {
  SIGNAL: "a signal terminal",
  POWER: "a supply terminal",
  COMMON: "a 0 V terminal",
  EARTH: "an earth terminal",
  BUS: "a communication port",
};

/** What the endpoint is, in a few words: `digital output · 24 V DC`, `supply input · 24 V DC`, `earth`. */
export function endpointSummary(endpoint: WireEndpoint): string {
  const standard = endpoint.signalType ? signalTypeLabel(endpoint.signalType) : null;
  const direction = endpoint.flow === "OUT" ? "output" : "input";
  switch (endpoint.kind) {
    case "SIGNAL":
      return [`${endpoint.signalClass === "ANALOG" ? "analog" : "digital"} ${direction}`, standard]
        .filter(Boolean)
        .join(" · ");
    case "POWER":
      return [`supply ${direction}`, standard].filter(Boolean).join(" · ");
    case "COMMON":
      return "0 V / common";
    case "EARTH":
      return "protective earth";
    default:
      return endpoint.protocols.map((protocol) => protocol.replace("MODBUS_TCP", "Modbus TCP")).join(", ") || "port";
  }
}

const refusal = (rule: WireRule, message: string): WireRefusal => ({ rule, message });

function occupied(endpoint: WireEndpoint, ignoreWireId: string | undefined): WireRefusal | null {
  const wires = endpoint.wires.filter((wire) => wire.wireId !== ignoreWireId);
  if (wires.length < endpoint.maxConnections) return null;
  const name = endpointName(endpoint);
  return refusal(
    "wire-occupied",
    endpoint.maxConnections === 1
      ? `${name} already has its wire, to ${wires[0]?.otherName ?? "another endpoint"}.`
      : `${name} already has ${wires.length} of the ${endpoint.maxConnections} wires it takes.`,
  );
}

/**
 * Why two endpoints cannot be wired together, or null when they can. `ignoreWireId` names
 * a wire that is being replaced: it does not count against the endpoints it is on.
 */
export function checkWire(a: WireEndpoint, b: WireEndpoint, ignoreWireId?: string): WireRefusal | null {
  const [nameA, nameB] = [endpointName(a), endpointName(b)];
  if (a.deviceId === b.deviceId) {
    return refusal("wire-same-device", `${nameA} and ${nameB} are on the same device.`);
  }
  if (a.kind !== b.kind) {
    return refusal(
      "wire-kind",
      `${nameA} is ${KIND_TEXT[a.kind]} and ${nameB} is ${KIND_TEXT[b.kind]}; only endpoints of the same kind are wired together.`,
    );
  }

  if (a.kind === "SIGNAL" || a.kind === "POWER") {
    if (a.flow === b.flow) {
      const verb =
        a.kind === "POWER"
          ? a.flow === "OUT"
            ? "supply the voltage"
            : "take the supply"
          : a.flow === "OUT"
            ? "drive a signal"
            : "read a signal";
      return refusal("wire-direction", `${nameA} and ${nameB} both ${verb}; an output is wired to an input.`);
    }
    if (a.kind === "SIGNAL" && a.signalClass !== b.signalClass) {
      const text = (endpoint: WireEndpoint) => (endpoint.signalClass === "ANALOG" ? "analog" : "digital");
      return refusal("wire-signal-class", `${nameA} is ${text(a)} and ${nameB} is ${text(b)}.`);
    }
    // A PLC channel says what it can be set to; between two devices the reading end has to take what is driven.
    const [receiver, driver] = a.flow === "IN" ? [a, b] : [b, a];
    const [host, guest] = a.type === "PLC_IO_POINT" ? [a, b] : b.type === "PLC_IO_POINT" ? [b, a] : [receiver, driver];
    const supported = [host.signalType, ...host.acceptedSignalTypes].filter((type): type is string => !!type);
    if (guest.signalType && !supported.some((type) => signalFits(type, guest.signalType as string))) {
      return refusal(
        "wire-signal-type",
        `${endpointName(guest)} is ${signalTypeLabel(guest.signalType)}; ${endpointName(host)} takes ${supported.map(signalTypeLabel).join(", ") || "no signal"}.`,
      );
    }
  }

  if (a.kind === "BUS" && !a.protocols.some((protocol) => b.protocols.includes(protocol))) {
    return refusal("wire-protocol", `${nameA} and ${nameB} have no protocol in common.`);
  }

  const toB = (wire: WireEndpoint["wires"][number]) =>
    wire.otherDeviceId === b.deviceId && wire.otherEndpointId === b.id;
  if (a.wires.some((wire) => wire.wireId !== ignoreWireId && toB(wire))) {
    return refusal("wire-duplicate", `${nameA} is already wired to ${nameB}.`);
  }
  return occupied(a, ignoreWireId) ?? occupied(b, ignoreWireId);
}

/**
 * How a wire is stored: from the end that drives or supplies to the end that reads or
 * takes. Common, earth and bus wires have no direction and keep the order they were given in.
 */
export function orientWire(a: WireEndpoint, b: WireEndpoint): { source: WireEndpoint; target: WireEndpoint } {
  return b.flow === "OUT" || a.flow === "IN" ? { source: b, target: a } : { source: a, target: b };
}

/**
 * The relationship a wire is stored with. PLC I/O keeps the meaning it always had: the
 * PLC controls what it drives, and a device feeds back what the PLC reads.
 */
export function wireRelationship(source: WireEndpoint, target: WireEndpoint): ConnectionRelationship {
  if (source.kind === "BUS") return "COMMUNICATES_WITH";
  if (source.type === "PLC_IO_POINT") return "CONTROLS";
  if (target.type === "PLC_IO_POINT") return "FEEDS_BACK_TO";
  return "WIRED_TO";
}

/** A PLC channel as an endpoint: an input point reads, an output point drives. */
export function pointFlow(ioType: IoPointType): { flow: WireFlow; signalClass: IoSignalClass } {
  return {
    flow: ioType === "DO" || ioType === "AO" ? "OUT" : "IN",
    signalClass: ioType === "AI" || ioType === "AO" ? "ANALOG" : "DIGITAL",
  };
}
