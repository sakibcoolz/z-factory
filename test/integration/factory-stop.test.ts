// @vitest-environment node
import { randomUUID } from "node:crypto";
import type Docker from "dockerode";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDockerClient } from "@/lib/docker/client";
import { createRuntimeContainer, startRuntimeContainer } from "@/lib/docker/containers";
import { removeFactoryResources } from "@/lib/docker/factory-resources";
import { ensureFactoryNetwork } from "@/lib/docker/networks";
import { DEFAULT_LIMITS, type RuntimePolicy } from "@/lib/docker/policy";
import { RUNTIME_IMAGES } from "@/lib/docker/runtime-images";
import { DomainError } from "@/lib/domain/errors";
import { EventBus } from "@/lib/events/bus";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { DeviceSimulatorRuntime } from "@/lib/runtimes/device-sim/runtime";
import { GatewayEndpointRuntime } from "@/lib/runtimes/gateway-endpoint/runtime";
import { TagMonitorRuntime } from "@/lib/runtimes/tag-monitor/monitor";
import { createDeviceInstance } from "@/lib/services/device-service";
import { type FactoryRuntimeDeps, startFactory, stopFactory } from "@/lib/services/factory-runtime-service";
import { createFactory, deleteFactory, updateFactory } from "@/lib/services/factory-service";
import { cidrsOverlap } from "@/lib/validation/network";
import { createGenericModel, describeDb, openTestDb, resetDb } from "./harness";

/**
 * "Stop factory" after a start that failed (TASK-208): every PLC is brought to rest from
 * its real container state (none, exited or running), the factory ends STOPPED, and it
 * can then be edited and deleted without a per-PLC workaround.
 */
const RUN_LABEL = "zfactory.test-run";
const runId = randomUUID();
const alice = { ownerId: "alice" };

function factoryRuntimeDeps(db: PrismaClient, docker: Docker, policy: RuntimePolicy): FactoryRuntimeDeps {
  const bus = new EventBus();
  const simulator = new DeviceSimulatorRuntime();
  const runtime = { db, docker, bus, policy, runtimeSecret: "integration-test-runtime-secret-0123456789" };
  return {
    runtime,
    simulation: { db, bus, simulator, tickMs: 50, snapshotIntervalMs: 2000 },
    live: {
      db,
      bus,
      simulator,
      monitor: new TagMonitorRuntime(),
      pollMs: 200,
      sampling: { minIntervalMs: 200, maxIntervalMs: 60_000, deadbandRatio: 0.01 },
    },
    gateway: { ...runtime, endpoints: new GatewayEndpointRuntime() },
  };
}

const policyFor = (images: RuntimePolicy["images"]): RuntimePolicy => ({
  images,
  portRange: { min: 15_400, max: 15_499 },
  bindAddresses: ["127.0.0.1"],
  limits: DEFAULT_LIMITS,
  labels: { [RUN_LABEL]: runId },
});

async function rejection(action: Promise<unknown>): Promise<DomainError> {
  const error = await action.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(DomainError);
  return error as DomainError;
}

describeDb("stopping a factory whose start failed (TASK-208)", () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = openTestDb();
  });
  beforeEach(async () => {
    await resetDb(db);
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  async function factoryWithPlcs(names: string[], subnetCidr = "10.231.1.0/28") {
    const factory = await createFactory(db, alice, { name: "Pump House", slug: "pump-house", subnetCidr });
    const model = await createGenericModel(db, "PLC", "Generic compact PLC", { architectureType: "COMPACT" });
    const plcs = [];
    for (const name of names) {
      plcs.push((await createDeviceInstance(db, { factoryId: factory.id, deviceModelId: model.id, name })).id);
    }
    return { factoryId: factory.id, plcs };
  }
  const stored = async (factoryId: string) => ({
    factory: (await db.factory.findUniqueOrThrow({ where: { id: factoryId } })).runtimeStatus,
    plcs: (await db.deviceInstance.findMany({ where: { factoryId }, orderBy: { name: "asc" } })).map(
      (device) => device.runtimeStatus,
    ),
  });

  it("ends STOPPED when the start failed before any container existed, then edits and deletes", async () => {
    // No engine behind this client: the start fails before a container is created.
    const deps = factoryRuntimeDeps(
      db,
      createDockerClient("unix:///nonexistent/docker.sock"),
      policyFor(RUNTIME_IMAGES),
    );
    const { factoryId, plcs } = await factoryWithPlcs(["PLC-01"]);

    expect((await rejection(startFactory(deps, alice, factoryId))).code).toBe("RUNTIME_FAILURE");
    expect(await stored(factoryId)).toEqual({ factory: "DEGRADED", plcs: ["FAULTED"] });
    // What the bug left: edit and delete refused.
    expect(
      (await rejection(updateFactory(db, alice, factoryId, { name: "Pump House", subnetCidr: "10.231.2.0/28" })))
        .details.rule,
    ).toBe("subnet-change-requires-stopped");

    // Stop needs no engine for a PLC that has no container, and reports what it stores.
    const result = await stopFactory(deps, alice, factoryId);
    expect(result.plcs).toEqual([{ id: plcs[0], name: "PLC-01", state: "STOPPED" }]);
    expect(await stored(factoryId)).toEqual({ factory: "STOPPED", plcs: ["STOPPED"] });
    const [stopEvent] = await db.runtimeEvent.findMany({ where: { deviceId: plcs[0], type: "DEVICE_STOPPED" } });
    expect(stopEvent?.payloadJson).toMatchObject({ reconciled: true, from: "FAULTED" });

    expect(
      (await updateFactory(db, alice, factoryId, { name: "Pump House", subnetCidr: "10.231.2.0/28" })).subnetCidr,
    ).toBe("10.231.2.0/28");
    await deleteFactory(db, alice, factoryId, async () => ({ containers: [], networks: [] }));
    expect(await db.factory.count()).toBe(0);
  });

  it("stores the factory's summary again even when every PLC was already stopped", async () => {
    const deps = factoryRuntimeDeps(
      db,
      createDockerClient("unix:///nonexistent/docker.sock"),
      policyFor(RUNTIME_IMAGES),
    );
    const { factoryId } = await factoryWithPlcs(["PLC-01", "PLC-02"]);
    // A summary left behind by an earlier failure, with nothing running.
    await db.factory.update({ where: { id: factoryId }, data: { runtimeStatus: "DEGRADED" } });

    await stopFactory(deps, alice, factoryId);
    expect(await stored(factoryId)).toEqual({ factory: "STOPPED", plcs: ["STOPPED", "STOPPED"] });
    expect(await db.runtimeEvent.count({ where: { factoryId, type: "DEVICE_STOPPED" } })).toBe(0);
  });
});

const describeRuntime =
  process.env.TEST_DOCKER === "1" && Boolean(process.env.TEST_DATABASE_URL) ? describe : describe.skip;

describeRuntime("stopping a factory against a real Docker Engine (TASK-208)", () => {
  let db: PrismaClient;
  let docker: Docker;

  async function freeSubnet(): Promise<string> {
    const used = (await docker.listNetworks()).flatMap((network) =>
      (network.IPAM?.Config ?? []).map((config) => config.Subnet ?? "").filter((subnet) => subnet.includes(".")),
    );
    for (let third = 100; third < 160; third += 1) {
      const candidate = `10.213.${third}.0/28`;
      if (!used.some((subnet) => cidrsOverlap(candidate, subnet))) return candidate;
    }
    throw new Error("no free test subnet");
  }

  beforeAll(async () => {
    db = openTestDb();
    await resetDb(db);
    docker = createDockerClient(process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock");
  });
  afterAll(async () => {
    const filters = { label: [`${RUN_LABEL}=${runId}`] };
    for (const container of await docker.listContainers({ all: true, filters })) {
      await docker.getContainer(container.Id).remove({ force: true, v: true });
    }
    for (const network of await docker.listNetworks({ filters })) {
      await docker.getNetwork(network.Id).remove();
    }
    await db.$disconnect();
  }, 60_000);

  it("recovers from a start the host refused, as seen in the browser, then edits and deletes", async () => {
    const deps = factoryRuntimeDeps(db, docker, policyFor(RUNTIME_IMAGES));
    // A network outside Z-Factory holds the subnet: the factory network cannot be made.
    const taken = await freeSubnet();
    await docker.createNetwork({
      Name: `zf-test-stray-${runId.slice(0, 8)}`,
      Driver: "bridge",
      IPAM: { Config: [{ Subnet: taken }] },
      Labels: { [RUN_LABEL]: runId },
    });
    const factory = await createFactory(db, alice, { name: "Refused", slug: "refused", subnetCidr: taken });
    const model = await createGenericModel(db, "PLC", "Generic compact PLC A", { architectureType: "COMPACT" });
    await createDeviceInstance(db, { factoryId: factory.id, deviceModelId: model.id, name: "PLC-01" });

    expect((await rejection(startFactory(deps, alice, factory.id))).details.rule).toBe("docker-subnet-overlap");
    expect((await db.factory.findUniqueOrThrow({ where: { id: factory.id } })).runtimeStatus).toBe("DEGRADED");

    await stopFactory(deps, alice, factory.id);
    expect((await db.factory.findUniqueOrThrow({ where: { id: factory.id } })).runtimeStatus).toBe("STOPPED");
    await updateFactory(db, alice, factory.id, { name: "Refused", subnetCidr: await freeSubnet() });
    expect(await deleteFactory(db, alice, factory.id, (id) => removeFactoryResources(docker, id))).toEqual({
      containers: [],
      networks: [],
    });
  }, 60_000);

  it("stops a container that still runs, and settles one that already exited, from any stored state", async () => {
    const testImages: RuntimePolicy["images"] = [
      {
        key: "test-runtime",
        reference: "busybox:1.37",
        command: ["sleep", "600"],
        publishablePorts: [],
        allowedEnv: [],
      },
    ];
    const deps = factoryRuntimeDeps(db, docker, policyFor(testImages));
    const factory = await createFactory(db, alice, { name: "Mixed", slug: "mixed", subnetCidr: await freeSubnet() });
    const model = await createGenericModel(db, "PLC", "Generic compact PLC B", { architectureType: "COMPACT" });
    const runningPlc = await createDeviceInstance(db, {
      factoryId: factory.id,
      deviceModelId: model.id,
      name: "PLC-01",
    });
    const exitedPlc = await createDeviceInstance(db, {
      factoryId: factory.id,
      deviceModelId: model.id,
      name: "PLC-02",
    });

    const container = async (deviceId: string, name: string) =>
      (
        await createRuntimeContainer(
          docker,
          {
            factoryId: factory.id,
            deviceId,
            networkName: factory.dockerNetworkName,
            serviceName: name,
            image: "test-runtime",
            ports: [],
            limits: { cpus: 0.25, memoryMb: 32 },
          },
          deps.runtime.policy,
        )
      ).containerId;
    await ensureFactoryNetwork(
      docker,
      { factoryId: factory.id, name: factory.dockerNetworkName, subnetCidr: factory.subnetCidr },
      deps.runtime.policy,
    );
    const running = await container(runningPlc.id, "plc-01");
    await startRuntimeContainer(docker, running);
    // Created and never started: an exited container, as one that crashed or was stopped outside Z-Factory.
    const exited = await container(exitedPlc.id, "plc-02");
    // Stored states that do not match: a running PLC recorded as degraded, an exited one as faulted.
    await db.deviceInstance.update({
      where: { id: runningPlc.id },
      data: { dockerContainerId: running, runtimeStatus: "DEGRADED" },
    });
    await db.deviceInstance.update({
      where: { id: exitedPlc.id },
      data: { dockerContainerId: exited, runtimeStatus: "FAULTED" },
    });
    await db.factory.update({ where: { id: factory.id }, data: { runtimeStatus: "DEGRADED" } });

    const result = await stopFactory(deps, alice, factory.id);
    expect(result.plcs.map((plc) => plc.state)).toEqual(["STOPPED", "STOPPED"]);
    expect((await docker.getContainer(running).inspect()).State.Running).toBe(false);
    expect((await db.factory.findUniqueOrThrow({ where: { id: factory.id } })).runtimeStatus).toBe("STOPPED");
    expect(
      (await db.deviceInstance.findMany({ where: { factoryId: factory.id } })).map((device) => device.runtimeStatus),
    ).toEqual(["STOPPED", "STOPPED"]);

    // A container removed outside Z-Factory is nothing to stop either.
    await db.deviceInstance.update({ where: { id: exitedPlc.id }, data: { runtimeStatus: "FAULTED" } });
    await docker.getContainer(exited).remove({ force: true });
    await stopFactory(deps, alice, factory.id);
    expect((await db.factory.findUniqueOrThrow({ where: { id: factory.id } })).runtimeStatus).toBe("STOPPED");
  }, 120_000);
});
