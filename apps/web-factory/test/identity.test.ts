import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/auth/actor";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { createSite, listSites } from "@/lib/services/site-service";
import {
  actorForSession,
  addMember,
  authenticate,
  bootstrapAdmin,
  changeOwnPassword,
  listMembers,
  LOCK_MINUTES,
  setMemberActive,
  setMemberRole,
} from "@/lib/services/user-service";
import { openTestDb, resetDb, withDb } from "./harness";

const describeDb = withDb ? describe : describe.skip;
const PASSWORD = "a long admin password";

describeDb("identity, sign-in and roles (TASK-901)", () => {
  let db: PrismaClient;
  let organizationId: string;
  let admin: Actor;

  const actorOf = async (email: string, password: string): Promise<Actor> => {
    const signedIn = await authenticate(db, email, password);
    if (!signedIn) throw new Error(`${email} cannot sign in`);
    const actor = await actorForSession(db, signedIn.userId, signedIn.sessionVersion);
    if (!actor) throw new Error("no actor");
    return actor;
  };

  beforeAll(async () => {
    db = openTestDb();
    await resetDb(db);
    ({ organizationId } = await bootstrapAdmin(db, {
      organization: "Acme Water",
      slug: "acme-water",
      email: "Admin@Acme.example",
      name: "Ada Admin",
      password: PASSWORD,
    }));
    admin = await actorOf("admin@acme.example", PASSWORD);
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("bootstraps once, and stores e-mail lower-cased and the password hashed", async () => {
    await expect(
      bootstrapAdmin(db, { organization: "Again", slug: "again", email: "x@y.example", name: "X", password: PASSWORD }),
    ).rejects.toMatchObject({ details: { rule: "bootstrap-done" } });
    const user = await db.user.findUniqueOrThrow({ where: { email: "admin@acme.example" } });
    expect(user.passwordHash).toMatch(/^scrypt\$/);
    expect(user.passwordHash).not.toContain(PASSWORD);
  });

  it("refuses a wrong password or an unknown e-mail alike, and locks after five failures", async () => {
    expect(await authenticate(db, "admin@acme.example", "wrong password!!")).toBeNull();
    expect(await authenticate(db, "nobody@acme.example", PASSWORD)).toBeNull();
    for (let i = 0; i < 4; i += 1) await authenticate(db, "admin@acme.example", "wrong password!!");
    // Locked now: even the right password is refused until the lock ends.
    expect(await authenticate(db, "admin@acme.example", PASSWORD)).toBeNull();
    const later = new Date(Date.now() + (LOCK_MINUTES + 1) * 60_000);
    expect(await authenticate(db, "admin@acme.example", PASSWORD, later)).not.toBeNull();
    const actions = (await db.auditEvent.findMany({ orderBy: { at: "asc" } })).map((event) => event.action);
    expect(actions).toEqual(
      expect.arrayContaining(["SIGN_IN_FAILED", "ACCOUNT_LOCKED", "SIGN_IN_REFUSED", "SIGNED_IN"]),
    );
  });

  it("lets an admin add users with roles; a viewer only looks", async () => {
    await addMember(db, admin, organizationId, {
      email: "vera@acme.example",
      name: "Vera Viewer",
      role: "VIEWER",
      password: "viewer password 1",
    });
    await addMember(db, admin, organizationId, {
      email: "otto@acme.example",
      name: "Otto Operator",
      role: "OPERATOR",
      password: "operator password",
    });
    await expect(
      addMember(db, admin, organizationId, {
        email: "short@acme.example",
        name: "S",
        role: "VIEWER",
        password: "short",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      addMember(db, admin, organizationId, {
        email: "vera@acme.example",
        name: "Vera",
        role: "ADMIN",
        password: "whatever password",
      }),
    ).rejects.toMatchObject({ details: { rule: "member-exists" } });

    const viewer = await actorOf("vera@acme.example", "viewer password 1");
    expect((await listSites(db, viewer, organizationId)).role).toBe("VIEWER");
    await expect(createSite(db, viewer, organizationId, { siteKey: "plant-1", name: "Plant 1" })).rejects.toMatchObject(
      { code: "FORBIDDEN" },
    );
    await expect(listMembers(db, viewer, organizationId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const operator = await actorOf("otto@acme.example", "operator password");
    await expect(
      createSite(db, operator, organizationId, { siteKey: "plant-1", name: "Plant 1" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await listMembers(db, admin, organizationId)).map((m) => [m.email, m.role])).toEqual([
      ["admin@acme.example", "ADMIN"],
      ["otto@acme.example", "OPERATOR"],
      ["vera@acme.example", "VIEWER"],
    ]);
  });

  it("keeps organizations apart: another tenant's data does not exist", async () => {
    const other = await db.organization.create({ data: { name: "Other", slug: "other" } });
    await expect(listSites(db, admin, other.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(listSites(db, admin, "not-a-uuid")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("ends sessions when a role changes, a user is disabled or a password changes", async () => {
    const vera = await authenticate(db, "vera@acme.example", "viewer password 1");
    expect(await actorForSession(db, vera?.userId, vera?.sessionVersion)).not.toBeNull();
    await setMemberRole(db, admin, organizationId, vera!.userId, "OPERATOR");
    expect(await actorForSession(db, vera?.userId, vera?.sessionVersion)).toBeNull();

    const again = await authenticate(db, "vera@acme.example", "viewer password 1");
    await setMemberActive(db, admin, organizationId, again!.userId, false);
    expect(await actorForSession(db, again?.userId, again?.sessionVersion)).toBeNull();
    expect(await authenticate(db, "vera@acme.example", "viewer password 1")).toBeNull();
    await setMemberActive(db, admin, organizationId, again!.userId, true);

    const otto = await actorOf("otto@acme.example", "operator password");
    await expect(changeOwnPassword(db, otto, "not it at all", "a new operator password")).rejects.toMatchObject({
      code: "VALIDATION",
    });
    const before = await authenticate(db, "otto@acme.example", "operator password");
    await changeOwnPassword(db, otto, "operator password", "a new operator password");
    expect(await actorForSession(db, before?.userId, before?.sessionVersion)).toBeNull();
    expect(await authenticate(db, "otto@acme.example", "a new operator password")).not.toBeNull();
    // Forged or malformed sessions are nobody.
    expect(await actorForSession(db, "not-a-uuid", 0)).toBeNull();
    expect(await actorForSession(db, before?.userId, undefined)).toBeNull();
  });

  it("always keeps an admin", async () => {
    await expect(setMemberRole(db, admin, organizationId, admin.userId, "VIEWER")).rejects.toMatchObject({
      details: { rule: "last-admin" },
    });
    await expect(setMemberActive(db, admin, organizationId, admin.userId, false)).rejects.toMatchObject({
      details: { rule: "self-disable" },
    });
  });
});
