import "server-only";
import type { Db } from "@/lib/db/client";
import type { Prisma } from "@/lib/generated/prisma/client";

export type AuditEntry = {
  organizationId?: string | null;
  actorUserId?: string | null;
  action: string;
  subjectType: string;
  subjectId?: string | null;
  detail?: Prisma.InputJsonObject;
};

/** Records who did what. Details never carry a password or a secret. */
export async function audit(db: Db, entry: AuditEntry): Promise<void> {
  await db.auditEvent.create({
    data: {
      organizationId: entry.organizationId ?? null,
      actorUserId: entry.actorUserId ?? null,
      action: entry.action,
      subjectType: entry.subjectType,
      subjectId: entry.subjectId ?? null,
      detailJson: entry.detail ?? {},
    },
  });
}
