/**
 * Which connections two devices of a factory can have (docs/design.md → Factory Designer).
 * Pure functions: they decide from catalog facts, not from occupancy; whether a PLC still
 * has free channels is checked when the connection is made.
 */
import { DRIVE_CATEGORY_CODES, MOTOR_CATEGORY_CODES } from "@/lib/domain/device";

export type TopologyParty = {
  id: string;
  name: string;
  isPlc: boolean;
  categoryCode: string;
  simulatorType: string;
  requiresMotor: boolean;
  /** The model has terminals that can be wired to PLC channels. */
  hasTerminals: boolean;
  /** Protocols the model has a communication port for. */
  protocols: readonly string[];
};

/** How a link is made. `WIRE_IO` wires every terminal of a device to PLC channels. */
export const LINK_KINDS = [
  "WIRE_IO",
  "COMMUNICATES_WITH",
  "DRIVES",
  "MECHANICALLY_DRIVES",
  "MEASURES",
  "CONTROLS",
] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export type LinkOption = {
  kind: LinkKind;
  /** Direction the relationship is stored in, whichever way the edge was drawn. */
  sourceId: string;
  targetId: string;
  label: string;
};

/** Categories that command other devices without being a PLC or a drive. */
const CONTROLLER_CATEGORY_CODES: readonly string[] = [
  "MOTION_CONTROLLER",
  "PROCESS_CONTROLLER",
  "TEMPERATURE_CONTROLLER",
  "ROBOT_CONTROLLER",
  "SAFETY_RELAY",
  "REMOTE_IO",
  "IO_LINK_MASTER",
  "MOTOR_STARTER",
  "CONTACTOR",
  "RELAY",
];

const isSensorLike = (party: TopologyParty) => party.simulatorType === "SENSOR" || party.simulatorType === "SWITCH";
const shared = (a: TopologyParty, b: TopologyParty) => a.protocols.filter((protocol) => b.protocols.includes(protocol));
const protocolName = (protocol: string) => protocol.replace("MODBUS_TCP", "Modbus TCP");

/**
 * The connections possible between two devices. `from` is where the edge was started,
 * `to` where it ended; each option carries the direction it is stored in.
 */
export function linkOptions(from: TopologyParty, to: TopologyParty): LinkOption[] {
  // PLC-to-PLC communication is a later phase.
  if (from.id === to.id || (from.isPlc && to.isPlc)) return [];
  const options: LinkOption[] = [];
  const add = (kind: LinkKind, source: TopologyParty, target: TopologyParty, label: string) => {
    if (!options.some((option) => option.kind === kind))
      options.push({ kind, sourceId: source.id, targetId: target.id, label });
  };

  const plc = from.isPlc ? from : to.isPlc ? to : undefined;
  if (plc) {
    const device = plc === from ? to : from;
    if (device.hasTerminals) add("WIRE_IO", plc, device, `Wire ${device.name} to free channels of ${plc.name}`);
    for (const protocol of shared(plc, device))
      add("COMMUNICATES_WITH", plc, device, `${plc.name} talks to ${device.name} over ${protocolName(protocol)}`);
    return options;
  }

  for (const [a, b] of [
    [from, to],
    [to, from],
  ] as const) {
    if (DRIVE_CATEGORY_CODES.includes(a.categoryCode) && MOTOR_CATEGORY_CODES.includes(b.categoryCode)) {
      add("DRIVES", a, b, `${a.name} drives ${b.name}`);
    }
    if (MOTOR_CATEGORY_CODES.includes(a.categoryCode) && b.requiresMotor) {
      add("MECHANICALLY_DRIVES", a, b, `${a.name} mechanically drives ${b.name}`);
    }
    if (isSensorLike(a) && !isSensorLike(b)) add("MEASURES", a, b, `${a.name} measures ${b.name}`);
  }
  if (CONTROLLER_CATEGORY_CODES.includes(from.categoryCode))
    add("CONTROLS", from, to, `${from.name} controls ${to.name}`);
  for (const protocol of shared(from, to))
    add("COMMUNICATES_WITH", from, to, `${from.name} talks to ${to.name} over ${protocolName(protocol)}`);
  return options;
}

/** Position for a device that was never placed: a grid, in list order. */
export function defaultPosition(index: number): { x: number; y: number } {
  const columns = 4;
  return { x: 60 + (index % columns) * 240, y: 60 + Math.floor(index / columns) * 150 };
}
