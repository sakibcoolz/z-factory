import "server-only";
import type { Actor } from "@/lib/auth/actor";
import type { Db } from "@/lib/db/client";
import { plcRepository } from "@/lib/db/repositories/plc-repository";
import { tagRepository } from "@/lib/db/repositories/tag-repository";
import { DomainError, isDomainError } from "@/lib/domain/errors";
import {
  isWritableModbusArea,
  isWritableTagRole,
  type ModbusArea,
  type TagDataType,
  type TagQuality,
  type TagRole,
} from "@/lib/domain/tag";
import type { PrismaClient, Tag } from "@/lib/generated/prisma/client";
import { readModbus, writeModbus, writeModbusRegisters } from "@/lib/protocols/modbus/client";
import { decodeValue, encodeValue } from "@/lib/protocols/modbus/codec";
import {
  assertDataTypeFits,
  formatLocatedAddress,
  modbusDisplayAddress,
  parseLocatedAddress,
  toModbusLocation,
} from "@/lib/protocols/modbus/located-address";
import { modbusEndpoint } from "@/lib/runtimes/openplc/adapter";
import { parseInput } from "@/lib/validation/parse";
import { type TagInput, tagInputSchema } from "@/lib/validation/schemas";
import { assertSignalBinding } from "@/lib/validation/simulation";
import { assertNoAddressOverlap, assertTagAccess } from "@/lib/validation/tag";
import { loadPlc, requireTarget, type RuntimeDeps } from "./plc-runtime-service";

/**
 * The PLC tag registry and its Modbus mapping.
 *
 * A tag names a located variable of the PLC program. Its Modbus area and address are
 * derived from that located address (the OpenPLC runtime fixes the mapping, ADR-0009),
 * and its access mode from its role: only COMMAND and SETPOINT tags are writable.
 * Every change bumps the PLC's Modbus mapping version.
 */

/** One row of the Modbus map, as shown in the PLC inspector and written to exports. */
export type ModbusMapRow = {
  name: string;
  role: TagRole;
  dataType: TagDataType;
  direction: "INPUT" | "OUTPUT" | "INTERNAL";
  logicalAddress: string;
  area: ModbusArea;
  /** Zero-based address within the area. */
  address: number;
  wordCount: number;
  /** One-based display notation (4xxxx…), derived from area and address. */
  displayAddress: string;
  accessMode: "READ_ONLY" | "READ_WRITE";
  byteOrder: "BIG_ENDIAN" | "LITTLE_ENDIAN";
  wordOrder: "HIGH_WORD_FIRST" | "LOW_WORD_FIRST";
  scale: number;
  offset: number;
  unit: string | null;
  sourceDeviceInstanceId: string | null;
  /** Device signal the tag carries to or from the device simulator. */
  sourceSignal: string | null;
};

export type ModbusMap = {
  plcId: string;
  version: number;
  conventions: { addressBase: "zero-based"; byteOrder: "BIG_ENDIAN"; wordOrder: "HIGH_WORD_FIRST" };
  /** Host endpoint of the PLC's Modbus TCP server, when one is configured. */
  endpoint: { bindAddress: string; hostPort: number; containerPort: number } | null;
  rows: ModbusMapRow[];
};

export type TagReading = {
  name: string;
  value: number | boolean | null;
  unit: string | null;
  quality: TagQuality;
  readAt: string;
};

const DIRECTION = { I: "INPUT", Q: "OUTPUT", M: "INTERNAL" } as const;

function mapped(tag: Tag): tag is Tag & { protocolArea: ModbusArea; protocolAddress: number; logicalAddress: string } {
  return tag.protocolArea !== null && tag.protocolAddress !== null && tag.logicalAddress !== null;
}

function toRow(tag: Tag & { protocolArea: ModbusArea; protocolAddress: number; logicalAddress: string }): ModbusMapRow {
  return {
    name: tag.name,
    role: tag.role,
    dataType: tag.dataType,
    direction: tag.direction,
    logicalAddress: tag.logicalAddress,
    area: tag.protocolArea,
    address: tag.protocolAddress,
    wordCount: tag.wordCount,
    displayAddress: modbusDisplayAddress(tag.protocolArea, tag.protocolAddress),
    accessMode: tag.accessMode,
    byteOrder: tag.byteOrder,
    wordOrder: tag.wordOrder,
    scale: tag.scale,
    offset: tag.offset,
    unit: tag.unit,
    sourceDeviceInstanceId: tag.sourceDeviceInstanceId,
    sourceSignal: tag.sourceSignal,
  };
}

/** Adds a tag to the PLC's registry. Its Modbus mapping and access mode are derived, not chosen. */
export async function createTag(db: PrismaClient, actor: Actor, plcId: string, input: unknown): Promise<ModbusMapRow> {
  const data = parseInput(tagInputSchema, input);
  const { device } = await loadPlc(db, actor, plcId);
  return db.$transaction((transaction) => createTagInTransaction(transaction, device, data));
}

/**
 * Creates a tag inside a transaction the caller owns, so a tag can be created together
 * with what it belongs to (wiring a device to an I/O point). `plcIoPointId` binds the tag
 * to that point; only then may it use the point's address.
 */
export async function createTagInTransaction(
  transaction: Db,
  device: { id: string; factoryId: string },
  data: TagInput,
  binding: { plcIoPointId?: string } = {},
): Promise<ModbusMapRow> {
  const located = parseLocatedAddress(data.logicalAddress);
  assertDataTypeFits(located, data.dataType);
  const location = toModbusLocation(located);

  // A command or setpoint that cannot be written is a contradiction, not a read-only tag.
  if (isWritableTagRole(data.role) && !isWritableModbusArea(location.area)) {
    throw new DomainError(
      "INCOMPATIBLE",
      `A ${data.role} tag needs a writable address (%Q or %M); ${formatLocatedAddress(located)} is an input.`,
      { rule: "role-area", field: "logicalAddress" },
    );
  }
  const accessMode = isWritableTagRole(data.role) ? "READ_WRITE" : "READ_ONLY";
  assertTagAccess({ role: data.role, accessMode, protocolArea: location.area });

  const sourceDeviceId = data.sourceDeviceInstanceId;
  if (data.sourceSignal && !sourceDeviceId) {
    throw new DomainError("VALIDATION", "A device signal needs the device it belongs to.", {
      rule: "signal-device",
      field: "sourceDeviceInstanceId",
    });
  }
  if (sourceDeviceId) {
    const source = await tagRepository.findDeviceInFactory(transaction, sourceDeviceId, device.factoryId);
    if (!source) {
      throw new DomainError("NOT_FOUND", "The source device does not exist in this factory.", {
        field: "sourceDeviceInstanceId",
      });
    }
    if (data.sourceSignal) {
      assertSignalBinding({
        device: source,
        signal: data.sourceSignal,
        tag: { dataType: data.dataType, accessMode, region: located.region },
      });
    }
  }

  const logicalAddress = formatLocatedAddress(located);
  const point = await tagRepository.findIoPointByAddress(transaction, device.id, logicalAddress);
  if (point && point.id !== binding.plcIoPointId) {
    throw new DomainError(
      "CONFLICT",
      `${logicalAddress} is the address of a PLC I/O point; its tag is created by wiring a device to it.`,
      {
        rule: "io-point-address",
        field: "logicalAddress",
      },
    );
  }
  {
    const existing = (await tagRepository.listByPlc(transaction, device.id)).filter(mapped);
    assertNoAddressOverlap(
      { name: data.name, protocolArea: location.area, protocolAddress: location.address, dataType: data.dataType },
      existing.map((tag) => ({
        name: tag.name,
        protocolArea: tag.protocolArea,
        protocolAddress: tag.protocolAddress,
        dataType: tag.dataType,
      })),
    );
    if (sourceDeviceId && data.sourceSignal) {
      const wired = await tagRepository.findBySignal(transaction, sourceDeviceId, data.sourceSignal);
      if (wired) {
        throw new DomainError("CONFLICT", `That device signal is already wired to tag ${wired.name}.`, {
          rule: "signal-bound",
          field: "sourceSignal",
        });
      }
    }

    const created = await tagRepository.create(transaction, {
      plcInstanceId: device.id,
      name: data.name,
      dataType: data.dataType,
      direction: DIRECTION[located.region],
      role: data.role,
      logicalAddress,
      plcIoPointId: binding.plcIoPointId ?? null,
      protocol: "MODBUS_TCP",
      protocolArea: location.area,
      protocolAddress: location.address,
      wordCount: location.wordCount,
      // Fixed by the runtime's Modbus server.
      byteOrder: "BIG_ENDIAN",
      wordOrder: "HIGH_WORD_FIRST",
      accessMode,
      scale: data.scale,
      offset: data.offset,
      unit: data.unit || null,
      sourceDeviceInstanceId: sourceDeviceId ?? null,
      sourceSignal: data.sourceSignal ?? null,
    });
    await plcRepository.bumpModbusMappingVersion(transaction, device.id);
    if (!mapped(created)) throw new DomainError("INVARIANT", "The tag was stored without its mapping.");
    return toRow(created);
  }
}

export async function deleteTag(db: PrismaClient, actor: Actor, plcId: string, name: string): Promise<void> {
  const { device } = await loadPlc(db, actor, plcId);
  await db.$transaction(async (transaction) => {
    if ((await tagRepository.delete(transaction, device.id, name)) === 0) {
      throw new DomainError("NOT_FOUND", "The tag does not exist.");
    }
    await plcRepository.bumpModbusMappingVersion(transaction, device.id);
  });
}

/** The PLC's Modbus map: the contract the inspector shows and the engineering export contains. */
export async function getModbusMap(db: PrismaClient, actor: Actor, plcId: string): Promise<ModbusMap> {
  const { device, profile } = await loadPlc(db, actor, plcId);
  const port = device.runtimePorts.find((candidate) => candidate.protocol === "MODBUS_TCP" && candidate.hostPort);
  return {
    plcId: device.id,
    version: profile.modbusMappingVersion,
    conventions: { addressBase: "zero-based", byteOrder: "BIG_ENDIAN", wordOrder: "HIGH_WORD_FIRST" },
    endpoint: port?.hostPort
      ? { bindAddress: port.bindAddress, hostPort: port.hostPort, containerPort: port.containerPort }
      : null,
    rows: (await tagRepository.listByPlc(db, device.id)).filter(mapped).map(toRow),
  };
}

async function loadMappedTag(db: PrismaClient, plcDeviceId: string, name: string) {
  const tag = await tagRepository.findByName(db, plcDeviceId, name);
  if (!tag || !mapped(tag)) throw new DomainError("NOT_FOUND", "The tag does not exist.");
  return tag;
}

const encodingOf = (tag: Tag) => ({
  dataType: tag.dataType,
  byteOrder: tag.byteOrder,
  wordOrder: tag.wordOrder,
  scale: tag.scale,
  offset: tag.offset,
});

/** Reads one tag from the running PLC as an engineering value. */
export async function readTag(deps: RuntimeDeps, actor: Actor, plcId: string, name: string): Promise<TagReading> {
  const { device } = await loadPlc(deps.db, actor, plcId);
  const tag = await loadMappedTag(deps.db, device.id, name);
  const endpoint = modbusEndpoint(requireTarget(device));
  const raw = await readModbus(endpoint, tag.protocolArea, tag.protocolAddress, tag.wordCount);
  return {
    name: tag.name,
    value: decodeValue(raw, encodingOf(tag)),
    unit: tag.unit,
    quality: "GOOD",
    readAt: new Date().toISOString(),
  };
}

/**
 * Reads every tag of the PLC. A value that cannot be read is reported with its quality
 * (DISCONNECTED when the PLC does not answer, BAD otherwise), never as a stale number.
 */
export async function readTags(deps: RuntimeDeps, actor: Actor, plcId: string): Promise<TagReading[]> {
  const { device } = await loadPlc(deps.db, actor, plcId);
  const tags = (await tagRepository.listByPlc(deps.db, device.id)).filter(mapped);
  const endpoint = modbusEndpoint(requireTarget(device));

  const readings: TagReading[] = [];
  for (const tag of tags) {
    const readAt = new Date().toISOString();
    try {
      const raw = await readModbus(endpoint, tag.protocolArea, tag.protocolAddress, tag.wordCount);
      readings.push({
        name: tag.name,
        value: decodeValue(raw, encodingOf(tag)),
        unit: tag.unit,
        quality: "GOOD",
        readAt,
      });
    } catch (error) {
      const unreachable = isDomainError(error) && /unreachable|timeout/.test(String(error.details.rule));
      readings.push({
        name: tag.name,
        value: null,
        unit: tag.unit,
        quality: unreachable ? "DISCONNECTED" : "BAD",
        readAt,
      });
    }
  }
  return readings;
}

/**
 * Writes a command or setpoint tag. The write is recorded as a `DeviceCommand`:
 * ACCEPTED means the PLC took the value, not that the device acted on it — PLC logic
 * and interlocks decide that, and the result is read back from feedback tags.
 */
export async function writeTag(
  deps: RuntimeDeps,
  actor: Actor,
  plcId: string,
  name: string,
  value: unknown,
  source: "UI" | "GATEWAY" | "SYSTEM" = "UI",
): Promise<{ commandId: string; status: "ACCEPTED" }> {
  const { db } = deps;
  const { device } = await loadPlc(db, actor, plcId);
  const tag = await loadMappedTag(db, device.id, name);

  if (tag.accessMode !== "READ_WRITE" || !isWritableTagRole(tag.role)) {
    throw new DomainError("INVARIANT", `${tag.name} is a ${tag.role} tag and cannot be written.`, {
      rule: "tag-read-only",
    });
  }
  const encoded = encodeValue(value, encodingOf(tag));
  const endpoint = modbusEndpoint(requireTarget(device));

  const command = await tagRepository.recordCommand(db, {
    factoryId: device.factoryId,
    plcInstanceId: device.id,
    tagId: tag.id,
    targetDeviceId: tag.sourceDeviceInstanceId,
    requestedValueJson: value as number | boolean,
    source,
  });

  try {
    if (typeof encoded === "boolean") {
      await writeModbus(endpoint, "COIL", tag.protocolAddress, encoded);
    } else if (encoded.length === 1) {
      await writeModbus(endpoint, "HOLDING_REGISTER", tag.protocolAddress, encoded[0] ?? 0);
    } else {
      await writeModbusRegisters(endpoint, tag.protocolAddress, encoded);
    }
  } catch (error) {
    await tagRepository.setCommandStatus(db, command.id, "FAILED");
    throw error;
  }
  await tagRepository.setCommandStatus(db, command.id, "ACCEPTED");
  return { commandId: command.id, status: "ACCEPTED" };
}
