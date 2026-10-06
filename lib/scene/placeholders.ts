import type { PlaceholderSpec } from "@/lib/domain/scene-view";

/**
 * The generic shape and footprint of each device category. A device whose catalog model
 * has no 3D asset is drawn as this shape; a model that has one is fitted into the same
 * space, so assets from any source stand in one scene at believable sizes.
 *
 * Sizes are round, generic values in metres. None is a vendor dimension.
 */

const spec = (kind: PlaceholderSpec["kind"], width: number, height: number, depth: number): PlaceholderSpec => ({
  kind,
  size: [width, height, depth],
});

const BY_CATEGORY: Record<string, PlaceholderSpec> = {
  // Controllers and drives: enclosures on the floor or modules on a rail.
  PLC: spec("cabinet", 0.8, 1.6, 0.5),
  RTU: spec("module", 0.4, 0.6, 0.3),
  VFD: spec("cabinet", 0.5, 1.1, 0.4),
  SERVO_DRIVE: spec("cabinet", 0.4, 1.0, 0.4),
  SOFT_STARTER: spec("cabinet", 0.4, 0.9, 0.35),
  MOTOR_STARTER: spec("module", 0.35, 0.6, 0.3),
  MOTION_CONTROLLER: spec("module", 0.4, 0.7, 0.3),
  PROCESS_CONTROLLER: spec("module", 0.35, 0.6, 0.3),
  TEMPERATURE_CONTROLLER: spec("module", 0.35, 0.6, 0.3),
  ROBOT_CONTROLLER: spec("cabinet", 0.7, 1.2, 0.6),
  SAFETY_RELAY: spec("module", 0.3, 0.55, 0.25),
  REMOTE_IO: spec("module", 0.5, 0.6, 0.3),
  IO_LINK_MASTER: spec("module", 0.35, 0.5, 0.25),
  GATEWAY: spec("module", 0.35, 0.55, 0.3),
  EDGE_GATEWAY: spec("module", 0.4, 0.55, 0.3),
  SIGNAL_CONDITIONER: spec("module", 0.25, 0.5, 0.25),
  TRANSMITTER: spec("sensor", 0.25, 0.6, 0.25),
  HMI: spec("panel", 0.6, 1.3, 0.2),
  RELAY: spec("module", 0.25, 0.45, 0.25),
  CONTACTOR: spec("module", 0.3, 0.5, 0.3),
  // Field and process equipment.
  MOTOR: spec("motor", 0.9, 0.55, 0.5),
  SERVO_MOTOR: spec("motor", 0.6, 0.4, 0.35),
  PUMP: spec("pump", 1.0, 0.7, 0.6),
  FAN: spec("fan", 0.9, 1.0, 0.5),
  BLOWER: spec("fan", 1.0, 1.0, 0.6),
  CONVEYOR: spec("conveyor", 2.4, 0.8, 0.8),
  MIXER: spec("vessel", 1.0, 1.6, 1.0),
  COMPRESSOR: spec("vessel", 1.4, 1.1, 0.8),
  VALVE: spec("valve", 0.6, 0.7, 0.35),
  ACTUATOR: spec("valve", 0.6, 0.5, 0.3),
  HEATER: spec("box", 0.8, 0.5, 0.5),
  INDICATOR: spec("lamp", 0.2, 1.4, 0.2),
  POWER_SUPPLY: spec("module", 0.3, 0.5, 0.3),
  SENSOR: spec("sensor", 0.25, 0.7, 0.25),
  PROXIMITY_SENSOR: spec("sensor", 0.2, 0.5, 0.2),
  SWITCH: spec("switch", 0.3, 1.0, 0.25),
  ENCODER: spec("sensor", 0.25, 0.35, 0.25),
};

/** A category the table does not know yet is still drawn: as a plain box. */
export const DEFAULT_PLACEHOLDER: PlaceholderSpec = spec("box", 0.6, 0.6, 0.6);

export function placeholderFor(categoryCode: string): PlaceholderSpec {
  return BY_CATEGORY[categoryCode] ?? DEFAULT_PLACEHOLDER;
}

/**
 * The uniform scale that makes a model of the given size fit the placeholder's space
 * without distorting it. A model without extent is left as it is.
 */
export function fitScale(
  modelSize: readonly [number, number, number],
  space: readonly [number, number, number],
): number {
  const ratios = modelSize.flatMap((length, axis) => (length > 0 ? [(space[axis] ?? 0) / length] : []));
  const scale = Math.min(...ratios);
  return ratios.length > 0 && Number.isFinite(scale) && scale > 0 ? scale : 1;
}
