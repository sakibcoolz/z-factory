import "server-only";
import type { Db } from "@/lib/db/client";
import type { RuntimeState } from "@/lib/generated/prisma/client";

export type ProcessTagRecord = Awaited<ReturnType<typeof processBridgeRepository.findTags>>[number];

/** What the process bridge reads besides the modules themselves: the tags they are mapped to. */
export const processBridgeRepository = {
  /** Tags by id, with the PLC each belongs to and that PLC's runtime endpoint. Tags of other factories are not returned. */
  findTags(db: Db, factoryId: string, tagIds: readonly string[]) {
    return db.tag.findMany({
      where: { id: { in: [...tagIds] }, plc: { deviceInstance: { factoryId } } },
      include: { plc: { include: { deviceInstance: { include: { runtimePorts: true } } } } },
    });
  },

  setModuleStatus(db: Db, moduleIds: readonly string[], status: RuntimeState) {
    return db.processModuleInstance.updateMany({ where: { id: { in: [...moduleIds] } }, data: { status } });
  },
};
