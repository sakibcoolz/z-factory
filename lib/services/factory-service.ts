import "server-only";
import { randomUUID } from "node:crypto";
import type { Actor } from "@/lib/auth/actor";
import { factoryRepository } from "@/lib/db/repositories/factory-repository";
import { assertSubnetAvailable, type ExistingNetwork } from "@/lib/docker/networks";
import { isManaged, LABEL_FACTORY_ID } from "@/lib/docker/labels";
import { DomainError, isDomainError } from "@/lib/domain/errors";
import type { RuntimeState } from "@/lib/domain/runtime-state";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { assertSubnetFree, suggestSubnet } from "@/lib/validation/network";
import { parseInput } from "@/lib/validation/parse";
import { factoryInputSchema, factoryUpdateSchema } from "@/lib/validation/schemas";

/**
 * Factory configuration CRUD. These operations change desired configuration only: they
 * never create networks or start containers (that is the runtime lifecycle of Phase 02),
 * and they never write `runtimeStatus`.
 */

/** Plain, serializable view of a factory for pages and client components. */
export type FactoryView = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: "DRAFT" | "ACTIVE" | "ARCHIVED";
  /** Last persisted runtime state; the runtime layer is the live authority. */
  runtimeStatus: RuntimeState;
  dockerNetworkName: string;
  subnetCidr: string;
  deviceCount: number;
  plcCount: number;
  lastEvent: { type: string; occurredAt: string } | null;
  createdAt: string;
  updatedAt: string;
};

type FactoryWithSummary = NonNullable<Awaited<ReturnType<typeof factoryRepository.findWithSummary>>>;

function toView(factory: FactoryWithSummary): FactoryView {
  const [lastEvent] = factory.events;
  return {
    id: factory.id,
    name: factory.name,
    slug: factory.slug,
    description: factory.description,
    status: factory.status,
    runtimeStatus: factory.runtimeStatus,
    dockerNetworkName: factory.dockerNetworkName,
    subnetCidr: factory.subnetCidr,
    deviceCount: factory.devices.length,
    plcCount: factory.devices.filter((device) => device.plcProfile !== null).length,
    lastEvent: lastEvent ? { type: lastEvent.type, occurredAt: lastEvent.occurredAt.toISOString() } : null,
    createdAt: factory.createdAt.toISOString(),
    updatedAt: factory.updatedAt.toISOString(),
  };
}

const notFound = () => new DomainError("NOT_FOUND", "The factory does not exist.");

/** Deterministic Docker network name (docs/architecture.md → Factory isolation). */
export function dockerNetworkNameFor(factoryId: string): string {
  return `zfactory_${factoryId}`;
}

export async function listFactories(db: PrismaClient, actor: Actor): Promise<FactoryView[]> {
  const factories = await factoryRepository.listWithSummary(db, actor.ownerId);
  return factories.map(toView);
}

export async function getFactory(db: PrismaClient, actor: Actor, factoryId: string): Promise<FactoryView> {
  const factory = await factoryRepository.findWithSummary(db, actor.ownerId, factoryId);
  if (!factory) throw notFound();
  return toView(factory);
}

/** Lists the networks on the Docker host; `listHostNetworks` with the server's client in the app. */
export type HostNetworkReader = () => Promise<ExistingNetwork[]>;

/**
 * The Docker networks a factory's subnet must not overlap (TASK-207): every network on
 * the host except the factory's own. If Docker cannot be asked, the subnet cannot be
 * checked, and saying so is better than passing it to fail at start.
 */
async function hostNetworksFor(read: HostNetworkReader, factoryId?: string): Promise<ExistingNetwork[]> {
  let networks: ExistingNetwork[];
  try {
    networks = await read();
  } catch (error) {
    if (!isDomainError(error)) throw error;
    throw new DomainError(
      error.code,
      `${error.message} The subnet could not be checked against the networks on the Docker host, so the factory was not saved.`,
      { ...error.details, rule: "subnet-check-unavailable", field: "subnetCidr" },
    );
  }
  return networks.filter((network) => !(isManaged(network.labels) && network.labels[LABEL_FACTORY_ID] === factoryId));
}

/**
 * Default subnet offered on the create form: the first /24 that no factory and, when
 * Docker can be asked, no network on the host uses. If Docker cannot be asked, the offer
 * is made from the database alone, and saving the factory says why it cannot be checked.
 */
export async function suggestFactorySubnet(
  db: PrismaClient,
  hostNetworks?: HostNetworkReader,
): Promise<string | undefined> {
  const subnets = await factoryRepository.listSubnets(db);
  const host = hostNetworks ? await hostNetworks().catch(() => []) : [];
  return suggestSubnet([...subnets, ...host.flatMap((network) => network.subnets)]);
}

/**
 * `hostNetworks` checks the subnet against the Docker host as well as the other factories
 * (TASK-207). The app always passes it; tests and harnesses that run without Docker omit
 * it, and then only the database is checked.
 */
export async function createFactory(
  db: PrismaClient,
  actor: Actor,
  input: unknown,
  hostNetworks?: HostNetworkReader,
): Promise<FactoryView> {
  const data = parseInput(factoryInputSchema, input);
  const id = randomUUID();
  // Asked before the transaction, so no transaction waits on Docker.
  const host = hostNetworks ? await hostNetworksFor(hostNetworks) : [];

  return db.$transaction(async (transaction) => {
    assertSubnetFree(data.subnetCidr, await factoryRepository.listSubnets(transaction));
    assertSubnetAvailable(data.subnetCidr, host);
    await factoryRepository.create(transaction, {
      id,
      ownerId: actor.ownerId,
      name: data.name,
      slug: data.slug,
      description: data.description || undefined,
      subnetCidr: data.subnetCidr,
      dockerNetworkName: dockerNetworkNameFor(id),
    });
    await factoryRepository.recordEvent(transaction, {
      factoryId: id,
      type: "FACTORY_CREATED",
      payloadJson: { name: data.name, slug: data.slug },
    });
    const created = await factoryRepository.findWithSummary(transaction, actor.ownerId, id);
    if (!created) throw notFound();
    return toView(created);
  });
}

export async function updateFactory(
  db: PrismaClient,
  actor: Actor,
  factoryId: string,
  input: unknown,
  hostNetworks?: HostNetworkReader,
): Promise<FactoryView> {
  const data = parseInput(factoryUpdateSchema, input);
  // Docker is asked only when the subnet changes, and before the transaction.
  const before = await factoryRepository.findById(db, actor.ownerId, factoryId);
  const host =
    hostNetworks && before && data.subnetCidr !== before.subnetCidr
      ? await hostNetworksFor(hostNetworks, factoryId)
      : undefined;

  return db.$transaction(async (transaction) => {
    const current = await factoryRepository.findById(transaction, actor.ownerId, factoryId);
    if (!current) throw notFound();

    if (data.subnetCidr !== current.subnetCidr) {
      // The subnet belongs to a Docker network once the factory runs; change it only at rest.
      if (current.runtimeStatus !== "STOPPED") {
        throw new DomainError("CONFLICT", "Stop the factory before changing its subnet.", {
          rule: "subnet-change-requires-stopped",
          field: "subnetCidr",
        });
      }
      assertSubnetFree(data.subnetCidr, await factoryRepository.listSubnets(transaction, factoryId));
      if (hostNetworks)
        assertSubnetAvailable(data.subnetCidr, host ?? (await hostNetworksFor(hostNetworks, factoryId)));
    }

    await factoryRepository.update(transaction, actor.ownerId, factoryId, {
      name: data.name,
      description: data.description || null,
      subnetCidr: data.subnetCidr,
    });
    const updated = await factoryRepository.findWithSummary(transaction, actor.ownerId, factoryId);
    if (!updated) throw notFound();
    return toView(updated);
  });
}

/** Removes a factory's Docker resources; `lib/docker/factory-resources.ts` in the app. */
export type FactoryResourceRemover = (factoryId: string) => Promise<{ containers: string[]; networks: string[] }>;

/**
 * Deletes a stopped factory with everything it owns (TASK-206): first its Docker
 * resources (runtime containers and network), then its record. If Docker cannot be
 * reached or refuses, the factory is kept, so no container or network is left behind
 * without a record to find it by; deleting again later finishes the job.
 */
export async function deleteFactory(
  db: PrismaClient,
  actor: Actor,
  factoryId: string,
  removeResources: FactoryResourceRemover,
): Promise<{ containers: string[]; networks: string[] }> {
  const assertStopped = async (reader: Parameters<typeof factoryRepository.findById>[0]) => {
    const current = await factoryRepository.findById(reader, actor.ownerId, factoryId);
    if (!current) throw notFound();
    // A running factory owns containers and a network that are in use.
    if (current.runtimeStatus !== "STOPPED") {
      throw new DomainError("CONFLICT", "Stop the factory before deleting it.", { rule: "delete-requires-stopped" });
    }
  };

  await assertStopped(db);
  let removed;

  try {
    removed = await removeResources(factoryId);
  } catch (error) {
    if (error instanceof DomainError) {
      throw new DomainError(
        error.code,
        `${error.message} The factory was not deleted, so none of its containers or its network is left behind.`,
        { ...error.details, rule: error.details.rule ?? "delete-runtime-cleanup" },
      );
    }
    throw error;
  }
  await db.$transaction(async (transaction) => {
    await assertStopped(transaction);
    await factoryRepository.delete(transaction, actor.ownerId, factoryId);
  });

  return removed;
}
