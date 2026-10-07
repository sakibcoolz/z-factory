import "server-only";
import type { Db } from "@/lib/db/client";
import { DomainError } from "@/lib/domain/errors";
import { can, type Permission, type Role } from "./roles";

/** The signed-in user a request acts for; services take it, never read identity themselves. */
export type Actor = { userId: string; email: string; name: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string) => UUID.test(value);

/**
 * The actor's role in an organization, if it allows the permission. An organization the
 * actor is not a member of does not exist for them (NOT_FOUND, never FORBIDDEN), so ids of
 * other tenants cannot be probed.
 */
export async function requireMembership(
  db: Db,
  actor: Actor,
  organizationId: string,
  permission: Permission,
): Promise<{ organization: { id: string; name: string; slug: string }; role: Role }> {
  const membership = isUuid(organizationId)
    ? await db.membership.findUnique({
        where: { organizationId_userId: { organizationId, userId: actor.userId } },
        include: { organization: { select: { id: true, name: true, slug: true } } },
      })
    : null;
  if (!membership) throw new DomainError("NOT_FOUND", "The organization does not exist.");
  if (!can(membership.role, permission)) {
    throw new DomainError("FORBIDDEN", "Your role does not allow this.", { permission, role: membership.role });
  }
  return { organization: membership.organization, role: membership.role };
}
