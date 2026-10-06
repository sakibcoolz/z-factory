import "server-only";
import type { Db } from "@/lib/db/client";
import { withDomainErrors } from "@/lib/db/errors";
import type { PlcRelationship, Prisma, Protocol } from "@/lib/generated/prisma/client";

const linkInclude = {
  sourcePlc: { select: { deviceInstance: { select: { id: true, name: true, runtimeStatus: true } } } },
  targetPlc: { select: { deviceInstance: { select: { id: true, name: true, runtimeStatus: true } } } },
} as const satisfies Prisma.PlcCommunicationConnectionInclude;

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

  listVersions(db: Db, factoryId: string, linkId: string, take = 20) {
    return db.configurationVersion.findMany({
      where: { factoryId, scopeType: "PLC_COMMUNICATION", scopeId: linkId },
      orderBy: { version: "desc" },
      take,
    });
  },
};
