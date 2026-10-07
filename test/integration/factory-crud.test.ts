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
// Deleting through the action removes the factory's Docker resources; recorded here, run for real in docker-runtime.
const dockerCleanup = vi.hoisted(() => ({
  removeFactoryResources: vi.fn(async () => ({ containers: [] as string[], networks: [] as string[] })),
}));
vi.mock("@/lib/docker/factory-resources", () => dockerCleanup);
// The actions check subnets against the Docker host; these are the host's networks here.
const dockerHost = vi.hoisted(() => ({
  networks: [] as Array<{ name: string; subnets: string[]; labels: Record<string, string> }>,
}));
vi.mock("@/lib/docker/networks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/docker/networks")>()),
  listHostNetworks: vi.fn(async () => dockerHost.networks),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  },
}));

/** A factory with nothing in Docker. */
const noResources = async () => ({ containers: [], networks: [] });
/** A Docker host with these networks, and one that cannot be reached. */
const hostWith =
  (...networks: Array<{ name: string; subnets: string[]; labels?: Record<string, string> }>) =>
  async () =>
    networks.map((network) => ({ labels: {}, ...network }));
const unreachableHost = async (): Promise<never> => {
  throw new DomainError("RUNTIME_FAILURE", "The Docker Engine is not reachable.");
};

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
    dockerHost.networks = [];
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
    await expectDomainError(deleteFactory(db, bob, mine.id, noResources), "NOT_FOUND");
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

    const asked: string[] = [];
    const remover = async (factoryId: string) => {
      asked.push(factoryId);
      return { containers: ["zf-plc-01"], networks: [`zfactory_${factoryId}`] };
    };
    await db.factory.update({ where: { id: created.id }, data: { runtimeStatus: "RUNNING" } });
    await expectDomainError(deleteFactory(db, alice, created.id, remover), "CONFLICT", "delete-requires-stopped");
    // A running factory's runtimes are never touched.
    expect(asked).toEqual([]);

    await db.factory.update({ where: { id: created.id }, data: { runtimeStatus: "STOPPED" } });
    // Its Docker resources go first, then its record (TASK-206).
    expect(await deleteFactory(db, alice, created.id, remover)).toEqual({
      containers: ["zf-plc-01"],
      networks: [`zfactory_${created.id}`],
    });
    expect(asked).toEqual([created.id]);
    expect(await db.factory.count()).toBe(0);
    expect(await db.deviceInstance.count()).toBe(0);
    expect(await db.deviceModel.count()).toBe(1);
  });

  it("keeps a factory whose Docker resources cannot be removed, and says why (TASK-206)", async () => {
    const created = await createFactory(db, alice, input());
    const model = await createGenericModel(db, "VFD", "Generic VFD");
    await createDeviceInstance(db, { factoryId: created.id, deviceModelId: model.id, name: "VFD-01" });
    const unreachable = async () => {
      throw new DomainError("RUNTIME_FAILURE", "The Docker Engine is not reachable.", { action: "list containers" });
    };
    const error = await deleteFactory(db, alice, created.id, unreachable).then(
      () => undefined,
      (reason: unknown) => reason as DomainError,
    );
    expect(error).toBeInstanceOf(DomainError);
    expect(error?.code).toBe("RUNTIME_FAILURE");
    expect(error?.message).toContain("The factory was not deleted");
    expect(error?.details.rule).toBe("delete-runtime-cleanup");
    // Nothing was deleted: the record still finds its containers and network later.
    expect(await db.factory.count()).toBe(1);
    expect(await db.deviceInstance.count()).toBe(1);
  });

  it("suggests a subnet no factory on the host uses", async () => {
    expect(await suggestFactorySubnet(db)).toBe("172.20.1.0/24");
    await createFactory(db, bob, input());
    expect(await suggestFactorySubnet(db)).toBe("172.20.2.0/24");
  });

  it("refuses a subnet that is free in the database but taken on the Docker host (TASK-207)", async () => {
    const orphan = hostWith({ name: "zfactory_deleted", subnets: ["172.20.1.0/24"] });
    await expectDomainError(createFactory(db, alice, input(), orphan), "CONFLICT", "docker-subnet-overlap");
    // Any overlap counts, whoever made the network.
    await expectDomainError(
      createFactory(db, alice, input(), hostWith({ name: "other-project", subnets: ["172.20.0.0/16"] })),
      "CONFLICT",
      "docker-subnet-overlap",
    );
    expect(await db.factory.count()).toBe(0);

    expect((await createFactory(db, alice, input({ subnetCidr: "172.20.2.0/24" }), orphan)).subnetCidr).toBe(
      "172.20.2.0/24",
    );
    // A clash with another factory is still named as such.
    await expectDomainError(
      createFactory(db, alice, input({ slug: "other", subnetCidr: "172.20.2.0/24" }), orphan),
      "CONFLICT",
      "subnet-overlap",
    );
  });

  it("checks a changed subnet against the Docker host, except the factory's own network (TASK-207)", async () => {
    const created = await createFactory(db, alice, input());
    const host = hostWith(
      {
        name: created.dockerNetworkName,
        subnets: ["172.20.1.0/24"],
        labels: { "zfactory.managed": "true", "zfactory.factory-id": created.id },
      },
      { name: "zfactory_deleted", subnets: ["172.20.5.0/24"] },
    );

    await expectDomainError(
      updateFactory(db, alice, created.id, input({ subnetCidr: "172.20.5.0/24" }), host),
      "CONFLICT",
      "docker-subnet-overlap",
    );
    // Its own network is not a clash: moving within it is allowed.
    expect((await updateFactory(db, alice, created.id, input({ subnetCidr: "172.20.1.0/25" }), host)).subnetCidr).toBe(
      "172.20.1.0/25",
    );
    // Docker is asked only when the subnet changes.
    expect(
      (
        await updateFactory(
          db,
          alice,
          created.id,
          input({ name: "Renamed", subnetCidr: "172.20.1.0/25" }),
          unreachableHost,
        )
      ).name,
    ).toBe("Renamed");
  });

  it("says so when the Docker host cannot be asked, instead of passing the subnet (TASK-207)", async () => {
    const error = await createFactory(db, alice, input(), unreachableHost).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("RUNTIME_FAILURE");
    expect((error as DomainError).details).toMatchObject({ rule: "subnet-check-unavailable", field: "subnetCidr" });
    expect((error as DomainError).message).toMatch(
      /^The Docker Engine is not reachable\. The subnet could not be checked/,
    );
    expect(await db.factory.count()).toBe(0);

    const created = await createFactory(db, alice, input());
    await expectDomainError(
      updateFactory(db, alice, created.id, input({ subnetCidr: "172.20.2.0/24" }), unreachableHost),
      "RUNTIME_FAILURE",
      "subnet-check-unavailable",
    );
    expect((await getFactory(db, alice, created.id)).subnetCidr).toBe("172.20.1.0/24");
  });

  it("suggests a subnet free on the Docker host too, and falls back to the database without it (TASK-207)", async () => {
    const orphan = hostWith({ name: "zfactory_deleted", subnets: ["172.20.1.0/24", "172.20.2.0/23"] });
    expect(await suggestFactorySubnet(db, orphan)).toBe("172.20.4.0/24");
    expect(await suggestFactorySubnet(db, unreachableHost)).toBe("172.20.1.0/24");
  });

  it("create and update actions check the Docker host and show the clash on the subnet field (TASK-207)", async () => {
    dockerHost.networks = [{ name: "zfactory_deleted", subnets: ["172.20.1.0/24"], labels: {} }];
    const state = await createFactoryAction(emptyState, form(input()));
    expect(state.fieldErrors.subnetCidr).toBe("This subnet overlaps a network that already exists on the Docker host.");
    expect(await db.factory.count()).toBe(0);

    const created = await createFactory(db, alice, input({ subnetCidr: "172.20.2.0/24" }));
    const updateState = await updateFactoryAction(created.id, emptyState, form(input({ subnetCidr: "172.20.1.0/24" })));
    expect(updateState.fieldErrors.subnetCidr).toBe(
      "This subnet overlaps a network that already exists on the Docker host.",
    );
    expect((await getFactory(db, alice, created.id)).subnetCidr).toBe("172.20.2.0/24");
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
    expect(dockerCleanup.removeFactoryResources).toHaveBeenLastCalledWith(expect.anything(), created.id);
    expect(await db.factory.count()).toBe(0);
  });
});
