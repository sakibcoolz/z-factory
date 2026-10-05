import "server-only";
import { z } from "zod";
import type { Actor } from "@/lib/auth/actor";
import { type GatewayConnectionRecord, gatewayRepository } from "@/lib/db/repositories/gateway-repository";
import { plcRepository } from "@/lib/db/repositories/plc-repository";
import { assertPortBindings, listPublishedPorts, type PublishedPort } from "@/lib/docker/ports";
import { DomainError } from "@/lib/domain/errors";
import { GATEWAY_REFUSAL_TEXT, type GatewayRegister } from "@/lib/domain/gateway";
import type {
  GatewayConnectionView,
  GatewayMapDocument,
  GatewayRegisterView,
  GatewaysView,
} from "@/lib/domain/gateway-view";
import { isWritableTagRole } from "@/lib/domain/tag";
import type { Tag } from "@/lib/generated/prisma/client";
import { type ModbusEndpoint, readModbus } from "@/lib/protocols/modbus/client";
import { modbusDisplayAddress } from "@/lib/protocols/modbus/located-address";
import type {
  GatewayBackend,
  GatewayEndpointRuntime,
  GatewayEndpointSpec,
} from "@/lib/runtimes/gateway-endpoint/runtime";
import { modbusEndpoint } from "@/lib/runtimes/openplc/adapter";
import { parseInput } from "@/lib/validation/parse";
import { recordEvent } from "./event-service";
import { getFactory } from "./factory-service";
import { requireTarget, type RuntimeDeps } from "./plc-runtime-service";
import { decodeRawTagValue, writeTag } from "./tag-service";
import { placeDevice } from "./topology-service";

/**
 * External gateways (TASK-501, ADR-0013). A gateway is a device of the factory that
 * stands for an edge device on the network. It is given a connection to a PLC: an
 * address and port of this host, a unit id, and the tags it may read or write.
 *
 * The gateway never talks to the PLC's own Modbus server. It talks to an endpoint
 * Z-Factory runs for it, which hands out the mapped tags only and passes a write on as
 * a tag write with source GATEWAY, so every gateway command is checked, recorded and
 * decided by PLC logic like any other.
 */

export type GatewayDeps = RuntimeDeps & { endpoints: GatewayEndpointRuntime };

const MODBUS_CONTAINER_PORT = 502;
const NO_DEVICE = "00000000-0000-0000-0000-000000000000";

const connectSchema = z.object({
  plcId: z.uuid(),
  host: z.string().regex(/^\d{1,3}(\.\d{1,3}){3}$/, "use an IPv4 address of this host"),
  port: z.coerce.number().int().min(1).max(65_535),
  unitId: z.coerce.number().int().min(1).max(247).default(1),
  pollIntervalMs: z.coerce.number().int().min(100).max(60_000).default(1000),
});

const mapSchema = z.object({
  tagId: z.uuid(),
  access: z.enum(["READ", "READ_WRITE"]).default("READ"),
  /** The name the gateway knows the value by; the tag's own name when left out. */
  externalName: z
    .string()
    .trim()
    .regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/, "use letters, digits, dots, hyphens and underscores")
    .optional(),
});

const notFound = (what: string) => new DomainError("NOT_FOUND", `The ${what} does not exist.`);

type MappedTag = Tag & { protocolArea: NonNullable<Tag["protocolArea"]>; protocolAddress: number };
const isMapped = (tag: Tag): tag is MappedTag => tag.protocolArea !== null && tag.protocolAddress !== null;

/** A tag a gateway may be allowed to write: a command or setpoint, as for any other writer. */
const tagWritable = (tag: Tag) => tag.accessMode === "READ_WRITE" && isWritableTagRole(tag.role);

const isBitArea = (area: string) => area === "COIL" || area === "DISCRETE_INPUT";

function toRegisters(connection: GatewayConnectionRecord): GatewayRegister[] {
  return connection.tagMappings.flatMap(({ tag, externalName, accessMode }) =>
    isMapped(tag)
      ? [
          {
            tagId: tag.id,
            name: tag.name,
            externalName,
            area: tag.protocolArea,
            address: tag.protocolAddress,
            wordCount: isBitArea(tag.protocolArea) ? 1 : tag.wordCount,
            writable: accessMode === "READ_WRITE" && tagWritable(tag),
          },
        ]
      : [],
  );
}

const toSpec = (connection: GatewayConnectionRecord): GatewayEndpointSpec => ({
  connectionId: connection.id,
  factoryId: connection.gateway.deviceInstance.factoryId,
  gatewayDeviceId: connection.gateway.deviceInstance.id,
  plcId: connection.plc.deviceInstance.id,
  host: connection.host,
  port: connection.port,
  unitId: connection.unitId,
  registers: toRegisters(connection),
});

async function loadConnection(deps: GatewayDeps, actor: Actor, connectionId: string): Promise<GatewayConnectionRecord> {
  const connection = z.uuid().safeParse(connectionId).success
    ? await gatewayRepository.findConnection(deps.db, actor.ownerId, connectionId)
    : null;
  if (!connection) throw notFound("gateway connection");
  return connection;
}

/** Every host port something is published or configured on, except one gateway connection. */
async function takenPorts(deps: GatewayDeps, exceptConnectionId?: string): Promise<PublishedPort[]> {
  const [published, reserved, endpoints] = await Promise.all([
    // Without the engine nothing is published by a container; the listener itself reports a port in use.
    listPublishedPorts(deps.docker).catch(() => []),
    plcRepository.listReservedHostPorts(deps.db, NO_DEVICE),
    gatewayRepository.listEndpoints(deps.db),
  ]);
  return [
    ...published,
    ...reserved,
    ...endpoints
      .filter((endpoint) => endpoint.id !== exceptConnectionId)
      .map((endpoint) => ({ hostPort: endpoint.port, bindAddress: endpoint.host })),
  ];
}

/** How long a refusal of the same request is not recorded again: a polling gateway repeats itself. */
const REFUSAL_QUIET_MS = 30_000;
/** How long the Modbus endpoint of a PLC is trusted before it is looked up again. */
const TARGET_TTL_MS = 2000;

/**
 * What an endpoint does with a request it allowed, and what is recorded about one it
 * refused. Reads go to the PLC's Modbus server as they are; a write becomes a tag write.
 */
function createBackend(deps: GatewayDeps, ownerId: string): GatewayBackend {
  const actor: Actor = { ownerId };
  const targets = new Map<string, { endpoint: ModbusEndpoint; at: number }>();
  const refusals = new Map<string, number>();

  const targetOf = async (plcId: string): Promise<ModbusEndpoint> => {
    const cached = targets.get(plcId);
    if (cached && Date.now() - cached.at < TARGET_TTL_MS) return cached.endpoint;
    const device = await plcRepository.findForOwner(deps.db, ownerId, plcId);
    if (!device) throw notFound("PLC");
    const endpoint = modbusEndpoint(requireTarget(device));
    targets.set(plcId, { endpoint, at: Date.now() });
    return endpoint;
  };

  return {
    async read(spec, area, address, count) {
      try {
        return await readModbus(await targetOf(spec.plcId), area, address, count);
      } catch (error) {
        targets.delete(spec.plcId);
        throw error;
      }
    },

    async write(spec, register, raw) {
      const tag = await deps.db.tag.findUnique({ where: { id: register.tagId } });
      if (!tag) throw notFound("tag");
      await writeTag(deps, actor, spec.plcId, tag.name, decodeRawTagValue(tag, raw), "GATEWAY");
    },

    async refused(spec, refusal) {
      const key = `${spec.connectionId}|${refusal.rule}|${refusal.area}|${refusal.address}|${refusal.count}`;
      const now = Date.now();
      if (now - (refusals.get(key) ?? 0) < REFUSAL_QUIET_MS) return;
      refusals.set(key, now);
      await recordEvent(deps, {
        type: "COMMAND_REJECTED",
        factoryId: spec.factoryId,
        deviceId: spec.plcId,
        severity: "WARNING",
        payload: {
          source: "GATEWAY",
          rule: refusal.rule,
          message: `A gateway write was refused: ${GATEWAY_REFUSAL_TEXT[refusal.rule]}.`,
          ...(refusal.register ? { tag: refusal.register.name } : {}),
          area: refusal.area,
          address: refusal.address,
          count: refusal.count,
        },
      });
    },

    client(spec, event, remoteAddress) {
      void recordEvent(deps, {
        type: event === "connected" ? "GATEWAY_CLIENT_CONNECTED" : "GATEWAY_CLIENT_DISCONNECTED",
        factoryId: spec.factoryId,
        deviceId: spec.gatewayDeviceId,
        severity: "INFO",
        payload: { name: remoteAddress, link: "gateway-endpoint", plcId: spec.plcId },
      }).catch(() => undefined);
    },
  };
}

/**
 * Brings the endpoints of a factory in line with its gateway connections: opens those
 * that are enabled, closes the others, and takes over changed mappings. Endpoints live in
 * the server process; after a restart they are opened again by the first call of this.
 */
export async function syncGatewayEndpoints(deps: GatewayDeps, factoryId: string): Promise<void> {
  const connections = await gatewayRepository.listConnections(deps.db, factoryId);
  const enabled = connections.filter((connection) => connection.enabled);
  await deps.endpoints.stopOthers(factoryId, new Set(enabled.map((connection) => connection.id)));
  if (connections.length === 0) return;

  const factory = await deps.db.factory.findUnique({ where: { id: factoryId }, select: { ownerId: true } });
  if (!factory) return;
  const backend = createBackend(deps, factory.ownerId);
  // A gateway is running while its endpoints are open, and faulted when one could not be opened.
  const states = new Map<string, { stored: string; state: "RUNNING" | "STOPPED" | "FAULTED" }>();
  for (const connection of connections) {
    const entry = states.get(connection.gateway.id) ?? { stored: connection.gateway.status, state: "STOPPED" as const };
    if (connection.enabled) {
      const status = await deps.endpoints.ensure(toSpec(connection), backend);
      if (!status.listening) entry.state = "FAULTED";
      else if (entry.state !== "FAULTED") entry.state = "RUNNING";
    }
    states.set(connection.gateway.id, entry);
  }
  for (const [gatewayId, { stored, state }] of states) {
    if (stored !== state) await gatewayRepository.setGatewayStatus(deps.db, gatewayId, state);
  }
}

function toRegisterViews(connection: GatewayConnectionRecord): GatewayRegisterView[] {
  return connection.tagMappings
    .flatMap(({ id, tag, externalName, accessMode }) =>
      isMapped(tag)
        ? [
            {
              mappingId: id,
              tagId: tag.id,
              tagName: tag.name,
              externalName,
              role: tag.role,
              dataType: tag.dataType,
              area: tag.protocolArea,
              address: tag.protocolAddress,
              displayAddress: modbusDisplayAddress(tag.protocolArea, tag.protocolAddress),
              wordCount: isBitArea(tag.protocolArea) ? 1 : tag.wordCount,
              access: accessMode === "READ_WRITE" && tagWritable(tag) ? ("READ_WRITE" as const) : ("READ" as const),
              unit: tag.unit,
            },
          ]
        : [],
    )
    .sort((a, b) => a.area.localeCompare(b.area) || a.address - b.address);
}

/** The gateways of a factory with their connections, mappings and the state of their endpoints. */
export async function getGatewaysView(deps: GatewayDeps, actor: Actor, factoryId: string): Promise<GatewaysView> {
  const factory = await getFactory(deps.db, actor, factoryId);
  await syncGatewayEndpoints(deps, factory.id);
  const [devices, plcs, taken] = await Promise.all([
    gatewayRepository.listGatewayDevices(deps.db, factory.id),
    gatewayRepository.listPlcs(deps.db, factory.id),
    takenPorts(deps),
  ]);
  const { portRange, bindAddresses } = deps.policy;
  const used = new Set(taken.map((port) => port.hostPort));
  let suggestedPort: number | null = null;
  for (let port = portRange.min; port <= portRange.max && suggestedPort === null; port += 1) {
    if (!used.has(port)) suggestedPort = port;
  }

  return {
    factory: { id: factory.id, name: factory.name },
    bindAddresses: [...bindAddresses],
    portRange,
    suggestedPort,
    hasPlc: plcs.length > 0,
    gateways: devices.map((device) => {
      const connections = device.gateway?.plcConnections ?? [];
      return {
        deviceId: device.id,
        name: device.name,
        modelName: device.deviceModel.modelName,
        availablePlcs: plcs
          .filter((plc) => !connections.some((connection) => connection.plcInstanceId === plc.id))
          .map((plc) => ({ id: plc.id, name: plc.name })),
        connections: connections.map((connection): GatewayConnectionView => {
          const mapped = new Set(connection.tagMappings.map((mapping) => mapping.tagId));
          const tags = plcs.find((plc) => plc.id === connection.plcInstanceId)?.plcProfile?.tags ?? [];
          return {
            id: connection.id,
            plcId: connection.plc.deviceInstance.id,
            plcName: connection.plc.deviceInstance.name,
            plcState: connection.plc.deviceInstance.runtimeStatus,
            host: connection.host,
            port: connection.port,
            unitId: connection.unitId,
            pollIntervalMs: connection.pollIntervalMs,
            enabled: connection.enabled,
            endpoint: deps.endpoints.status(connection.id),
            registers: toRegisterViews(connection),
            unmappedTags: tags
              .filter((tag) => !mapped.has(tag.id))
              .map((tag) => ({
                id: tag.id,
                name: tag.name,
                role: tag.role,
                dataType: tag.dataType,
                writable: tagWritable(tag),
              })),
          };
        }),
      };
    }),
  };
}

/** Adds a gateway device to the factory from the catalog's generic gateway model. */
export async function addGateway(
  deps: GatewayDeps,
  actor: Actor,
  factoryId: string,
): Promise<{ id: string; name: string }> {
  const factory = await getFactory(deps.db, actor, factoryId);
  const model = await gatewayRepository.findGatewayModel(deps.db);
  if (!model) {
    throw new DomainError("CONFLICT", "The catalog has no gateway model. Run npm run db:seed.", {
      rule: "gateway-model-required",
    });
  }
  const existing = await gatewayRepository.listGatewayDevices(deps.db, factory.id);
  // Beside the designer's default grid, one below the other, until the owner places it.
  return placeDevice(deps.db, actor, factory.id, { deviceModelId: model.id, x: 900, y: 80 + existing.length * 160 });
}

/**
 * Connects a gateway to a PLC: reserves an address and port of this host for it and
 * opens the endpoint. The address must be one the host policy allows and the port free.
 */
export async function connectGateway(
  deps: GatewayDeps,
  actor: Actor,
  gatewayDeviceId: string,
  input: unknown,
): Promise<{ connectionId: string }> {
  const data = parseInput(connectSchema, input);
  const device = z.uuid().safeParse(gatewayDeviceId).success
    ? await gatewayRepository.findGatewayDevice(deps.db, actor.ownerId, gatewayDeviceId)
    : null;
  if (!device) throw notFound("gateway");
  const plc = await plcRepository.findForOwner(deps.db, actor.ownerId, data.plcId);
  if (!plc?.plcProfile || plc.factoryId !== device.factoryId) {
    throw new DomainError("NOT_FOUND", "The PLC does not exist in this factory.", { rule: "gateway-same-factory" });
  }
  assertPortBindings(
    [{ containerPort: MODBUS_CONTAINER_PORT, hostPort: data.port, bindAddress: data.host }],
    await takenPorts(deps),
    deps.policy,
  );
  const gateway = await gatewayRepository.ensureGateway(deps.db, device);
  const connection = await gatewayRepository.createConnection(deps.db, {
    gatewayId: gateway.id,
    plcInstanceId: plc.id,
    host: data.host,
    port: data.port,
    unitId: data.unitId,
    pollIntervalMs: data.pollIntervalMs,
  });
  await syncGatewayEndpoints(deps, device.factoryId);
  return { connectionId: connection.id };
}

/** Opens or closes the endpoint of a connection; its mappings are kept. */
export async function setGatewayConnectionEnabled(
  deps: GatewayDeps,
  actor: Actor,
  connectionId: string,
  enabled: boolean,
): Promise<void> {
  const connection = await loadConnection(deps, actor, connectionId);
  await gatewayRepository.setEnabled(deps.db, connection.id, enabled);
  await syncGatewayEndpoints(deps, connection.gateway.deviceInstance.factoryId);
}

export async function removeGatewayConnection(deps: GatewayDeps, actor: Actor, connectionId: string): Promise<void> {
  const connection = await loadConnection(deps, actor, connectionId);
  await gatewayRepository.deleteConnection(deps.db, connection.id);
  await syncGatewayEndpoints(deps, connection.gateway.deviceInstance.factoryId);
}

/**
 * Gives a gateway a tag of the PLC it is connected to. Writing can only be granted for a
 * command or setpoint tag: what PLC logic produces is never a gateway's to write.
 */
export async function mapGatewayTag(
  deps: GatewayDeps,
  actor: Actor,
  connectionId: string,
  input: unknown,
): Promise<void> {
  const data = parseInput(mapSchema, input);
  const connection = await loadConnection(deps, actor, connectionId);
  const tag = await gatewayRepository.findTag(deps.db, connection.plcInstanceId, data.tagId);
  if (!tag || !isMapped(tag)) throw notFound("tag");
  if (data.access === "READ_WRITE" && !tagWritable(tag)) {
    throw new DomainError("INVARIANT", `${tag.name} is a ${tag.role} tag; a gateway can only read it.`, {
      rule: "gateway-write-command-only",
    });
  }
  await gatewayRepository.upsertMapping(deps.db, {
    gatewayPlcConnectionId: connection.id,
    tagId: tag.id,
    externalName: data.externalName ?? tag.name,
    accessMode: data.access === "READ_WRITE" ? "READ_WRITE" : "READ_ONLY",
  });
  await syncGatewayEndpoints(deps, connection.gateway.deviceInstance.factoryId);
}

/** Gives a gateway every tag of the PLC: commands and setpoints writable, everything else to read. */
export async function mapAllGatewayTags(deps: GatewayDeps, actor: Actor, connectionId: string): Promise<number> {
  const connection = await loadConnection(deps, actor, connectionId);
  const mapped = new Set(connection.tagMappings.map((mapping) => mapping.tagId));
  const tags = (await deps.db.tag.findMany({ where: { plcInstanceId: connection.plcInstanceId } })).filter(
    (tag) => isMapped(tag) && !mapped.has(tag.id),
  );
  for (const tag of tags) {
    await gatewayRepository.upsertMapping(deps.db, {
      gatewayPlcConnectionId: connection.id,
      tagId: tag.id,
      externalName: tag.name,
      accessMode: tagWritable(tag) ? "READ_WRITE" : "READ_ONLY",
    });
  }
  await syncGatewayEndpoints(deps, connection.gateway.deviceInstance.factoryId);
  return tags.length;
}

export async function unmapGatewayTag(
  deps: GatewayDeps,
  actor: Actor,
  connectionId: string,
  mappingId: string,
): Promise<void> {
  const connection = await loadConnection(deps, actor, connectionId);
  if (!z.uuid().safeParse(mappingId).success) throw notFound("mapping");
  const { count } = await gatewayRepository.deleteMapping(deps.db, connection.id, mappingId);
  if (count === 0) throw notFound("mapping");
  await syncGatewayEndpoints(deps, connection.gateway.deviceInstance.factoryId);
}

/** The document an edge client is configured from: where to connect, what to read, what it may write. */
export async function getGatewayMap(
  deps: GatewayDeps,
  actor: Actor,
  connectionId: string,
): Promise<GatewayMapDocument> {
  const connection = await loadConnection(deps, actor, connectionId);
  const tags = new Map(connection.tagMappings.map((mapping) => [mapping.tagId, mapping.tag]));
  return {
    schema: "z-factory.gateway-map",
    schemaVersion: 1,
    gateway: connection.gateway.deviceInstance.name,
    plc: connection.plc.deviceInstance.name,
    endpoint: { protocol: "MODBUS_TCP", host: connection.host, port: connection.port, unitId: connection.unitId },
    pollIntervalMs: connection.pollIntervalMs,
    conventions: { addressing: "zero-based", byteOrder: "BIG_ENDIAN", wordOrder: "HIGH_WORD_FIRST" },
    registers: toRegisterViews(connection).map((register) => {
      const tag = tags.get(register.tagId);
      return {
        name: register.externalName,
        tag: register.tagName,
        role: register.role,
        dataType: register.dataType,
        area: register.area,
        address: register.address,
        displayAddress: register.displayAddress,
        wordCount: register.wordCount,
        access: register.access,
        scale: tag?.scale ?? 1,
        offset: tag?.offset ?? 0,
        unit: register.unit,
      };
    }),
  };
}
