/**
 * Device connection invariants (docs/database.md → DeviceConnection, rules 17–23).
 * Pure functions; they throw `DomainError`. The database repeats the critical ones
 * (one motor per drive, one wire per I/O point) as constraints.
 */
import {
  type ConnectionRelationship,
  DRIVE_CATEGORY_CODES,
  DRIVE_TYPE_BY_CATEGORY,
  type IoDirection,
  type IoPointStatus,
  type IoPointType,
  type IoSignalClass,
  MOTOR_CATEGORY_CODES,
} from "@/lib/domain/device";
import { signalFits } from "@/lib/domain/catalog";
import { DomainError } from "@/lib/domain/errors";

/** The PLC point class a peripheral signal must land on: a device output is a PLC input, and vice versa. */
export function requiredIoPointType(direction: IoDirection, signalClass: IoSignalClass): IoPointType {
  if (signalClass === "DIGITAL") return direction === "OUTPUT" ? "DI" : "DO";
  return direction === "OUTPUT" ? "AI" : "AO";
}

/**
 * A channel takes its default signal type, any further type it can be configured for, and
 * any signal whose range lies inside one of those.
 */
export function channelAccepts(
  channel: { signalType: string; acceptedSignalTypes?: readonly string[] },
  signalType: string,
): boolean {
  return [channel.signalType, ...(channel.acceptedSignalTypes ?? [])].some((supported) =>
    signalFits(supported, signalType),
  );
}

export function assertSignalCompatible(
  deviceIo: { direction: IoDirection; ioType: IoSignalClass; signalType: string },
  channel: { ioType: IoPointType; signalType: string; acceptedSignalTypes?: readonly string[] },
): void {
  const required = requiredIoPointType(deviceIo.direction, deviceIo.ioType);
  if (channel.ioType !== required) {
    throw new DomainError("INCOMPATIBLE", `This device signal needs an ${required} channel, not ${channel.ioType}.`, {
      rule: "io-point-type",
      required,
      actual: channel.ioType,
    });
  }
  if (!channelAccepts(channel, deviceIo.signalType)) {
    const accepted = [channel.signalType, ...(channel.acceptedSignalTypes ?? [])];
    throw new DomainError(
      "INCOMPATIBLE",
      `Signal type ${deviceIo.signalType} is not accepted by this channel (${accepted.join(", ")}).`,
      { rule: "signal-type", required: deviceIo.signalType, actual: channel.signalType, accepted },
    );
  }
}

export function assertIoPointAvailable(point: { logicalAddress: string; status: IoPointStatus }): void {
  if (point.status !== "FREE") {
    throw new DomainError("OCCUPIED_ENDPOINT", `I/O point ${point.logicalAddress} is not available.`, {
      rule: "io-point-free",
      status: point.status,
    });
  }
}

type ConnectionParty = {
  id: string;
  factoryId: string;
  categoryCode: string;
  /** Category capability: the device needs a motor to move (pump, fan, conveyor…). */
  requiresMotor: boolean;
  /** Category capability: the motor only runs from a drive, of the preferred type when one is named. */
  requiresDrive?: boolean;
  preferredDriveType?: string | null;
};

export function assertConnectionAllowed(connection: {
  factoryId: string;
  relationship: ConnectionRelationship;
  source: ConnectionParty;
  target: ConnectionParty;
  /** Existing DRIVES connections leaving the source. */
  sourceDrivesCount: number;
  /** Existing DRIVES connections arriving at the target. */
  targetDrivenByCount: number;
}): void {
  const { source, target, relationship } = connection;
  if (source.id === target.id) {
    throw new DomainError("VALIDATION", "A device cannot be connected to itself.", { rule: "distinct-devices" });
  }
  if (source.factoryId !== connection.factoryId || target.factoryId !== connection.factoryId) {
    throw new DomainError("VALIDATION", "Both devices must belong to the factory the connection is created in.", {
      rule: "same-factory",
    });
  }

  if (relationship === "DRIVES") {
    if (!DRIVE_CATEGORY_CODES.includes(source.categoryCode)) {
      throw new DomainError("INCOMPATIBLE", "Only a drive (VFD, servo drive, soft starter) can drive a motor.", {
        rule: "drives-source",
      });
    }
    if (!MOTOR_CATEGORY_CODES.includes(target.categoryCode)) {
      throw new DomainError("INCOMPATIBLE", "A drive can only drive a motor.", { rule: "drives-target" });
    }
    const driveType = DRIVE_TYPE_BY_CATEGORY[source.categoryCode];
    if (target.requiresDrive && target.preferredDriveType && target.preferredDriveType !== driveType) {
      throw new DomainError("INCOMPATIBLE", `This motor needs a ${target.preferredDriveType} drive.`, {
        rule: "drive-type",
        required: target.preferredDriveType,
        actual: driveType,
      });
    }
    if (connection.sourceDrivesCount > 0) {
      throw new DomainError("INVARIANT", "This drive already has its primary motor (one VFD drives one motor).", {
        rule: "one-motor-per-drive",
      });
    }
    if (connection.targetDrivenByCount > 0) {
      throw new DomainError("INVARIANT", "This motor is already driven by another drive.", {
        rule: "one-drive-per-motor",
      });
    }
  }

  if (relationship === "MECHANICALLY_DRIVES") {
    if (!MOTOR_CATEGORY_CODES.includes(source.categoryCode)) {
      throw new DomainError("INCOMPATIBLE", "Only a motor can mechanically drive equipment.", {
        rule: "mechanical-source",
      });
    }
    if (!target.requiresMotor) {
      throw new DomainError("INCOMPATIBLE", "The target device is not motor-driven equipment.", {
        rule: "mechanical-target",
      });
    }
  }
}
