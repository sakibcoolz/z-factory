import "server-only";
import { createHash } from "node:crypto";
import type { Actor } from "@/lib/auth/actor";
import { processModuleRepository } from "@/lib/db/repositories/process-module-repository";
import { listLinksOfPlc, listPlcLinkMappingsOf } from "./plc-communication-service";
import { plcRepository } from "@/lib/db/repositories/plc-repository";
import { DomainError } from "@/lib/domain/errors";
import {
  EXPORT_NOTICE,
  type ExportScheduleRow,
  PLC_EXPORT_SCHEMA,
  PLC_EXPORT_SCHEMA_VERSION,
  type PlcExportDocument,
} from "@/lib/export/plc-export";
import { findSensitive } from "@/lib/export/redaction";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { edgeLabel, nodeKind, RELATIONSHIP_LABELS } from "@/lib/topology/flow";
import { getCatalogModel } from "./catalog-service";
import { getFactory } from "./factory-service";
import { getPlcConfiguration } from "./plc-config-service";
import { modbusDisplayAddress } from "@/lib/protocols/modbus/located-address";
import { getModbusMap } from "./tag-service";
import { getTopology } from "./topology-service";

/**
 * Builds the engineering export of one PLC from its current configuration
 * (docs/plc-export.md). Every field is copied from a source that holds engineering data
 * only; container ids, credentials and the Docker endpoint are never read into it.
 */

export type PlcExportOptions = {
  /** Adds the stored runtime state (report section 13). Off by default. */
  includeRuntime?: boolean;
  /** Clock, for reproducible output in tests. */
  now?: () => Date;
};

const protocolName = (protocol: string) => protocol.replace("MODBUS_TCP", "Modbus TCP");

/** Hash of the configuration, independent of when the export was made. */
function configurationRevision(document: PlcExportDocument): string {
  const { generatedAt: _generatedAt, runtime: _runtime, revision, ...rest } = document;
  const { configuration: _configuration, ...versions } = revision;
  return createHash("sha256")
    .update(JSON.stringify({ ...rest, revision: versions }))
    .digest("hex")
    .slice(0, 12);
}

/** Refuses to hand out a document that carries something an export must never carry. */
export function assertExportIsClean(document: unknown): void {
  const findings = findSensitive(document);
  if (findings.length > 0) {
    throw new DomainError("INVARIANT", "The export was stopped: it contained data that must not leave the system.", {
      rule: "export-redaction",
      // Where, never what: the finding itself must not travel in an error either.
      findings: findings.map((finding) => `${finding.path}: ${finding.reason}`),
    });
  }
}

export async function buildPlcExport(
  db: PrismaClient,
  actor: Actor,
  plcId: string,
  options: PlcExportOptions = {},
): Promise<PlcExportDocument> {
  const view = await getPlcConfiguration(db, actor, plcId);
  const { factoryId } = view.plc;
  const [factory, map, catalog, topology, record, snapshot] = await Promise.all([
    getFactory(db, actor, factoryId),
    getModbusMap(db, actor, plcId),
    getCatalogModel(db, view.model.id),
    getTopology(db, actor, factoryId),
    plcRepository.findForOwner(db, actor.ownerId, plcId),
    plcRepository.latestConfigurationVersion(db, factoryId, plcId),
  ]);
  if (!record?.plcProfile) throw new DomainError("NOT_FOUND", "The PLC does not exist.");
  const profile = record.plcProfile;
  const deviceName = new Map(topology.nodes.map((node) => [node.id, node.name]));

  const slots = new Map(
    (view.rack?.slots ?? []).flatMap((slot) => (slot.module ? [[slot.slotIndex, slot.module] as const] : [])),
  );
  const ioPoints = view.banks.flatMap((bank) =>
    bank.points.map((point) => ({
      source: bank.slotIndex === null ? ("BUILT_IN" as const) : ("MODULE" as const),
      slot: bank.slotIndex,
      module: bank.slotIndex === null ? null : (slots.get(bank.slotIndex)?.modelName ?? null),
      ioType: point.ioType,
      channel: point.label,
      vendorAddress: point.vendorAddress,
      programAddress: point.logicalAddress,
      signalTypes: point.signalTypes,
      status: point.status,
      device: point.device?.name ?? null,
      deviceTerminal: point.device?.terminalLabel ?? null,
      tag: point.tagName,
    })),
  );

  const tags = map.rows.map((row) => ({
    name: row.name,
    role: row.role,
    dataType: row.dataType,
    direction: row.direction,
    programAddress: row.logicalAddress,
    modbusArea: row.area,
    modbusAddress: row.address,
    modbusDisplayAddress: row.displayAddress,
    wordCount: row.wordCount,
    accessMode: row.accessMode,
    byteOrder: row.byteOrder,
    wordOrder: row.wordOrder,
    scale: row.scale,
    offset: row.offset,
    unit: row.unit,
    sourceDevice: row.sourceDeviceInstanceId ? (deviceName.get(row.sourceDeviceInstanceId) ?? null) : null,
    sourceSignal: row.sourceSignal,
    authority: row.authority,
  }));
  const unitOf = new Map(tags.map((tag) => [tag.name, tag.unit]));

  const connectedDevices = view.peripherals.flatMap((peripheral): ExportScheduleRow[] =>
    peripheral.connection === "PROTOCOL"
      ? peripheral.protocols.map((protocol) => ({
          plcPoint: "—",
          tag: null,
          device: peripheral.name,
          model: peripheral.modelName,
          relationship: "COMMUNICATES_WITH",
          signalOrProtocol: protocolName(protocol),
          address: null,
          unit: null,
        }))
      : peripheral.wires.map((wire) => ({
          plcPoint: `${wire.ioType} ${wire.pointLabel}`,
          tag: wire.tagName,
          device: `${peripheral.name}${wire.terminalLabel ? ` · ${wire.terminalLabel}` : ""}`,
          model: peripheral.modelName,
          // A PLC output controls the device; a PLC input is fed back by it.
          relationship: wire.ioType === "DO" || wire.ioType === "AO" ? "CONTROLS" : "FEEDS_BACK_TO",
          signalOrProtocol: wire.ioType === "DI" || wire.ioType === "DO" ? "digital" : "analog",
          address: wire.logicalAddress,
          unit: wire.tagName ? (unitOf.get(wire.tagName) ?? null) : null,
        })),
  );

  // The PLC's part of the factory: everything reachable from it over any connection.
  const reachable = new Set([view.plc.id]);
  for (let grown = true; grown;) {
    grown = false;
    for (const edge of topology.edges) {
      if (reachable.has(edge.sourceId) !== reachable.has(edge.targetId)) {
        reachable.add(edge.sourceId).add(edge.targetId);
        grown = true;
      }
    }
  }
  const edges = topology.edges.filter((edge) => reachable.has(edge.sourceId) && reachable.has(edge.targetId));
  const program = profile.programVersion;
  const count = (ioType: string, occupiedOnly = false) =>
    ioPoints.filter((point) => point.ioType === ioType && (!occupiedOnly || point.status !== "FREE")).length;

  const document: PlcExportDocument = {
    schema: PLC_EXPORT_SCHEMA,
    schemaVersion: PLC_EXPORT_SCHEMA_VERSION,
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    revision: {
      configuration: "",
      ioMapping: view.plc.ioMappingVersion,
      modbusMapping: view.plc.modbusMappingVersion,
      program: program
        ? {
            version: program.version,
            language: program.language,
            checksum: program.checksum,
            status: program.status,
            createdAt: program.createdAt.toISOString(),
          }
        : null,
      deployedSnapshot: snapshot ? { version: snapshot.version, createdAt: snapshot.createdAt.toISOString() } : null,
    },
    factory: { id: factory.id, name: factory.name, slug: factory.slug, subnetCidr: factory.subnetCidr },
    plc: {
      id: view.plc.id,
      name: view.plc.name,
      role: view.plc.role,
      architecture: view.plc.architectureType,
      runtime: "OpenPLC",
      runtimeNote: "Runs on OpenPLC. The model is a hardware profile, not vendor firmware.",
      runtimeImage: profile.runtimeImage,
      runtimeVersion: profile.runtimeVersion,
    },
    model: {
      manufacturer: view.model.manufacturer,
      family: view.model.family,
      modelName: view.model.modelName,
      sku: view.model.sku,
      verificationStatus: view.model.verificationStatus,
      source: catalog.source.url
        ? {
            title: catalog.source.title,
            revision: catalog.source.revision,
            url: catalog.source.url,
            verifiedAt: catalog.source.verifiedAt,
          }
        : null,
      facts: catalog.facts,
    },
    electrical: view.electrical,
    ports: view.ports,
    hardware: {
      channels: (["DI", "DO", "AI", "AO"] as const)
        .map((ioType) => ({ ioType, count: count(ioType), occupied: count(ioType, true) }))
        .filter((entry) => entry.count > 0),
      rack: view.rack
        ? {
            name: view.rack.name,
            slotCount: view.rack.slotCount,
            modules: view.rack.slots.flatMap((slot) =>
              slot.module
                ? [
                    {
                      slot: slot.slotIndex,
                      modelName: slot.module.modelName,
                      sku: slot.module.sku,
                      moduleType: slot.module.moduleType,
                      channels: slot.module.pointCount,
                      occupied: slot.module.occupiedCount,
                    },
                  ]
                : [],
            ),
          }
        : null,
    },
    ioPoints,
    tags,
    moduleSignals: (await processModuleRepository.listPlcMappings(db, plcId)).map((mapping) => ({
      module: mapping.processModuleInstance.name,
      moduleType: mapping.processModuleInstance.processModuleType.code,
      signal: mapping.moduleSignalDefinition.key,
      direction: mapping.moduleSignalDefinition.direction,
      tag: mapping.tag.name,
      programAddress: mapping.tag.logicalAddress ?? "",
    })),
    connectedDevices,
    relationships: edges.map((edge) => ({
      source: deviceName.get(edge.sourceId) ?? "?",
      relationship: edge.relationship,
      target: deviceName.get(edge.targetId) ?? "?",
      detail: edgeLabel(edge)
        .replace(`${RELATIONSHIP_LABELS[edge.relationship]} · `, "")
        .replace(RELATIONSHIP_LABELS[edge.relationship], ""),
    })),
    network: {
      serviceName: record.hostName,
      modbusEndpoint: map.endpoint,
      modbusConventions: map.conventions,
      protocolLinks: view.peripherals.flatMap((peripheral) =>
        peripheral.protocols.map((protocol) => ({ device: peripheral.name, protocol: protocolName(protocol) })),
      ),
      plcLinks: await Promise.all(
        (await listLinksOfPlc(db, plcId)).map(async (link) => ({
          relationship: link.relationship,
          role: link.clientPlcId === plcId ? ("client" as const) : ("server" as const),
          peer: link.source.plcId === plcId ? link.target.name : link.source.name,
          protocol: protocolName(link.protocol),
          serverHost: link.serverHost,
          serverPort: link.serverPort,
          unitId: link.unitId,
          pollIntervalMs: link.pollIntervalMs,
          enabled: link.enabled,
          configVersion: link.configVersion,
          mappings: link.mappingCount,
          values: (await listPlcLinkMappingsOf(db, link.id)).map((mapping) => ({
            operation: mapping.operation,
            clientTag: mapping.localTag.name,
            serverTag: mapping.remoteTag.name,
            serverRegister:
              mapping.remoteTag.area !== null && mapping.remoteTag.address !== null
                ? modbusDisplayAddress(mapping.remoteTag.area, mapping.remoteTag.address)
                : "",
            dataType: mapping.remoteTag.dataType,
            intervalMs: mapping.effectiveIntervalMs,
            enabled: mapping.enabled,
          })),
        })),
      ),
    },
    topology: {
      nodes: topology.nodes
        .filter((node) => reachable.has(node.id))
        .map((node) => ({ id: node.id, name: node.name, kind: nodeKind(node), x: node.x, y: node.y })),
      edges: edges.map((edge) => ({
        sourceId: edge.sourceId,
        targetId: edge.targetId,
        relationship: edge.relationship,
        label: edgeLabel(edge),
      })),
    },
    ...(options.includeRuntime
      ? { runtime: { state: view.plc.runtimeStatus, note: "Last state stored by Z-Factory, not a live reading." } }
      : {}),
    notice: EXPORT_NOTICE,
  };
  document.revision.configuration = configurationRevision(document);
  assertExportIsClean(document);
  return document;
}

/** File name stem for downloads: `PLC-01-3f2a9c1d0b7e`. */
export function exportFileStem(document: PlcExportDocument): string {
  return `${document.plc.name.replace(/[^A-Za-z0-9._-]+/g, "_")}-${document.revision.configuration}`;
}
