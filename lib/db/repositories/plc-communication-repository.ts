import "server-only";
import type { Db } from "@/lib/db/client";
import { withDomainErrors } from "@/lib/db/errors";
import type { PlcRelationship, Prisma, Protocol } from "@/lib/generated/prisma/client";

const linkInclude = {
  sourcePlc: { select: { deviceInstance: { select: { id: true, name: true, runtimeStatus: true } } } },
  targetPlc: { select: { deviceInstance: { select: { id: true, name: true, runtimeStatus: true } } } },
  _count: { select: { mappings: true } },
} as const satisfies Prisma.PlcCommunicationConnectionInclude;

const mappingInclude = {
  localTag: true,
  remoteTag: true,
} as const satisfies Prisma.PlcCommunicationMappingInclude;

export type PlcLinkMappingRecord = Prisma.PlcCommunicationMappingGetPayload<{ include: typeof mappingInclude }>;

export type PlcLinkRecord = NonNullable<Awaited<ReturnType<typeof plcCommunicationRepository.findLink>>>;

export type PlcLinkData = {
  factoryId: string;
  sourcePlcInstanceId: string;
  targetPlcInstanceId: string;
  relationship: PlcRelationship;
  protocol: Protocol;
  clientPlcInstanceId: string;
  serverPlcInstanceId: string;
  serverHost: string;
  serverPort: number;
  unitId: number;
  pollIntervalMs: number;
  enabled: boolean;
};

/** PLC-to-PLC communication links (TASK-701) and their configuration versions. */
export const plcCommunicationRepository = {
  /** A link of one of the owner's factories, with the two PLCs. */
  findLink(db: Db, ownerId: string, linkId: string) {
    return db.plcCommunicationConnection.findFirst({
      where: { id: linkId, factory: { ownerId } },
      include: linkInclude,
    });
  },

  listLinks(db: Db, factoryId: string) {
    return db.plcCommunicationConnection.findMany({
      where: { factoryId },
      include: linkInclude,
      orderBy: [{ createdAt: "asc" }],
    });
  },

  /** Links a PLC takes part in, either end, for its export. */
  listPlcLinks(db: Db, plcId: string) {
    return db.plcCommunicationConnection.findMany({
      where: { OR: [{ sourcePlcInstanceId: plcId }, { targetPlcInstanceId: plcId }] },
      include: linkInclude,
      orderBy: [{ createdAt: "asc" }],
    });
  },

  /** A PLC of one of the owner's factories, with what the link rules need. */
  findPlc(db: Db, ownerId: string, plcId: string) {
    return db.deviceInstance.findFirst({
      where: { id: plcId, factory: { ownerId }, plcProfile: { isNot: null } },
      select: {
        id: true,
        factoryId: true,
        name: true,
        deviceModel: { select: { capabilities: true, architectureType: true } },
      },
    });
  },

  createLink(db: Db, data: PlcLinkData) {
    return withDomainErrors(() => db.plcCommunicationConnection.create({ data, include: linkInclude }));
  },

  /** Applies a change and counts a new configuration version of the link. */
  updateLink(
    db: Db,
    linkId: string,
    data: Partial<Omit<PlcLinkData, "factoryId" | "sourcePlcInstanceId" | "targetPlcInstanceId">>,
  ) {
    return withDomainErrors(() =>
      db.plcCommunicationConnection.update({
        where: { id: linkId },
        data: { ...data, configVersion: { increment: 1 } },
        include: linkInclude,
      }),
    );
  },

  deleteLink(db: Db, linkId: string) {
    return db.plcCommunicationConnection.delete({ where: { id: linkId } });
  },

  /** Stores the link's configuration as it is now, under the link's own version number. */
  recordVersion(
    db: Db,
    version: {
      factoryId: string;
      linkId: string;
      version: number;
      createdBy: string;
      snapshotJson: Prisma.InputJsonObject;
    },
  ) {
    return withDomainErrors(() =>
      db.configurationVersion.create({
        data: {
          factoryId: version.factoryId,
          scopeType: "PLC_COMMUNICATION",
          scopeId: version.linkId,
          version: version.version,
          snapshotJson: version.snapshotJson,
          createdBy: version.createdBy,
        },
      }),
    );
  },

  // ───────────── mappings (TASK-702) ─────────────

  listMappings(db: Db, linkId: string) {
    return db.plcCommunicationMapping.findMany({
      where: { plcCommunicationConnectionId: linkId },
      include: mappingInclude,
      orderBy: [{ operation: "asc" }, { createdAt: "asc" }],
    });
  },

  findMapping(db: Db, linkId: string, mappingId: string) {
    return db.plcCommunicationMapping.findFirst({
      where: { id: mappingId, plcCommunicationConnectionId: linkId },
      include: mappingInclude,
    });
  },

  /** Tags by id with what the mapping rules need: the PLC, and whether a module signal is bound to it. */
  findTags(db: Db, tagIds: readonly string[]) {
    return db.tag.findMany({
      where: { id: { in: [...tagIds] } },
      include: { moduleMapping: { select: { id: true } } },
    });
  },

  /** Who already carries a tag over a link: a READ that fills it, or a WRITE that writes it. */
  findTagUse(db: Db, tagId: string) {
    return db.plcCommunicationMapping.findMany({
      where: {
        OR: [
          { localTagId: tagId, operation: "READ" },
          { remoteTagId: tagId, operation: "WRITE" },
        ],
      },
      select: { id: true, operation: true, localTagId: true, remoteTagId: true },
    });
  },

  /** Ids of a PLC's tags a READ mapping fills; their owner is the link (LINK_INPUT). */
  async linkInputTagIds(db: Db, plcIds: readonly string[]): Promise<Set<string>> {
    const rows = await db.plcCommunicationMapping.findMany({
      where: { operation: "READ", localTag: { plcInstanceId: { in: [...plcIds] } } },
      select: { localTagId: true },
    });
    return new Set(rows.map((row) => row.localTagId));
  },

  createMapping(
    db: Db,
    data: {
      linkId: string;
      operation: "READ" | "WRITE";
      localTagId: string;
      remoteTagId: string;
      updateIntervalMs: number | null;
      enabled: boolean;
    },
  ) {
    return withDomainErrors(() =>
      db.plcCommunicationMapping.create({
        data: {
          plcCommunicationConnectionId: data.linkId,
          operation: data.operation,
          localTagId: data.localTagId,
          remoteTagId: data.remoteTagId,
          updateIntervalMs: data.updateIntervalMs,
          enabled: data.enabled,
        },
        include: mappingInclude,
      }),
    );
  },

  updateMapping(db: Db, mappingId: string, data: { updateIntervalMs?: number | null; enabled?: boolean }) {
    return withDomainErrors(() =>
      db.plcCommunicationMapping.update({ where: { id: mappingId }, data, include: mappingInclude }),
    );
  },

  deleteMapping(db: Db, mappingId: string) {
    return db.plcCommunicationMapping.delete({ where: { id: mappingId } });
  },

  /** Counts a new configuration version of the link after a change to its mappings. */
  bumpVersion(db: Db, linkId: string) {
    return db.plcCommunicationConnection.update({
      where: { id: linkId },
      data: { configVersion: { increment: 1 } },
      include: linkInclude,
    });
  },

  /** Holds the link's row for the rest of the transaction, so two mapping changes are versioned one after the other. */
  lockLink(db: Prisma.TransactionClient, linkId: string) {
    return db.$queryRaw`SELECT "id" FROM "PlcCommunicationConnection" WHERE "id" = ${linkId}::uuid FOR UPDATE`;
  },

  /** The published Modbus endpoint of a PLC's runtime, when it has one (TASK-703 health probe). */
  findModbusPort(db: Db, plcId: string) {
    return db.runtimePort.findFirst({
      where: { deviceInstanceId: plcId, protocol: "MODBUS_TCP", hostPort: { not: null } },
    });
  },

  /** The link versions a PLC's runtime was last deployed with (its newest PLC snapshot). */
  async deployedLinkVersions(db: Db, factoryId: string, plcId: string): Promise<Map<string, number>> {
    const snapshot = await db.configurationVersion.findFirst({
      where: { factoryId, scopeType: "PLC", scopeId: plcId },
      orderBy: { version: "desc" },
      select: { snapshotJson: true },
    });
    const links = (snapshot?.snapshotJson as { plcLinks?: Array<{ linkId: string; configVersion: number }> } | null)
      ?.plcLinks;
    return new Map((links ?? []).map((link) => [link.linkId, link.configVersion]));
  },

  listVersions(db: Db, factoryId: string, linkId: string, take = 20) {
    return db.configurationVersion.findMany({
      where: { factoryId, scopeType: "PLC_COMMUNICATION", scopeId: linkId },
      orderBy: { version: "desc" },
      take,
    });
  },
};
