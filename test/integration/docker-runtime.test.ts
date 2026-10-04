// @vitest-environment node
import { randomUUID } from "node:crypto";
import type Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDockerClient } from "@/lib/docker/client";
import {
  createRuntimeContainer,
  inspectRuntimeContainer,
  removeRuntimeContainer,
  restartRuntimeContainer,
  startRuntimeContainer,
  stopRuntimeContainer,
} from "@/lib/docker/containers";
import { ensureFactoryNetwork, removeFactoryNetwork } from "@/lib/docker/networks";
import { DEFAULT_LIMITS, type RuntimePolicy } from "@/lib/docker/policy";
import { DomainError, type DomainErrorCode } from "@/lib/domain/errors";
import { cidrsOverlap } from "@/lib/validation/network";

/**
 * Lifecycle tests against a real Docker Engine. They run only when TEST_DOCKER=1 and
 * touch only resources labelled with this run's id, which are removed afterwards.
 */
const describeDocker = process.env.TEST_DOCKER === "1" ? describe : describe.skip;

const RUN_LABEL = "zfactory.test-run";
const runId = randomUUID();
const factoryId = randomUUID();
const deviceId = randomUUID();
const networkName = `zfactory_test_${runId.slice(0, 8)}`;
const HOST_PORT = 15931;

const policy: RuntimePolicy = {
  images: [
    {
      key: "test-runtime",
      reference: "busybox:1.37",
      command: ["sleep", "600"],
      publishablePorts: [5020],
      allowedEnv: ["PLC_NAME"],
    },
  ],
  portRange: { min: 15900, max: 15999 },
  bindAddresses: ["127.0.0.1"],
  limits: DEFAULT_LIMITS,
  labels: { [RUN_LABEL]: runId },
};

async function expectDomainError(action: Promise<unknown>, code: DomainErrorCode, rule?: string) {
  const error = await action.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe(code);
  if (rule) expect((error as DomainError).details.rule).toBe(rule);
}

/** A private /28 that no existing Docker network overlaps. */
async function freeSubnet(docker: Docker): Promise<string> {
  const used = (await docker.listNetworks()).flatMap((network) =>
    (network.IPAM?.Config ?? []).map((config) => config.Subnet).filter((subnet): subnet is string => Boolean(subnet)),
  );
  for (let third = 200; third < 255; third += 1) {
    const candidate = `10.213.${third}.0/28`;
    if (!used.some((subnet) => /^\d/.test(subnet) && !subnet.includes(":") && cidrsOverlap(candidate, subnet))) {
      return candidate;
    }
  }
  throw new Error("no free test subnet");
}

describeDocker("docker runtime lifecycle against a real engine", () => {
  let docker: Docker;
  let subnetCidr: string;
  let containerId: string;
  const networkRequest = () => ({ factoryId, name: networkName, subnetCidr });
  const containerRequest = (overrides: Record<string, unknown> = {}) => ({
    factoryId,
    deviceId,
    networkName,
    serviceName: "plc-01",
    image: "test-runtime",
    env: { PLC_NAME: "PLC-01" },
    ports: [{ containerPort: 5020, hostPort: HOST_PORT }],
    limits: { cpus: 0.5, memoryMb: 64 },
    ...overrides,
  });

  beforeAll(async () => {
    docker = createDockerClient(process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock");
    subnetCidr = await freeSubnet(docker);
  }, 60_000);

  afterAll(async () => {
    const filters = { label: [`${RUN_LABEL}=${runId}`] };
    for (const container of await docker.listContainers({ all: true, filters })) {
      await docker.getContainer(container.Id).remove({ force: true, v: true });
    }
    for (const network of await docker.listNetworks({ filters })) {
      await docker.getNetwork(network.Id).remove();
    }
  }, 60_000);

  it("creates the factory network once and recognises it afterwards", async () => {
    expect(await ensureFactoryNetwork(docker, networkRequest(), policy)).toEqual({ name: networkName, created: true });
    expect(await ensureFactoryNetwork(docker, networkRequest(), policy)).toEqual({ name: networkName, created: false });

    const details = await docker.getNetwork(networkName).inspect();
    expect(details.Driver).toBe("bridge");
    expect(details.IPAM?.Config?.[0]?.Subnet).toBe(subnetCidr);
    expect(details.Labels).toMatchObject({ "zfactory.managed": "true", "zfactory.factory-id": factoryId });
  });

  it("refuses a second network on an overlapping subnet or a reused name", async () => {
    await expectDomainError(
      ensureFactoryNetwork(docker, { factoryId: randomUUID(), name: `${networkName}_b`, subnetCidr }, policy),
      "CONFLICT",
      "docker-subnet-overlap",
    );
    await expectDomainError(
      ensureFactoryNetwork(docker, { factoryId: randomUUID(), name: networkName, subnetCidr }, policy),
      "CONFLICT",
      "network-name-taken",
    );
  });

  it("requires the factory network before creating a container", async () => {
    await expectDomainError(
      createRuntimeContainer(docker, containerRequest({ networkName: `${networkName}_missing` }), policy),
      "NOT_FOUND",
      "network-required",
    );
  });

  it("creates a hardened, limited container from the allow-listed image", async () => {
    const created = await createRuntimeContainer(docker, containerRequest(), policy);
    containerId = created.containerId;
    expect(created.name).toBe(`zf-${factoryId}-plc-01`);
    expect(created.imageId).toMatch(/^sha256:/);

    const details = await docker.getContainer(containerId).inspect();
    expect(details.HostConfig.Privileged).toBe(false);
    expect(details.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(details.HostConfig.SecurityOpt).toEqual(["no-new-privileges"]);
    expect(details.HostConfig.NetworkMode).toBe(networkName);
    expect(details.HostConfig.Memory).toBe(64 * 1024 * 1024);
    expect(details.HostConfig.NanoCpus).toBe(500_000_000);
    expect(details.HostConfig.PidsLimit).toBe(DEFAULT_LIMITS.pidsLimit);
    expect(details.Mounts).toEqual([]);
    expect(details.Config.Cmd).toEqual(["sleep", "600"]);
    expect(details.Config.Env).toContain("PLC_NAME=PLC-01");

    const status = await inspectRuntimeContainer(docker, containerId);
    expect(status).toMatchObject({
      state: "STOPPED",
      running: false,
      factoryId,
      deviceId,
      ports: [{ containerPort: 5020, hostPort: HOST_PORT, bindAddress: "127.0.0.1" }],
      limits: { cpus: 0.5, memoryMb: 64, pidsLimit: DEFAULT_LIMITS.pidsLimit },
    });
  }, 120_000);

  it("rejects a host port another container already claims, before asking Docker", async () => {
    await expectDomainError(
      createRuntimeContainer(docker, containerRequest({ serviceName: "plc-02", deviceId: randomUUID() }), policy),
      "CONFLICT",
      "host-port-taken",
    );
    expect(await docker.listContainers({ all: true, filters: { label: [`${RUN_LABEL}=${runId}`] } })).toHaveLength(1);
  });

  it("starts, restarts and stops the container", async () => {
    await startRuntimeContainer(docker, containerId);
    const running = await inspectRuntimeContainer(docker, containerId);
    expect(running.state).toBe("RUNNING");
    expect(running.startedAt).not.toBeNull();

    // The service name resolves inside the factory network and the port is published on localhost only.
    const details = await docker.getContainer(containerId).inspect();
    expect(details.NetworkSettings.Networks[networkName]?.Aliases).toContain("plc-01");
    expect(details.NetworkSettings.Ports["5020/tcp"]).toEqual([{ HostIp: "127.0.0.1", HostPort: String(HOST_PORT) }]);

    await startRuntimeContainer(docker, containerId);
    await restartRuntimeContainer(docker, containerId, 1);
    expect((await inspectRuntimeContainer(docker, containerId)).state).toBe("RUNNING");

    await stopRuntimeContainer(docker, containerId, 1);
    const stopped = await inspectRuntimeContainer(docker, containerId);
    expect(stopped.running).toBe(false);
    // `sleep` is killed by the stop signal, which Docker reports as a non-zero exit.
    expect(["STOPPED", "FAULTED"]).toContain(stopped.state);
  }, 120_000);

  it("keeps the network while a container is attached, then removes both", async () => {
    await startRuntimeContainer(docker, containerId);
    await expectDomainError(removeFactoryNetwork(docker, networkName), "CONFLICT", "network-in-use");

    expect(await removeRuntimeContainer(docker, containerId)).toBe(true);
    expect(await removeRuntimeContainer(docker, containerId)).toBe(false);
    expect(await removeFactoryNetwork(docker, networkName)).toBe(true);
    expect(await removeFactoryNetwork(docker, networkName)).toBe(false);
  }, 120_000);

  it("never touches containers or networks it does not manage", async () => {
    const foreign = await docker.createContainer({
      Image: "busybox:1.37",
      Cmd: ["sleep", "600"],
      Labels: { [RUN_LABEL]: runId },
    });
    const foreignNetwork = await docker.createNetwork({
      Name: `foreign_${runId.slice(0, 8)}`,
      Labels: { [RUN_LABEL]: runId },
    });

    await expectDomainError(startRuntimeContainer(docker, foreign.id), "INVARIANT", "managed-only");
    await expectDomainError(stopRuntimeContainer(docker, foreign.id), "INVARIANT", "managed-only");
    await expectDomainError(removeRuntimeContainer(docker, foreign.id), "INVARIANT", "managed-only");
    await expectDomainError(inspectRuntimeContainer(docker, foreign.id), "INVARIANT", "managed-only");
    await expectDomainError(removeFactoryNetwork(docker, foreignNetwork.id), "INVARIANT", "managed-only");

    expect((await foreign.inspect()).State.Status).toBe("created");
  }, 120_000);
});
