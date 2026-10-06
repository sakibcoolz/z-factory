/**
 * PLC-to-PLC communication links (Phase 07, TASK-701; docs/architecture.md → PLC-to-PLC
 * communication). A link joins two PLC instances of one factory: one is the protocol
 * client, the other the server, and the relationship says what the link is for. Both
 * PLCs keep their own program, runtime and local control logic; a link grants no write on
 * its own — mappings over it (TASK-702) do, and only on explicitly writable endpoints.
 * Pure rules and shapes; importable anywhere.
 */
import {
  type DeviceCapability,
  hasCapability,
  isProgrammableController,
  type ModelCapabilities,
} from "@/lib/domain/device-capabilities";
import { DomainError } from "@/lib/domain/errors";
import type { RuntimeState } from "@/lib/domain/runtime-state";
import { serviceNameFor } from "@/lib/domain/service-name";

export const PLC_RELATIONSHIPS = ["COMMUNICATES_WITH", "SUPERVISES"] as const;
export type PlcRelationship = (typeof PLC_RELATIONSHIPS)[number];

export const PLC_RELATIONSHIP_LABELS: Record<PlcRelationship, string> = {
  COMMUNICATES_WITH: "communicates with",
  SUPERVISES: "supervises",
};

/** The protocols a link can use; Modbus TCP first (docs/gateway-modbus.md). */
export const PLC_LINK_PROTOCOLS = ["MODBUS_TCP"] as const;
export type PlcLinkProtocol = (typeof PLC_LINK_PROTOCOLS)[number];

/** Which end of the link is the protocol client; the other end is the server. */
export const PLC_LINK_CLIENTS = ["SOURCE", "TARGET"] as const;
export type PlcLinkClient = (typeof PLC_LINK_CLIENTS)[number];

/** The default endpoint of a server PLC: the runtime's Modbus TCP port inside the factory network. */
export const PLC_LINK_DEFAULTS = { serverPort: 502, unitId: 1, pollIntervalMs: 1000 } as const;
export const PLC_LINK_LIMITS = {
  serverPort: { min: 1, max: 65535 },
  unitId: { min: 0, max: 255 },
  pollIntervalMs: { min: 50, max: 60_000 },
} as const;

/** What the rules need to know about a PLC at one end of a link. */
export type LinkEndpointPlc = {
  id: string;
  factoryId: string;
  name: string;
  model: Pick<ModelCapabilities, "capabilities" | "architectureType">;
};

export type PlcLinkRule =
  "plc-link-self" | "plc-link-factory" | "plc-link-controller" | "plc-link-server-protocol" | "plc-link-protocol";

const refuse = (code: "VALIDATION" | "INVARIANT" | "INCOMPATIBLE", message: string, rule: PlcLinkRule, extra = {}) =>
  new DomainError(code, message, { rule, ...extra });

/** The capability a PLC needs to serve a protocol. */
const SERVER_CAPABILITY: Record<PlcLinkProtocol, DeviceCapability> = { MODBUS_TCP: "MODBUS_SERVER" };

/**
 * Whether two PLCs may be linked. Throws the first rule that is broken: a PLC is not linked
 * to itself, both belong to the same factory (Phase 07), both are programmable controllers,
 * and the server's model declares that it serves the protocol.
 */
export function checkPlcLink(
  source: LinkEndpointPlc,
  target: LinkEndpointPlc,
  protocol: PlcLinkProtocol,
  client: PlcLinkClient,
): void {
  if (source.id === target.id) {
    throw refuse("VALIDATION", "A PLC cannot be linked to itself.", "plc-link-self");
  }
  if (source.factoryId !== target.factoryId) {
    throw refuse(
      "INVARIANT",
      `${source.name} and ${target.name} are in different factories; a PLC link stays inside one factory.`,
      "plc-link-factory",
    );
  }
  for (const plc of [source, target]) {
    if (!isProgrammableController(plc.model)) {
      throw refuse("INCOMPATIBLE", `${plc.name} is not a programmable controller.`, "plc-link-controller", {
        plcId: plc.id,
      });
    }
  }
  const server = client === "SOURCE" ? target : source;
  if (!hasCapability(server.model, SERVER_CAPABILITY[protocol])) {
    throw refuse(
      "INCOMPATIBLE",
      `${server.name} does not serve ${protocolName(protocol)}; its model declares no ${SERVER_CAPABILITY[protocol]} capability.`,
      "plc-link-server-protocol",
      { plcId: server.id },
    );
  }
}

export const protocolName = (protocol: string) => protocol.replace("MODBUS_TCP", "Modbus TCP");

/** The server's name on the factory network: the deterministic service name of the server PLC. */
export function plcLinkServerHost(serverPlcName: string): string {
  return serviceNameFor(serverPlcName);
}

/** One end of a link as the screens and the export show it. */
export type PlcLinkEnd = { plcId: string; name: string; runtimeStatus: RuntimeState };

export type PlcLinkView = {
  id: string;
  factoryId: string;
  relationship: PlcRelationship;
  protocol: PlcLinkProtocol;
  source: PlcLinkEnd;
  target: PlcLinkEnd;
  /** Which end is the protocol client. */
  client: PlcLinkClient;
  clientPlcId: string;
  serverPlcId: string;
  serverHost: string;
  serverPort: number;
  unitId: number;
  pollIntervalMs: number;
  enabled: boolean;
  configVersion: number;
  /** Mappings over the link (TASK-702); none yet. */
  mappingCount: number;
  createdAt: string;
  updatedAt: string;
};

export const PLC_LINK_EXPORT_SCHEMA = "z-factory.plc-link";
export const PLC_LINK_EXPORT_SCHEMA_VERSION = 1;

/**
 * A link as it is versioned and exported: the two PLCs by name, the roles, the endpoint
 * and the mappings (empty until TASK-702). A configuration version stores exactly this.
 */
export type PlcLinkSnapshot = {
  schema: typeof PLC_LINK_EXPORT_SCHEMA;
  schemaVersion: typeof PLC_LINK_EXPORT_SCHEMA_VERSION;
  configVersion: number;
  link: {
    relationship: PlcRelationship;
    protocol: PlcLinkProtocol;
    sourcePlc: string;
    targetPlc: string;
    client: PlcLinkClient;
    serverHost: string;
    serverPort: number;
    unitId: number;
    pollIntervalMs: number;
    enabled: boolean;
  };
  mappings: Array<Record<string, string | number | boolean | null>>;
};

export function toPlcLinkSnapshot(view: PlcLinkView): PlcLinkSnapshot {
  return {
    schema: PLC_LINK_EXPORT_SCHEMA,
    schemaVersion: PLC_LINK_EXPORT_SCHEMA_VERSION,
    configVersion: view.configVersion,
    link: {
      relationship: view.relationship,
      protocol: view.protocol,
      sourcePlc: view.source.name,
      targetPlc: view.target.name,
      client: view.client,
      serverHost: view.serverHost,
      serverPort: view.serverPort,
      unitId: view.unitId,
      pollIntervalMs: view.pollIntervalMs,
      enabled: view.enabled,
    },
    mappings: [],
  };
}
