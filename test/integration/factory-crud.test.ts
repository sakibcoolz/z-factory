// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createFactoryAction, deleteFactoryAction, updateFactoryAction } from "@/app/factories/actions";
import { withDomainErrors } from "@/lib/db/errors";
import { DomainError, type DomainErrorCode } from "@/lib/domain/errors";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { createDeviceInstance } from "@/lib/services/device-service";
import {
  createFactory,
  deleteFactory,
  getFactory,
  listFactories,
  suggestFactorySubnet,
  updateFactory,
} from "@/lib/services/factory-service";
import { createGenericModel, describeDb, openTestDb, resetDb } from "./harness";

const testDb = vi.hoisted(() => ({ current: undefined as unknown }));
const actorMock = vi.hoisted(() => ({ requireActor: vi.fn() }));

// Server actions resolve their own database and actor; point both at the test fixtures.
vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  getDb: () => testDb.current,
}));
vi.mock("@/lib/auth/actor", () => actorMock);
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  },
}));

const alice = { ownerId: "alice" };
const bob = { ownerId: "bob" };

async function expectDomainError(action: Promise<unknown>, code: DomainErrorCode, ruleOrConstraint?: string) {
  const error = await action.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe(code);
  if (ruleOrConstraint) {
    const { rule, constraint } = (error as DomainError).details;
    expect(rule ?? constraint).toBe(ruleOrConstraint);
  }
}

const input = (overrides: Record<string, string> = {}) => ({
  name: "Pump House",
  slug: "pump-house",
  description: "Booster station",
  subnetCidr: "172.20.1.0/24",
  ...overrides,
});

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

const emptyState = { fieldErrors: {}, values: { name: "", slug: "", description: "", subnetCidr: "" } };

describeDb("factory CRUD against PostgreSQL", () => {
  let db: PrismaClient;

  beforeAll(() => {
    db = openTestDb();
    testDb.current = db;
  });
  beforeEach(async () => {
    await resetDb(db);
    actorMock.requireActor.mockReset().mockResolvedValue(alice);
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("creates a factory as stopped draft configuration with a deterministic network name", async () => {
    const created = await createFactory(db, alice, input());

    expect(created).toMatchObject({
      name: "Pump House",
      slug: "pump-house",
      description: "Booster station",
      status: "DRAFT",
      runtimeStatus: "STOPPED",
      subnetCidr: "172.20.1.0/24",
      dockerNetworkName: `zfactory_${created.id}`,
      deviceCount: 0,
      plcCount: 0,
    });
    expect(created.lastEvent?.type).toBe("FACTORY_CREATED");
    expect(await db.runtimeEvent.count({ where: { factoryId: created.id, type: "FACTORY_CREATED" } })).toBe(1);
  });

  it("validates name, slug and subnet before writing", async () => {
    await expectDomainError(createFactory(db, alice, input({ name: "   " })), "VALIDATION");
    await expectDomainError(createFactory(db, alice, input({ slug: "Bad Slug" })), "VALIDATION");
    await expectDomainError(createFactory(db, alice, input({ subnetCidr: "8.8.8.0/24" })), "VALIDATION");
    await expectDomainError(createFactory(db, alice, input({ subnetCidr: "172.20.1.7/24" })), "VALIDATION");
    await expectDomainError(createFactory(db, alice, { name: "No subnet", slug: "no-subnet" }), "VALIDATION");
    expect(await db.factory.count()).toBe(0);
  });

  it("rejects duplicate slugs, duplicate names per owner and overlapping subnets", async () => {
    await createFactory(db, alice, input());

    await expectDomainError(
      createFactory(db, alice, input({ name: "Other", subnetCidr: "172.20.2.0/24" })),
      "CONFLICT",
      "Factory_slug_key",
    );
    await expectDomainError(
      createFactory(db, alice, input({ slug: "other", subnetCidr: "172.20.2.0/24" })),
      "CONFLICT",
      "Factory_ownerId_name_key",
    );
    // A wider subnet that contains an existing one collides on the Docker host, even for another owner.
    await expectDomainError(
      createFactory(db, bob, input({ slug: "bobs", subnetCidr: "172.20.0.0/16" })),
      "CONFLICT",
      "subnet-overlap",
    );
    expect(await db.factory.count()).toBe(1);
  });

  it("holds the subnet rule in the database when the service is bypassed", async () => {
    const first = await createFactory(db, alice, input());

    await expectDomainError(
      withDomainErrors(() =>
        db.factory.create({
          data: {
            ownerId: "bob",
            name: "Bypass",
            slug: "bypass",
            subnetCidr: "172.20.1.128/25",
            dockerNetworkName: "zfactory_bypass",
          },
        }),
      ),
      "CONFLICT",
      "Factory_subnet_no_overlap",
    );
    expect(first.subnetCidr).toBe("172.20.1.0/24");
  });

  it("lists and reads only the actor's own factories", async () => {
    const mine = await createFactory(db, alice, input());
    await createFactory(db, bob, input({ slug: "bobs", subnetCidr: "172.20.2.0/24" }));

    expect((await listFactories(db, alice)).map((factory) => factory.id)).toEqual([mine.id]);
    expect((await getFactory(db, alice, mine.id)).name).toBe("Pump House");
    await expectDomainError(getFactory(db, bob, mine.id), "NOT_FOUND");
    await expectDomainError(updateFactory(db, bob, mine.id, input({ name: "Hijacked" })), "NOT_FOUND");
    await expectDomainError(deleteFactory(db, bob, mine.id), "NOT_FOUND");
    expect((await getFactory(db, alice, mine.id)).name).toBe("Pump House");
  });

  it("updates configuration without touching slug or runtime state", async () => {
    const created = await createFactory(db, alice, input());
    await db.factory.update({ where: { id: created.id }, data: { runtimeStatus: "RUNNING" } });

    const updated = await updateFactory(db, alice, created.id, {
      name: "Pump House East",
      slug: "ignored-new-slug",
      description: "",
      subnetCidr: created.subnetCidr,
    });

    expect(updated).toMatchObject({
      name: "Pump House East",
      slug: "pump-house",
      description: null,
      runtimeStatus: "RUNNING",
      dockerNetworkName: created.dockerNetworkName,
    });
  });

  it("changes the subnet only while stopped and only to a free range", async () => {
    const created = await createFactory(db, alice, input());
    await createFactory(db, alice, input({ name: "Second", slug: "second", subnetCidr: "172.20.2.0/24" }));

    await expectDomainError(
      updateFactory(db, alice, created.id, input({ subnetCidr: "172.20.2.0/24" })),
      "CONFLICT",
      "subnet-overlap",
    );
    expect((await updateFactory(db, alice, created.id, input({ subnetCidr: "172.20.9.0/24" }))).subnetCidr).toBe(
      "172.20.9.0/24",
    );

    await db.factory.update({ where: { id: created.id }, data: { runtimeStatus: "RUNNING" } });
    await expectDomainError(
      updateFactory(db, alice, created.id, input({ subnetCidr: "172.20.10.0/24" })),
      "CONFLICT",
      "subnet-change-requires-stopped",
    );
  });

  it("deletes a stopped factory with its devices and refuses a running one", async () => {
    const created = await createFactory(db, alice, input());
    const model = await createGenericModel(db, "VFD", "Generic VFD");
    await createDeviceInstance(db, { factoryId: created.id, deviceModelId: model.id, name: "VFD-01" });
    expect((await getFactory(db, alice, created.id)).deviceCount).toBe(1);

    await db.factory.update({ where: { id: created.id }, data: { runtimeStatus: "RUNNING" } });
    await expectDomainError(deleteFactory(db, alice, created.id), "CONFLICT", "delete-requires-stopped");

    await db.factory.update({ where: { id: created.id }, data: { runtimeStatus: "STOPPED" } });
    await deleteFactory(db, alice, created.id);
    expect(await db.factory.count()).toBe(0);
    expect(await db.deviceInstance.count()).toBe(0);
    expect(await db.deviceModel.count()).toBe(1);
  });

  it("suggests a subnet no factory on the host uses", async () => {
    expect(await suggestFactorySubnet(db)).toBe("172.20.1.0/24");
    await createFactory(db, bob, input());
    expect(await suggestFactorySubnet(db)).toBe("172.20.2.0/24");
  });

  it("create action: persists for the actor and redirects to the new factory", async () => {
    await expect(createFactoryAction(emptyState, form(input()))).rejects.toThrow(
      /^NEXT_REDIRECT \/factories\/[0-9a-f-]{36}$/,
    );

    const [stored] = await db.factory.findMany();
    expect(stored).toMatchObject({ ownerId: "alice", name: "Pump House", runtimeStatus: "STOPPED" });
  });

  it("create action: returns field errors and the entered values without writing", async () => {
    const state = await createFactoryAction(emptyState, form(input({ subnetCidr: "8.8.8.0/24", slug: "Bad Slug" })));

    expect(state.fieldErrors.subnetCidr).toMatch(/private range/);
    expect(state.fieldErrors.slug).toMatch(/lowercase/);
    expect(state.values.subnetCidr).toBe("8.8.8.0/24");
    expect(await db.factory.count()).toBe(0);
  });

  it("actions stop at the authorization boundary", async () => {
    const created = await createFactory(db, alice, input());
    actorMock.requireActor.mockRejectedValue(new DomainError("UNAUTHORIZED", "No owner is configured."));

    const createState = await createFactoryAction(emptyState, form(input({ slug: "second", name: "Second" })));
    expect(createState.message).toBe("No owner is configured.");
    const updateState = await updateFactoryAction(created.id, emptyState, form(input({ name: "Changed" })));
    expect(updateState.message).toBe("No owner is configured.");
    expect((await deleteFactoryAction(created.id, {})).message).toBe("No owner is configured.");

    expect(await db.factory.count()).toBe(1);
    expect((await getFactory(db, alice, created.id)).name).toBe("Pump House");
  });

  it("update and delete actions act only on the actor's factory", async () => {
    const created = await createFactory(db, alice, input());

    actorMock.requireActor.mockResolvedValue(bob);
    expect((await updateFactoryAction(created.id, emptyState, form(input({ name: "Hijacked" })))).message).toBe(
      "The factory does not exist.",
    );
    expect((await deleteFactoryAction(created.id, {})).message).toBe("The factory does not exist.");

    actorMock.requireActor.mockResolvedValue(alice);
    await expect(updateFactoryAction(created.id, emptyState, form(input({ name: "Renamed" })))).rejects.toThrow(
      `NEXT_REDIRECT /factories/${created.id}`,
    );
    expect((await getFactory(db, alice, created.id)).name).toBe("Renamed");
    await expect(deleteFactoryAction(created.id, {})).rejects.toThrow("NEXT_REDIRECT /factories");
    expect(await db.factory.count()).toBe(0);
  });
});
