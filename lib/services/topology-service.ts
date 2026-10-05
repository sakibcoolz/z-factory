import "server-only";
import type { Actor } from "@/lib/auth/actor";
import { deviceRepository } from "@/lib/db/repositories/device-repository";
import { factoryRepository } from "@/lib/db/repositories/factory-repository";
import { plcConfigRepository } from "@/lib/db/repositories/plc-config-repository";
import { plcRepository } from "@/lib/db/repositories/plc-repository";
import { type TopologyDeviceRecord, topologyRepository } from "@/lib/db/repositories/topology-repository";
import { PLC_CATEGORY_CODE } from "@/lib/domain/device";
import { DomainError } from "@/lib/domain/errors";
import type { LinkResult, PaletteGroupView, TopologyEdgeView, TopologyView } from "@/lib/domain/topology-view";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { suggestDeviceName } from "@/lib/validation/io-address";
import { parseInput } from "@/lib/validation/parse";
import {
  linkInputSchema,
  nodePositionsInputSchema,
  placeDeviceInputSchema,
  renameDeviceInputSchema,
  unlinkInputSchema,
} from "@/lib/validation/schemas";
import { defaultPosition, linkOptions, type TopologyParty } from "@/lib/validation/topology";
import { connectDevices } from "./connection-service";
import { createPlc, deletePlc, unwireDevice, wireExistingDevice } from "./plc-config-service";

/**
 * The factory topology behind the designer canvas: devices as nodes, typed connections
 * as edges, and the operations the canvas performs. Every connection goes through the
 * same validation as anywhere else; the canvas cannot create a connection the rules refuse.
 */

const notFound = (what: string) => new DomainError("NOT_FOUND", `The ${what} does not exist.`);

async function requireFactory(db: PrismaClient, actor: Actor, factoryId: string) {
  const factory = await factoryRepository.findById(db, actor.ownerId, factoryId);
  if (!factory) throw notFound("factory");
  return factory;
}

const isPlc = (device: TopologyDeviceRecord) => device.deviceModel.family.category.code === PLC_CATEGORY_CODE;

function toParty(device: TopologyDeviceRecord): TopologyParty {
  const category = device.deviceModel.family.category;
  return {
    id: device.id,
    name: device.name,
    isPlc: isPlc(device),
    categoryCode: category.code,
    simulatorType: category.simulatorType,
    requiresMotor: category.requiresMotor,
    hasTerminals: device.deviceModel.ioDefinitions.length > 0,
    protocols: [...new Set(device.deviceModel.communicationPorts.flatMap((port) => port.protocols))],
  };
}

/** Devices, typed edges and the palette of catalog models for one factory. */
export async function getTopology(db: PrismaClient, actor: Actor, factoryId: string): Promise<TopologyView> {
  const factory = await requireFactory(db, actor, factoryId);
  const [devices, connections, models] = await Promise.all([
    topologyRepository.listDevices(db, factoryId),
    topologyRepository.listConnections(db, factoryId),
    topologyRepository.listPaletteModels(db),
  ]);

  const terminalIds: string[] = [];
  const pointIds: string[] = [];
  for (const connection of connections) {
    for (const [type, ref] of [
      [connection.sourceEndpointType, connection.sourceEndpointRef],
      [connection.targetEndpointType, connection.targetEndpointRef],
    ] as const) {
      if (type === "DEVICE_IO") terminalIds.push(ref);
      if (type === "PLC_IO_POINT") pointIds.push(ref);
    }
  }
  const [terminals, points] = await Promise.all([
    topologyRepository.listTerminalLabels(db, terminalIds),
    topologyRepository.listIoPoints(db, pointIds),
  ]);
  const terminalLabel = new Map(terminals.map((terminal) => [terminal.id, terminal.terminalLabel]));
  const pointById = new Map(points.map((point) => [point.id, point]));

  // One edge per relationship between two devices; the wires of a PLC connection are its detail.
  const edges = new Map<string, TopologyEdgeView>();
  for (const connection of connections) {
    const id = `${connection.sourceDeviceId}|${connection.targetDeviceId}|${connection.relationship}`;
    const edge = edges.get(id) ?? {
      id,
      relationship: connection.relationship,
      sourceId: connection.sourceDeviceId,
      targetId: connection.targetDeviceId,
      wires: [],
      protocol: connection.protocol,
    };
    edges.set(id, edge);
    const plcSideIsSource = connection.sourceEndpointType === "PLC_IO_POINT";
    const point = pointById.get(plcSideIsSource ? connection.sourceEndpointRef : connection.targetEndpointRef);
    if (!point || (!plcSideIsSource && connection.targetEndpointType !== "PLC_IO_POINT")) continue;
    const channel = point.builtInChannel ?? point.moduleChannel;
    edge.wires.push({
      terminalLabel:
        terminalLabel.get(plcSideIsSource ? connection.targetEndpointRef : connection.sourceEndpointRef) ?? null,
      pointLabel: channel ? `${channel.ioType} ${channel.terminalLabel ?? channel.channelIndex}` : "",
      logicalAddress: point.logicalAddress,
      tagName: point.tag?.name ?? null,
    });
  }

  const palette = new Map<string, PaletteGroupView>();
  for (const model of models) {
    const category = model.family.category;
    const group = palette.get(category.code) ?? { categoryCode: category.code, categoryName: category.name, items: [] };
    palette.set(category.code, group);
    group.items.push({
      modelId: model.id,
      modelName: model.modelName,
      manufacturer: model.family.manufacturer.name,
      architectureType: model.architectureType,
    });
  }

  return {
    factory: { id: factory.id, name: factory.name, slug: factory.slug, runtimeStatus: factory.runtimeStatus },
    nodes: devices.map((device, index) => {
      const placed = device.canvasX !== null && device.canvasY !== null;
      const fallback = defaultPosition(index);
      return {
        id: device.id,
        name: device.name,
        role: device.role,
        categoryCode: device.deviceModel.family.category.code,
        categoryName: device.deviceModel.family.category.name,
        manufacturer: device.deviceModel.family.manufacturer.name,
        modelName: device.deviceModel.modelName,
        architectureType: device.deviceModel.architectureType,
        runtimeStatus: device.runtimeStatus,
        x: device.canvasX ?? fallback.x,
        y: device.canvasY ?? fallback.y,
        placed,
      };
    }),
    edges: [...edges.values()],
    // PLCs first: a factory starts with one.
    palette: [...palette.values()].sort(
      (a, b) => Number(b.categoryCode === PLC_CATEGORY_CODE) - Number(a.categoryCode === PLC_CATEGORY_CODE),
    ),
  };
}

/** Creates a device instance from a catalog model at a canvas position. A PLC gets its I/O or rack as usual. */
export async function placeDevice(
  db: PrismaClient,
  actor: Actor,
  factoryId: string,
  input: unknown,
): Promise<{ id: string; name: string }> {
  const data = parseInput(placeDeviceInputSchema, input);
  await requireFactory(db, actor, factoryId);
  const model = await deviceRepository.findModel(db, data.deviceModelId);
  if (!model) throw new DomainError("NOT_FOUND", "The catalog model does not exist.", { field: "deviceModelId" });
  const category = model.family.category;
  const name = data.name ?? suggestDeviceName(category.code, await plcConfigRepository.listDeviceNames(db, factoryId));

  let id: string;
  if (category.code === PLC_CATEGORY_CODE) {
    id = (await createPlc(db, actor, { factoryId, deviceModelId: model.id, name })).id;
  } else {
    const device = await deviceRepository.createInstance(db, {
      factoryId,
      deviceModelId: model.id,
      name,
      runtimeType: model.runtimeSupport,
      simulatorType: category.simulatorType,
    });
    id = device.id;
    await plcRepository.recordEvent(db, {
      factoryId,
      deviceId: id,
      type: "DEVICE_CREATED",
      payloadJson: { model: model.modelName },
    });
  }
  await topologyRepository.setPosition(db, id, data.x, data.y);
  return { id, name };
}

/** Stores canvas positions. Every device must belong to the factory. */
export async function moveDevices(db: PrismaClient, actor: Actor, factoryId: string, input: unknown): Promise<void> {
  const positions = parseInput(nodePositionsInputSchema, input);
  await requireFactory(db, actor, factoryId);
  const known = new Set((await topologyRepository.listDevices(db, factoryId)).map((device) => device.id));
  if (positions.some((position) => !known.has(position.deviceId))) throw notFound("device");
  await db.$transaction(async (transaction) => {
    for (const position of positions)
      await topologyRepository.setPosition(transaction, position.deviceId, position.x, position.y);
  });
}

/** Renames a device or changes its role. Tags created from the old name keep their names. */
export async function renameDevice(db: PrismaClient, actor: Actor, deviceId: string, input: unknown): Promise<void> {
  const data = parseInput(renameDeviceInputSchema, input);
  const device = await topologyRepository.findDevice(db, actor.ownerId, deviceId);
  if (!device) throw notFound("device");
  await topologyRepository.rename(db, device.id, data.name, data.role || null);
}

/** Deletes a device. Channels it was wired to are freed and their tags removed first. */
export async function removeDevice(db: PrismaClient, actor: Actor, deviceId: string): Promise<void> {
  const device = await topologyRepository.findDevice(db, actor.ownerId, deviceId);
  if (!device) throw notFound("device");
  if (isPlc(device)) return deletePlc(db, actor, device.id);

  const connections = await topologyRepository.listConnectionsOf(db, device.id);
  const plcIds = new Set(
    connections.flatMap((connection) => {
      if (connection.sourceEndpointType === "PLC_IO_POINT") return [connection.sourceDeviceId];
      if (connection.targetEndpointType === "PLC_IO_POINT") return [connection.targetDeviceId];
      return [];
    }),
  );
  for (const plcId of plcIds) await unwireDevice(db, actor, plcId, device.id);
  await plcConfigRepository.deleteDevice(db, device.id);
}

async function loadPair(db: PrismaClient, actor: Actor, factoryId: string, firstId: string, secondId: string) {
  await requireFactory(db, actor, factoryId);
  const devices = await topologyRepository.listDevices(db, factoryId);
  const first = devices.find((device) => device.id === firstId);
  const second = devices.find((device) => device.id === secondId);
  if (!first || !second) throw notFound("device");
  return { first, second };
}

/**
 * Connects two devices the way the canvas drew it. When several relationships are
 * possible and none is named, the options are returned instead of guessing.
 */
export async function linkDevices(
  db: PrismaClient,
  actor: Actor,
  factoryId: string,
  input: unknown,
): Promise<LinkResult> {
  const data = parseInput(linkInputSchema, input);
  const { first, second } = await loadPair(db, actor, factoryId, data.fromId, data.toId);
  const options = linkOptions(toParty(first), toParty(second));
  if (options.length === 0) {
    throw new DomainError("INCOMPATIBLE", `${first.name} and ${second.name} have no way to connect.`, {
      rule: "no-link",
    });
  }
  const option = data.kind
    ? options.find((candidate) => candidate.kind === data.kind)
    : options.length === 1
      ? options[0]
      : undefined;
  if (data.kind && !option) {
    throw new DomainError("INCOMPATIBLE", "That relationship is not possible between these two devices.", {
      rule: "link-kind",
    });
  }
  if (!option) return { status: "CHOOSE", options: options.map(({ kind, label }) => ({ kind, label })) };

  const source = option.sourceId === first.id ? first : second;
  const target = option.sourceId === first.id ? second : first;
  if (option.kind === "WIRE_IO") {
    // Uses free compatible channels of the PLC; refused when one terminal finds none.
    await wireExistingDevice(db, actor, source.id, target.id);
  } else if (option.kind === "COMMUNICATES_WITH") {
    const protocol = toParty(source).protocols.find((candidate) => toParty(target).protocols.includes(candidate));
    const port = (device: TopologyDeviceRecord) =>
      device.deviceModel.communicationPorts.find((candidate) =>
        candidate.protocols.some((value) => value === protocol),
      );
    const [sourcePort, targetPort] = [port(source), port(target)];
    if (!sourcePort || !targetPort) throw new DomainError("INVARIANT", "The shared protocol has no port on one side.");
    await db.deviceConnection
      .create({
        data: {
          factoryId,
          sourceDeviceId: source.id,
          targetDeviceId: target.id,
          sourceEndpointType: "PROTOCOL_PORT",
          sourceEndpointRef: sourcePort.id,
          targetEndpointType: "PROTOCOL_PORT",
          targetEndpointRef: targetPort.id,
          relationship: "COMMUNICATES_WITH",
          protocol: "MODBUS_TCP",
        },
      })
      .catch(() => {
        throw new DomainError("CONFLICT", `${source.name} and ${target.name} are already connected this way.`, {
          rule: "already-connected",
        });
      });
  } else {
    await connectDevices(db, {
      factoryId,
      relationship: option.kind,
      source: { deviceId: source.id },
      target: { deviceId: target.id },
    });
  }
  return { status: "LINKED" };
}

/**
 * Removes one typed edge. An edge made of PLC I/O wires is removed together with the
 * device's other wires to that PLC: a device is wired to a PLC as a whole.
 */
export async function unlinkDevices(db: PrismaClient, actor: Actor, factoryId: string, input: unknown): Promise<void> {
  const data = parseInput(unlinkInputSchema, input);
  const { first: source, second: target } = await loadPair(db, actor, factoryId, data.sourceId, data.targetId);
  const connections = (await topologyRepository.listConnectionsOf(db, source.id)).filter(
    (connection) =>
      connection.sourceDeviceId === source.id &&
      connection.targetDeviceId === target.id &&
      connection.relationship === data.relationship,
  );
  if (connections.length === 0) throw notFound("connection");
  const wired = connections.some(
    (connection) =>
      connection.sourceEndpointType === "PLC_IO_POINT" || connection.targetEndpointType === "PLC_IO_POINT",
  );
  if (wired) {
    const [plc, device] = isPlc(source) ? [source, target] : [target, source];
    await unwireDevice(db, actor, plc.id, device.id);
    return;
  }
  await plcConfigRepository.deleteConnections(
    db,
    connections.map((connection) => connection.id),
  );
}
