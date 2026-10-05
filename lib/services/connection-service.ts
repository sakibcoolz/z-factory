import "server-only";
import type { Db } from "@/lib/db/client";
import { connectionRepository } from "@/lib/db/repositories/connection-repository";
import { deviceRepository } from "@/lib/db/repositories/device-repository";
import { DomainError } from "@/lib/domain/errors";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { assertConnectionAllowed, assertIoPointAvailable, assertSignalCompatible } from "@/lib/validation/connection";
import { parseInput } from "@/lib/validation/parse";
import { type ConnectionInput, connectionInputSchema } from "@/lib/validation/schemas";

type Endpoint = ConnectionInput["source"];

async function loadDevice(db: Db, endpoint: Endpoint, side: "source" | "target") {
  const device = await deviceRepository.findInstance(db, endpoint.deviceId);
  if (!device) throw new DomainError("NOT_FOUND", `The ${side} device does not exist.`, { field: `${side}.deviceId` });
  const category = device.deviceModel.family.category;
  return {
    id: device.id,
    factoryId: device.factoryId,
    deviceModelId: device.deviceModelId,
    categoryCode: category.code,
    requiresMotor: category.requiresMotor,
    requiresDrive: category.requiresDrive,
    preferredDriveType: category.preferredDriveType,
  };
}

/** The I/O point must belong to the PLC on its side of the connection and still be free. */
async function loadIoPoint(db: Db, endpoint: Endpoint, side: "source" | "target") {
  if (endpoint.endpointType !== "PLC_IO_POINT" || !endpoint.endpointRef) return undefined;
  const point = await connectionRepository.findIoPoint(db, endpoint.endpointRef);
  if (!point || point.plcInstanceId !== endpoint.deviceId) {
    throw new DomainError("NOT_FOUND", `The ${side} I/O point does not exist on that PLC.`, {
      field: `${side}.endpointRef`,
    });
  }
  const channel = point.builtInChannel ?? point.moduleChannel;
  if (!channel) throw new DomainError("INVARIANT", "The I/O point has no catalog channel.", { ioPointId: point.id });
  assertIoPointAvailable(point);
  return {
    id: point.id,
    ioType: channel.ioType,
    signalType: channel.signalType,
    acceptedSignalTypes: channel.acceptedSignalTypes,
  };
}

/** The terminal must be defined on the catalog model of the device on its side. */
async function loadDeviceIo(db: Db, endpoint: Endpoint, deviceModelId: string, side: "source" | "target") {
  if (endpoint.endpointType !== "DEVICE_IO" || !endpoint.endpointRef) return undefined;
  const definition = await connectionRepository.findDeviceIoDefinition(db, endpoint.endpointRef);
  if (!definition || definition.deviceModelId !== deviceModelId) {
    throw new DomainError("NOT_FOUND", `The ${side} terminal is not defined on that device's model.`, {
      field: `${side}.endpointRef`,
    });
  }
  return definition;
}

/**
 * Connects two device instances of one factory through explicit endpoints.
 * Rejects incompatible wiring, occupied I/O points and a second motor on a drive.
 */
export async function connectDevices(db: PrismaClient, input: unknown) {
  const data = parseInput(connectionInputSchema, input);
  return db.$transaction((transaction) => connectDevicesInTransaction(transaction, data));
}

/** The same checks and writes inside a transaction the caller owns. */
export async function connectDevicesInTransaction(transaction: Db, data: ConnectionInput) {
  {
    const [source, target] = await Promise.all([
      loadDevice(transaction, data.source, "source"),
      loadDevice(transaction, data.target, "target"),
    ]);

    assertConnectionAllowed({
      factoryId: data.factoryId,
      relationship: data.relationship,
      source,
      target,
      sourceDrivesCount: await connectionRepository.countDrivesFrom(transaction, source.id),
      targetDrivenByCount: await connectionRepository.countDrivesInto(transaction, target.id),
    });

    const sourcePoint = await loadIoPoint(transaction, data.source, "source");
    const targetPoint = await loadIoPoint(transaction, data.target, "target");
    const sourceIo = await loadDeviceIo(transaction, data.source, source.deviceModelId, "source");
    const targetIo = await loadDeviceIo(transaction, data.target, target.deviceModelId, "target");

    // A peripheral terminal wired to a PLC channel must match its point class and signal type.
    if (sourceIo && targetPoint) assertSignalCompatible(sourceIo, targetPoint);
    if (targetIo && sourcePoint) assertSignalCompatible(targetIo, sourcePoint);

    const connection = await connectionRepository.create(transaction, {
      factoryId: data.factoryId,
      sourceDeviceId: source.id,
      targetDeviceId: target.id,
      sourceEndpointType: data.source.endpointType,
      sourceEndpointRef: data.source.endpointRef ?? source.id,
      targetEndpointType: data.target.endpointType,
      targetEndpointRef: data.target.endpointRef ?? target.id,
      relationship: data.relationship,
    });

    for (const point of [sourcePoint, targetPoint]) {
      if (point) await connectionRepository.markIoPointOccupied(transaction, point.id);
    }
    return connection;
  }
}
