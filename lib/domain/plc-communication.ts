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
import type { ModbusArea, TagDataType } from "@/lib/domain/tag";
import { type AuthorityTag, tagAuthority, TAG_AUTHORITY_LABELS } from "@/lib/domain/tag-authority";

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
  /** Mappings over the link (TASK-702). */
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
  mappings: PlcLinkMappingSnapshot[];
};

export type PlcLinkMappingSnapshot = {
  operation: PlcLinkOperation;
  localTag: string;
  remoteTag: string;
  remoteArea: ModbusArea | null;
  remoteAddress: number | null;
  dataType: TagDataType;
  updateIntervalMs: number | null;
  enabled: boolean;
};

export function toPlcLinkSnapshot(view: PlcLinkView, mappings: readonly PlcLinkMappingView[] = []): PlcLinkSnapshot {
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
    mappings: mappings.map((mapping) => ({
      operation: mapping.operation,
      localTag: mapping.localTag.name,
      remoteTag: mapping.remoteTag.name,
      remoteArea: mapping.remoteTag.area,
      remoteAddress: mapping.remoteTag.address,
      dataType: mapping.remoteTag.dataType,
      updateIntervalMs: mapping.updateIntervalMs,
      enabled: mapping.enabled,
    })),
  };
}

// ───────────────────────────── mappings (TASK-702) ─────────────────────────────

export const PLC_LINK_OPERATIONS = ["READ", "WRITE"] as const;
export type PlcLinkOperation = (typeof PLC_LINK_OPERATIONS)[number];

/** A tag at one end of a mapping, with what the rules need. */
export type LinkTag = AuthorityTag & {
  id: string;
  plcId: string;
  name: string;
  dataType: TagDataType;
  unit: string | null;
  scale: number;
  offset: number;
  protocolArea: ModbusArea | null;
  protocolAddress: number | null;
  /** A process module's signal is bound to it (TASK-605): its writer is the process bridge. */
  moduleBound: boolean;
};

export type PlcLinkMappingRule =
  | "plc-link-tag-plc"
  | "plc-link-modbus"
  | "plc-link-data-type"
  | "plc-link-unit"
  | "plc-link-local-read"
  | "plc-link-local-write"
  | "plc-link-remote-write"
  | "plc-link-adapter";

const mappingRefusal = (code: "INCOMPATIBLE" | "INVARIANT", message: string, rule: PlcLinkMappingRule) =>
  new DomainError(code, message, { rule });

/**
 * Whether a tag of the client and a tag of the server may be carried over a link
 * (ADR-0015). Throws the first rule that is broken.
 *
 * - READ: the server's tag is read as it is; the client's tag is filled by the link, so it is
 *   `%M` memory nobody else writes — not an I/O point, not a command, not a device or module
 *   signal.
 * - WRITE: the client sends a value its program computes (program output or program memory,
 *   never a command a gateway gave it: that would let the gateway reach the peer past the
 *   program); the server's tag is a writable command or setpoint, which the server's own
 *   program then decides on.
 *
 * Both are Modbus-mapped, on/off meets on/off and a number meets a number (the codec scales
 * between the two encodings and saturates), and two units that are both given agree.
 */
export function checkLinkMapping(
  operation: PlcLinkOperation,
  local: LinkTag,
  remote: LinkTag,
  link: { clientPlcId: string; serverPlcId: string },
): void {
  if (local.plcId !== link.clientPlcId || remote.plcId !== link.serverPlcId) {
    throw mappingRefusal(
      "INVARIANT",
      "The local tag belongs to the link's client PLC, the remote tag to its server PLC.",
      "plc-link-tag-plc",
    );
  }
  for (const tag of [local, remote]) {
    if (tag.protocolArea === null || tag.protocolAddress === null) {
      throw mappingRefusal("INCOMPATIBLE", `Tag ${tag.name} has no Modbus mapping.`, "plc-link-modbus");
    }
  }
  if ((local.dataType === "BOOL") !== (remote.dataType === "BOOL")) {
    throw mappingRefusal(
      "INCOMPATIBLE",
      `${local.name} is ${local.dataType} and ${remote.name} is ${remote.dataType}: on/off meets on/off and a number meets a number.`,
      "plc-link-data-type",
    );
  }
  if (local.unit && remote.unit && local.unit !== remote.unit) {
    throw mappingRefusal(
      "INCOMPATIBLE",
      `${local.name} is in ${local.unit} and ${remote.name} in ${remote.unit}.`,
      "plc-link-unit",
    );
  }
  if (operation === "READ") {
    // %I is the client's input image, %M its memory; %Q is its program's outputs.
    const fillable = /^%[IM]/i.test(local.logicalAddress ?? "");
    const free = !local.plcIoPointId && !local.sourceSignal && !local.moduleBound && local.accessMode === "READ_ONLY";
    if (!fillable || !free) {
      throw mappingRefusal(
        "INCOMPATIBLE",
        `${local.name} cannot receive a peer's value: the link fills input (%I) or memory (%M) addresses nothing else writes — not an output, an I/O point, a command, or a device or module signal.`,
        "plc-link-local-read",
      );
    }
    checkOpenPlcLinkMapping(operation, local, remote);
    return;
  }
  const source = tagAuthority(local);
  if (source !== "PROGRAM_OUTPUT" && source !== "PROGRAM_INTERNAL") {
    throw mappingRefusal(
      "INCOMPATIBLE",
      `${local.name} is ${TAG_AUTHORITY_LABELS[source]}; a link sends only what the client's program computes.`,
      "plc-link-local-write",
    );
  }
  if (tagAuthority(remote) !== "EXTERNAL_COMMAND") {
    throw mappingRefusal(
      "INVARIANT",
      `${remote.name} is ${TAG_AUTHORITY_LABELS[tagAuthority(remote)]} of the server; a link writes only its command and setpoint tags, and the server's program decides.`,
      "plc-link-remote-write",
    );
  }
  checkOpenPlcLinkMapping(operation, local, remote);
}

/** The types the OpenPLC runtime's Modbus master carries word for word (TASK-703). */
const OPENPLC_LINK_TYPES: readonly TagDataType[] = ["BOOL", "INT16", "UINT16"];

/**
 * What the OpenPLC adapter can carry (TASK-703, docs/openplc-runtime.md → PLC-to-PLC links):
 * the client's runtime is the Modbus master and copies raw bits and words between the peer's
 * registers and its own image, without scaling. So both tags have the same type, scale and
 * offset; only one-bit and one-word values travel (the master's 32-bit order differs from
 * the server's, and %MD is not the same memory as %MW); and a bit sits in the client's
 * %IX (a READ) or %QX (a WRITE), because the master does not address %MX.
 */
export function checkOpenPlcLinkMapping(operation: PlcLinkOperation, local: LinkTag, remote: LinkTag): void {
  const refuseAdapter = (message: string) => mappingRefusal("INCOMPATIBLE", message, "plc-link-adapter");
  if (!OPENPLC_LINK_TYPES.includes(remote.dataType)) {
    throw refuseAdapter(`${remote.name} is ${remote.dataType}; a PLC link carries BOOL, INT16 and UINT16 values.`);
  }
  if (local.dataType !== remote.dataType || local.scale !== remote.scale || local.offset !== remote.offset) {
    throw refuseAdapter(
      `${local.name} and ${remote.name} differ in type or scaling; the runtime copies raw values, so both carry the same encoding.`,
    );
  }
  if (local.dataType === "BOOL") {
    const expected = operation === "READ" ? /^%IX/i : /^%QX/i;
    if (!expected.test(local.logicalAddress ?? "")) {
      throw refuseAdapter(
        operation === "READ"
          ? `${local.name} receives an on/off value from a peer: give it an input bit (%IX); the runtime does not deliver bits to %MX.`
          : `${local.name} is sent to a peer as an on/off value: it has to be an output bit (%QX) of the program.`,
      );
    }
  }
}

/** A tag end of a mapping as the screens show it. */
export type PlcLinkMappingTag = {
  tagId: string;
  name: string;
  logicalAddress: string | null;
  area: ModbusArea | null;
  address: number | null;
  dataType: TagDataType;
  unit: string | null;
  scale: number;
};

export type PlcLinkMappingView = {
  id: string;
  linkId: string;
  operation: PlcLinkOperation;
  localTag: PlcLinkMappingTag;
  remoteTag: PlcLinkMappingTag;
  /** The interval this value is exchanged at: its own, else the link's. */
  updateIntervalMs: number | null;
  effectiveIntervalMs: number;
  enabled: boolean;
  /** Live quality comes from the link's runtime (TASK-703); null while nothing runs it. */
  quality: "GOOD" | "STALE" | "DISCONNECTED" | null;
};

/**
 * Why one tag cannot be one end of a mapping, whatever the other end is; null when it can.
 * The picker shows every tag with this reason, as the wiring editor does; the pair rules
 * (type, scaling, unit) are checked by `checkLinkMapping` when the mapping is made.
 */
export function linkEndRefusal(operation: PlcLinkOperation, end: "local" | "remote", tag: LinkTag): string | null {
  if (tag.protocolArea === null || tag.protocolAddress === null) return "no Modbus mapping";
  if (!OPENPLC_LINK_TYPES.includes(tag.dataType)) return `${tag.dataType} is not carried (BOOL, INT16, UINT16)`;
  if (end === "remote") {
    return operation === "WRITE" && tagAuthority(tag) !== "EXTERNAL_COMMAND"
      ? `${TAG_AUTHORITY_LABELS[tagAuthority(tag)]}: only a command or setpoint is written`
      : null;
  }
  if (operation === "READ") {
    const fillable = /^%[IM]/i.test(tag.logicalAddress ?? "");
    const free = !tag.plcIoPointId && !tag.sourceSignal && !tag.moduleBound && tag.accessMode === "READ_ONLY";
    if (!fillable || !free) return `${TAG_AUTHORITY_LABELS[tagAuthority(tag)]}: a link fills free %I or %M only`;
    if (tag.dataType === "BOOL" && !/^%IX/i.test(tag.logicalAddress ?? "")) return "a bit from a peer arrives in %IX";
    return null;
  }
  const source = tagAuthority(tag);
  if (source !== "PROGRAM_OUTPUT" && source !== "PROGRAM_INTERNAL") {
    return `${TAG_AUTHORITY_LABELS[source]}: a link sends only what the program computes`;
  }
  if (tag.dataType === "BOOL" && !/^%QX/i.test(tag.logicalAddress ?? "")) return "a bit sent to a peer leaves from %QX";
  return null;
}
