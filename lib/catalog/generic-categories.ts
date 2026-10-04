/**
 * Generic device categories (docs/database.md → DeviceCategory).
 *
 * These are category-level facts about how Z-Factory simulates and relates devices.
 * They are NOT vendor specifications: vendor models, I/O counts, registers and limits
 * come only from the verified catalog ingestion of TASK-301.
 */
import type { SimulatorType } from "@/lib/generated/prisma/enums";

export type GenericCategory = {
  code: string;
  name: string;
  simulatorType: SimulatorType;
  /** The device needs a motor to move. It does not imply that the motor needs a drive. */
  requiresMotor: boolean;
};

export const GENERIC_CATEGORIES: readonly GenericCategory[] = [
  { code: "PLC", name: "PLC / controller", simulatorType: "NONE", requiresMotor: false },
  { code: "VFD", name: "Variable-frequency drive", simulatorType: "VFD", requiresMotor: false },
  { code: "MOTOR", name: "Motor", simulatorType: "MOTOR", requiresMotor: false },
  { code: "PUMP", name: "Pump", simulatorType: "PUMP", requiresMotor: true },
  { code: "FAN", name: "Fan", simulatorType: "FAN", requiresMotor: true },
  { code: "BLOWER", name: "Blower", simulatorType: "FAN", requiresMotor: true },
  { code: "CONVEYOR", name: "Conveyor", simulatorType: "CONVEYOR", requiresMotor: true },
  { code: "MIXER", name: "Mixer / agitator", simulatorType: "MIXER", requiresMotor: true },
  { code: "COMPRESSOR", name: "Compressor", simulatorType: "COMPRESSOR", requiresMotor: true },
  { code: "VALVE", name: "Valve", simulatorType: "VALVE", requiresMotor: false },
  { code: "SENSOR", name: "Sensor / transmitter", simulatorType: "SENSOR", requiresMotor: false },
  { code: "SWITCH", name: "Switch", simulatorType: "SWITCH", requiresMotor: false },
  { code: "RELAY", name: "Relay", simulatorType: "RELAY", requiresMotor: false },
  { code: "CONTACTOR", name: "Contactor", simulatorType: "RELAY", requiresMotor: false },
  { code: "ENCODER", name: "Encoder", simulatorType: "SENSOR", requiresMotor: false },
  { code: "REMOTE_IO", name: "Remote I/O", simulatorType: "NONE", requiresMotor: false },
  { code: "GATEWAY", name: "Industrial edge / protocol gateway", simulatorType: "NONE", requiresMotor: false },
];
