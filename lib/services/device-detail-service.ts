import "server-only";
import { z } from "zod";
import type { Actor } from "@/lib/auth/actor";
import { wiringRepository } from "@/lib/db/repositories/wiring-repository";
import {
  DEVICE_SECTION_LABELS,
  deviceSections,
  isProgrammableController,
  programSupport,
} from "@/lib/domain/device-capabilities";
import type { DeviceDetailView, DeviceParametersView, DeviceRegisterView } from "@/lib/domain/device-detail-view";
import { type ParameterField, parameterFieldsFor, parameterValues } from "@/lib/domain/device-parameters";
import { DomainError } from "@/lib/domain/errors";
import { isSimulatedType } from "@/lib/domain/simulation";
import type { Prisma, PrismaClient } from "@/lib/generated/prisma/client";
import { modbusDisplayAddress } from "@/lib/protocols/modbus/located-address";
import { paramsSchemaFor, parseParams } from "@/lib/runtimes/device-sim/params";
import { parseInput } from "@/lib/validation/parse";
import { describeWires } from "./wiring-service";

/**
 * The screens of a device instance that is not a controller (TASK-308,
 * docs/programmable-devices.md). What a device shows is assembled from the capabilities
 * of its exact catalog model: a drive gets Parameters and Registers, a sensor neither, and
 * no device gets a Program screen because of the category it is in.
 */

const notFound = () => new DomainError("NOT_FOUND", "The device does not exist.");

const deviceInclude = {
  factory: { select: { id: true, name: true, slug: true, ownerId: true } },
  deviceModel: {
    include: {
      family: { include: { category: true, manufacturer: true } },
      communicationPorts: { orderBy: { name: "asc" } },
    },
  },
  simulationProfiles: { orderBy: { id: "desc" }, take: 1 },
  sourcedTags: {
    include: { plc: { include: { deviceInstance: { select: { id: true, name: true } } } } },
    orderBy: { name: "asc" },
  },
} as const satisfies Prisma.DeviceInstanceInclude;

type DeviceRecord = Prisma.DeviceInstanceGetPayload<{ include: typeof deviceInclude }>;

async function loadDevice(db: PrismaClient, actor: Actor, deviceId: string): Promise<DeviceRecord> {
  const device = z.uuid().safeParse(deviceId).success
    ? await db.deviceInstance.findFirst({
        where: { id: deviceId, factory: { ownerId: actor.ownerId } },
        include: deviceInclude,
      })
    : null;
  if (!device) throw notFound();
  return device;
}

const storedValues = (json: unknown): Record<string, unknown> | null =>
  json !== null && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : null;

async function parametersOf(db: PrismaClient, device: DeviceRecord): Promise<DeviceParametersView | null> {
  const model = device.deviceModel;
  if (!model.capabilities.includes("PARAMETER_CONFIGURABLE")) return null;
  const simulatorType = model.family.category.simulatorType;
  const fields = parameterFieldsFor(simulatorType);
  const versions = await db.configurationVersion.findMany({
    where: { factoryId: device.factoryId, scopeType: "DEVICE_PARAMETERS", scopeId: device.id },
    orderBy: { version: "desc" },
  });
  return {
    fields,
    values: parameterValues(fields, storedValues(device.simulationProfiles[0]?.parametersJson ?? null)),
    applied: model.runtimeSupport === "DEVICE_SIM" && isSimulatedType(simulatorType),
    versions: versions.map((entry) => ({
      version: entry.version,
      createdAt: entry.createdAt.toISOString(),
      createdBy: entry.createdBy,
      values: parameterValues(fields, storedValues(entry.snapshotJson)),
    })),
  };
}

function toRegisters(device: DeviceRecord): DeviceRegisterView[] {
  return device.sourcedTags.map((tag) => ({
    tagName: tag.name,
    plcId: tag.plc.deviceInstance.id,
    plcName: tag.plc.deviceInstance.name,
    role: tag.role,
    dataType: tag.dataType,
    logicalAddress: tag.logicalAddress,
    area: tag.protocolArea,
    address: tag.protocolAddress,
    displayAddress:
      tag.protocolArea !== null && tag.protocolAddress !== null
        ? modbusDisplayAddress(tag.protocolArea, tag.protocolAddress)
        : null,
    signal: tag.sourceSignal,
    unit: tag.unit,
  }));
}

/** A device of the owner's factory with everything its screens show. */
export async function getDeviceDetail(db: PrismaClient, actor: Actor, deviceId: string): Promise<DeviceDetailView> {
  const device = await loadDevice(db, actor, deviceId);
  const model = device.deviceModel;
  const category = model.family.category;
  const facts = {
    categoryCode: category.code,
    capabilities: model.capabilities,
    runtimeSupport: model.runtimeSupport,
    architectureType: model.architectureType,
    simulatorType: category.simulatorType,
    hasPorts: model.communicationPorts.length > 0,
  };
  const support = programSupport(model);
  const [wires, parameters] = await Promise.all([
    describeWires(db, await wiringRepository.listWires(db, [device.id])),
    parametersOf(db, device),
  ]);
  return {
    id: device.id,
    factoryId: device.factoryId,
    factoryName: device.factory.name,
    factorySlug: device.factory.slug,
    name: device.name,
    role: device.role,
    location: device.location,
    runtimeStatus: device.runtimeStatus,
    categoryCode: category.code,
    categoryName: category.name,
    manufacturer: model.family.manufacturer.name,
    modelId: model.id,
    modelName: model.modelName,
    architectureType: model.architectureType,
    runtimeSupport: model.runtimeSupport,
    simulatorType: category.simulatorType,
    capabilities: model.capabilities,
    sections: deviceSections(facts).map((key) => ({ key, label: DEVICE_SECTION_LABELS[key] })),
    programNote: model.capabilities.includes("PROGRAMMABLE") && !support.supported ? support.reason : null,
    ports: model.communicationPorts.map((port) => ({
      name: port.name,
      physicalType: port.physicalType,
      protocols: port.protocols,
      maxConnections: port.maxConnections,
    })),
    wires,
    registers: toRegisters(device),
    parameters,
  };
}

/** True when the device is a programmable controller, whose screens are the PLC screens. */
export async function isControllerDevice(db: PrismaClient, actor: Actor, deviceId: string): Promise<boolean> {
  const device = await loadDevice(db, actor, deviceId);
  return isProgrammableController(device.deviceModel);
}

/** The behaviour model's refusal, said with the field's label: `Acceleration time: Too small: …`. */
function parseWithFieldNames<T>(fields: readonly ParameterField[], parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (!(error instanceof DomainError) || error.details.rule !== "simulation-params") throw error;
    const issues = (error.details.issues as Array<{ path: string; message: string }> | undefined) ?? [];
    const first = issues[0];
    const label = fields.find((item) => item.key === first?.path)?.label ?? first?.path;
    throw new DomainError("VALIDATION", first ? `${label}: ${first.message}.` : error.message, error.details);
  }
}

const parameterInputSchema = z.record(z.string().regex(/^[a-z][A-Za-z0-9]{0,63}$/), z.coerce.number().finite());

/**
 * Stores a parameter set of a configurable device: validated by the behaviour model's
 * schema, written as an immutable configuration version, and made the device's simulation
 * profile. A simulation that is running keeps its values until it is started again.
 */
export async function saveDeviceParameters(
  db: PrismaClient,
  actor: Actor,
  deviceId: string,
  input: unknown,
): Promise<DeviceParametersView> {
  const raw = parseInput(parameterInputSchema, input);
  const device = await loadDevice(db, actor, deviceId);
  const model = device.deviceModel;
  if (!model.capabilities.includes("PARAMETER_CONFIGURABLE")) {
    throw new DomainError("INCOMPATIBLE", `${model.modelName} has no parameters to configure.`, {
      rule: "parameters-capability",
    });
  }
  const simulatorType = model.family.category.simulatorType;
  const fields = parameterFieldsFor(simulatorType);
  if (fields.length === 0) {
    throw new DomainError("INCOMPATIBLE", `No parameter set is defined for ${model.modelName} yet.`, {
      rule: "parameters-undefined",
    });
  }
  const known = new Set(fields.map((item) => item.key));
  const unknown = Object.keys(raw).find((key) => !known.has(key));
  if (unknown) {
    throw new DomainError("VALIDATION", `${model.modelName} has no parameter "${unknown}".`, {
      rule: "parameters-field",
      field: unknown,
    });
  }
  // The behaviour model's own schema decides what is valid; the fields only describe it.
  const merged = { ...parameterValues(fields, null), ...raw };
  const values: Record<string, unknown> = isSimulatedType(simulatorType)
    ? parseWithFieldNames(fields, () =>
        parseParams(paramsSchemaFor(simulatorType) as z.ZodType<Record<string, unknown>>, merged, device.name),
      )
    : merged;

  await db.$transaction(async (transaction) => {
    const latest = await transaction.configurationVersion.findFirst({
      where: { factoryId: device.factoryId, scopeType: "DEVICE_PARAMETERS", scopeId: device.id },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    await transaction.configurationVersion.create({
      data: {
        factoryId: device.factoryId,
        scopeType: "DEVICE_PARAMETERS",
        scopeId: device.id,
        version: (latest?.version ?? 0) + 1,
        createdBy: actor.ownerId,
        snapshotJson: values as Prisma.InputJsonValue,
      },
    });
    const profile = device.simulationProfiles[0];
    if (profile) {
      await transaction.simulationProfile.update({
        where: { id: profile.id },
        data: { kind: "STATE_MACHINE", parametersJson: values as Prisma.InputJsonValue },
      });
    } else {
      await transaction.simulationProfile.create({
        data: { deviceInstanceId: device.id, kind: "STATE_MACHINE", parametersJson: values as Prisma.InputJsonValue },
      });
    }
  });
  const view = await parametersOf(db, await loadDevice(db, actor, deviceId));
  if (!view) throw notFound();
  return view;
}
