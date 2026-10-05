/**
 * Generic device categories (docs/database.md → DeviceCategory).
 *
 * These are category-level facts about how Z-Factory simulates and relates devices.
 * They are NOT vendor specifications: vendor models, I/O counts, registers and limits
 * come only from the verified catalog definitions under `lib/catalog/vendor/`.
 *
 * How a device is controlled (direct I/O, parameters, protocol, program) is declared per
 * model, never here.
 */
import type { DriveType, SimulatorType } from "@/lib/generated/prisma/enums";

export type GenericCategory = {
  code: string;
  name: string;
  simulatorType: SimulatorType;
  /** The device needs a motor to move. It does not imply that the motor needs a drive. */
  requiresMotor: boolean;
  /** The device only runs from a drive. */
  requiresDrive: boolean;
  /** The drive usually chosen when one is used; no drive is required unless `requiresDrive`. */
  preferredDriveType: DriveType | null;
};

const category = (
  code: string,
  name: string,
  simulatorType: SimulatorType = "NONE",
  drive: { requiresMotor?: boolean; requiresDrive?: boolean; preferredDriveType?: DriveType } = {},
): GenericCategory => ({
  code,
  name,
  simulatorType,
  requiresMotor: drive.requiresMotor ?? false,
  requiresDrive: drive.requiresDrive ?? false,
  preferredDriveType: drive.preferredDriveType ?? null,
});

const motorDriven = (preferredDriveType: DriveType) => ({ requiresMotor: true, preferredDriveType });

export const GENERIC_CATEGORIES: readonly GenericCategory[] = [
  // Controllers and devices between PLC logic and field equipment.
  category("PLC", "PLC / programmable controller"),
  category("VFD", "Variable-frequency drive", "VFD"),
  category("SERVO_DRIVE", "Servo drive"),
  category("SOFT_STARTER", "Soft starter"),
  category("MOTOR_STARTER", "Motor starter / motor protection relay"),
  category("MOTION_CONTROLLER", "Motion controller"),
  category("PROCESS_CONTROLLER", "PID / process controller"),
  category("TEMPERATURE_CONTROLLER", "Temperature controller"),
  category("ROBOT_CONTROLLER", "Robot / controller interface"),
  category("SAFETY_RELAY", "Safety relay / safety controller (simulation only, not safety-rated)"),
  category("REMOTE_IO", "Remote / distributed I/O"),
  category("IO_LINK_MASTER", "IO-Link master"),
  category("GATEWAY", "Protocol converter / industrial gateway"),
  category("EDGE_GATEWAY", "Industrial edge gateway"),
  category("SIGNAL_CONDITIONER", "Signal conditioner / isolator"),
  category("TRANSMITTER", "Analog transmitter / converter", "SENSOR"),
  category("HMI", "HMI / SCADA endpoint"),
  // Field and process devices.
  category("MOTOR", "Motor", "MOTOR", { preferredDriveType: "VFD" }),
  category("SERVO_MOTOR", "Servo motor", "NONE", { requiresDrive: true, preferredDriveType: "SERVO" }),
  category("PUMP", "Pump", "PUMP", motorDriven("VFD")),
  category("FAN", "Fan", "FAN", motorDriven("VFD")),
  category("BLOWER", "Blower", "FAN", motorDriven("VFD")),
  category("CONVEYOR", "Conveyor / feeder", "CONVEYOR", motorDriven("VFD")),
  category("MIXER", "Mixer / agitator", "MIXER", motorDriven("VFD")),
  category("COMPRESSOR", "Compressor", "COMPRESSOR", motorDriven("SOFT_STARTER")),
  category("VALVE", "Valve", "VALVE"),
  category("ACTUATOR", "Pneumatic actuator / cylinder", "VALVE"),
  category("HEATER", "Heater"),
  category("INDICATOR", "Stack light / alarm lamp / buzzer"),
  category("SENSOR", "Sensor / transmitter", "SENSOR"),
  category("PROXIMITY_SENSOR", "Proximity / photoelectric sensor", "SWITCH"),
  category("SWITCH", "Switch / push button", "SWITCH"),
  category("RELAY", "Relay", "RELAY"),
  category("CONTACTOR", "Contactor", "RELAY"),
  category("ENCODER", "Encoder", "SENSOR"),
];
