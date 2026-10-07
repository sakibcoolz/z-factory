import "server-only";
import { z } from "zod";
import { type Actor, isUuid, requireMembership } from "@/lib/auth/actor";
import { hashPassword, passwordProblem, verifyPassword } from "@/lib/auth/password";
import { ROLES, type Role } from "@/lib/auth/roles";
import type { Db } from "@/lib/db/client";
import { DomainError } from "@/lib/domain/errors";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { audit } from "./audit-service";

/**
 * Users, sign-in and memberships. A failed sign-in never says whether the e-mail exists;
 * five failures in a row lock the account for fifteen minutes. Disabling a user, changing
 * their role or password raises their session version: their open sessions end.
 */

export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;

const email = z.string().trim().toLowerCase().email("Enter a valid e-mail address.").max(254);
const personName = z.string().trim().min(1, "Enter a name.").max(120);

function checkPassword(password: string) {
  const problem = passwordProblem(password);
  if (problem) throw new DomainError("VALIDATION", problem, { field: "password" });
}

export type SignedIn = { userId: string; email: string; name: string; sessionVersion: number };

/** Checks an e-mail and password; null for any failure, with the reason recorded only in the audit log. */
export async function authenticate(
  db: PrismaClient,
  rawEmail: unknown,
  password: unknown,
  now = new Date(),
): Promise<SignedIn | null> {
  const parsed = email.safeParse(rawEmail);
  if (!parsed.success || typeof password !== "string" || password.length > 256) return null;
  const user = await db.user.findUnique({ where: { email: parsed.data } });
  // Hash anyway, so that an unknown e-mail takes as long as a wrong password.
  const valid = await verifyPassword(password, user?.passwordHash ?? "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA");
  if (!user) return null;
  const record = (action: string, detail: Record<string, string | number> = {}) =>
    audit(db, { actorUserId: user.id, action, subjectType: "USER", subjectId: user.id, detail });
  if (user.status !== "ACTIVE") {
    await record("SIGN_IN_REFUSED", { reason: "disabled" });
    return null;
  }
  if (user.lockedUntil && user.lockedUntil > now) {
    await record("SIGN_IN_REFUSED", { reason: "locked" });
    return null;
  }
  if (!valid) {
    const failures = user.failedLogins + 1;
    const lock = failures >= MAX_FAILED_LOGINS;
    await db.user.update({
      where: { id: user.id },
      data: {
        failedLogins: lock ? 0 : failures,
        lockedUntil: lock ? new Date(now.getTime() + LOCK_MINUTES * 60_000) : user.lockedUntil,
      },
    });
    await record(lock ? "ACCOUNT_LOCKED" : "SIGN_IN_FAILED", { failures });
    return null;
  }
  await db.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: now } });
  await record("SIGNED_IN");
  return { userId: user.id, email: user.email, name: user.name, sessionVersion: user.sessionVersion };
}

/** The actor behind a session, if the session is still valid: the user is active and nothing revoked it. */
export async function actorForSession(db: Db, userId: unknown, sessionVersion: unknown): Promise<Actor | null> {
  if (typeof userId !== "string" || !isUuid(userId) || typeof sessionVersion !== "number") return null;
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user || user.status !== "ACTIVE" || user.sessionVersion !== sessionVersion) return null;
  return { userId: user.id, email: user.email, name: user.name };
}

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, "Use lower-case letters, digits and dashes.");

/** The first organization and its admin; for the bootstrap script, refused once any user exists. */
export async function bootstrapAdmin(
  db: PrismaClient,
  input: { organization: string; slug: string; email: string; name: string; password: string },
) {
  checkPassword(input.password);
  const data = {
    organization: personName.parse(input.organization),
    slug: slug.parse(input.slug),
    email: email.parse(input.email),
    name: personName.parse(input.name),
  };
  return db.$transaction(async (tx) => {
    if ((await tx.user.count()) > 0) {
      throw new DomainError("CONFLICT", "Users exist already; add more from the Users screen.", {
        rule: "bootstrap-done",
      });
    }
    const organization = await tx.organization.create({ data: { name: data.organization, slug: data.slug } });
    const user = await tx.user.create({
      data: { email: data.email, name: data.name, passwordHash: await hashPassword(input.password) },
    });
    await tx.membership.create({ data: { organizationId: organization.id, userId: user.id, role: "ADMIN" } });
    await audit(tx, {
      organizationId: organization.id,
      actorUserId: user.id,
      action: "BOOTSTRAPPED",
      subjectType: "ORGANIZATION",
      subjectId: organization.id,
    });
    return { organizationId: organization.id, userId: user.id };
  });
}

/** The organizations the actor belongs to, with their role in each. */
export async function listMyOrganizations(db: Db, actor: Actor) {
  const memberships = await db.membership.findMany({
    where: { userId: actor.userId },
    include: { organization: true },
    orderBy: { organization: { name: "asc" } },
  });
  return memberships.map((membership) => ({ ...membership.organization, role: membership.role }));
}

export async function listMembers(db: Db, actor: Actor, organizationId: string) {
  await requireMembership(db, actor, organizationId, "manageUsers");
  const members = await db.membership.findMany({
    where: { organizationId },
    include: { user: true },
    orderBy: { user: { email: "asc" } },
  });
  return members.map((member) => ({
    userId: member.userId,
    email: member.user.email,
    name: member.user.name,
    role: member.role,
    status: member.user.status,
    lastLoginAt: member.user.lastLoginAt,
    locked: Boolean(member.user.lockedUntil && member.user.lockedUntil > new Date()),
  }));
}

const roleSchema = z.enum(ROLES);

const newUserSchema = z.strictObject({
  email,
  name: personName,
  role: roleSchema,
  password: z.string(),
});

/** Adds a user to the organization (an existing user by e-mail gets a membership). */
export async function addMember(db: PrismaClient, actor: Actor, organizationId: string, input: unknown) {
  await requireMembership(db, actor, organizationId, "manageUsers");
  const parsed = newUserSchema.safeParse(input);
  if (!parsed.success) throw new DomainError("VALIDATION", parsed.error.issues[0]?.message ?? "Invalid input.");
  const data = parsed.data;
  return db.$transaction(async (tx) => {
    let user = await tx.user.findUnique({ where: { email: data.email } });
    if (!user) {
      checkPassword(data.password);
      user = await tx.user.create({
        data: { email: data.email, name: data.name, passwordHash: await hashPassword(data.password) },
      });
    }
    const existing = await tx.membership.findUnique({
      where: { organizationId_userId: { organizationId, userId: user.id } },
    });
    if (existing) throw new DomainError("CONFLICT", `${data.email} is a member already.`, { rule: "member-exists" });
    await tx.membership.create({ data: { organizationId, userId: user.id, role: data.role } });
    await audit(tx, {
      organizationId,
      actorUserId: actor.userId,
      action: "MEMBER_ADDED",
      subjectType: "USER",
      subjectId: user.id,
      detail: { email: data.email, role: data.role },
    });
    return { userId: user.id };
  });
}

/** Admins of the organization other than the given user. */
async function otherAdmins(db: Db, organizationId: string, userId: string) {
  return db.membership.count({
    where: { organizationId, role: "ADMIN", userId: { not: userId }, user: { status: "ACTIVE" } },
  });
}

export async function setMemberRole(
  db: PrismaClient,
  actor: Actor,
  organizationId: string,
  userId: string,
  role: unknown,
) {
  await requireMembership(db, actor, organizationId, "manageUsers");
  const next = roleSchema.parse(role) as Role;
  return db.$transaction(async (tx) => {
    const membership = isUuid(userId)
      ? await tx.membership.findUnique({ where: { organizationId_userId: { organizationId, userId } } })
      : null;
    if (!membership) throw new DomainError("NOT_FOUND", "The user is not a member.");
    if (membership.role === "ADMIN" && next !== "ADMIN" && (await otherAdmins(tx, organizationId, userId)) === 0) {
      throw new DomainError("CONFLICT", "An organization keeps at least one admin.", { rule: "last-admin" });
    }
    await tx.membership.update({ where: { id: membership.id }, data: { role: next } });
    // A narrower role takes effect now, not at the next sign-in.
    await tx.user.update({ where: { id: userId }, data: { sessionVersion: { increment: 1 } } });
    await audit(tx, {
      organizationId,
      actorUserId: actor.userId,
      action: "ROLE_CHANGED",
      subjectType: "USER",
      subjectId: userId,
      detail: { from: membership.role, to: next },
    });
  });
}

/** Disables or enables a member's account; disabling ends their sessions. */
export async function setMemberActive(
  db: PrismaClient,
  actor: Actor,
  organizationId: string,
  userId: string,
  active: boolean,
) {
  await requireMembership(db, actor, organizationId, "manageUsers");
  if (userId === actor.userId && !active) {
    throw new DomainError("CONFLICT", "You cannot disable your own account.", { rule: "self-disable" });
  }
  return db.$transaction(async (tx) => {
    const membership = isUuid(userId)
      ? await tx.membership.findUnique({ where: { organizationId_userId: { organizationId, userId } } })
      : null;
    if (!membership) throw new DomainError("NOT_FOUND", "The user is not a member.");
    if (!active && membership.role === "ADMIN" && (await otherAdmins(tx, organizationId, userId)) === 0) {
      throw new DomainError("CONFLICT", "An organization keeps at least one admin.", { rule: "last-admin" });
    }
    await tx.user.update({
      where: { id: userId },
      data: {
        status: active ? "ACTIVE" : "DISABLED",
        sessionVersion: { increment: 1 },
        failedLogins: 0,
        lockedUntil: null,
      },
    });
    await audit(tx, {
      organizationId,
      actorUserId: actor.userId,
      action: active ? "USER_ENABLED" : "USER_DISABLED",
      subjectType: "USER",
      subjectId: userId,
    });
  });
}

/** Changes the actor's own password; every other session of theirs ends. */
export async function changeOwnPassword(db: PrismaClient, actor: Actor, current: unknown, next: unknown) {
  if (typeof current !== "string" || typeof next !== "string")
    throw new DomainError("VALIDATION", "Enter both passwords.");
  checkPassword(next);
  const user = await db.user.findUnique({ where: { id: actor.userId } });
  if (!user || !(await verifyPassword(current, user.passwordHash))) {
    throw new DomainError("VALIDATION", "The current password is not right.", { field: "current" });
  }
  const updated = await db.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(next), sessionVersion: { increment: 1 } },
  });
  await audit(db, { actorUserId: user.id, action: "PASSWORD_CHANGED", subjectType: "USER", subjectId: user.id });
  return { sessionVersion: updated.sessionVersion };
}
