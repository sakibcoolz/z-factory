import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PROCESS_SIM_CONTRACT_VERSION, PROCESS_SIM_MODELS } from "@/lib/domain/process-sim";
import { DomainError } from "@/lib/domain/errors";
import { parseServerEnv } from "@/lib/env";
import { createProcessSimClient } from "@/lib/runtimes/process-sim/client";

const json = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("the process simulation client", () => {
  it("sends the token to the service and nothing else, and maps its refusals to domain errors", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const answers = [
      json(200, { status: "ok", version: "test", contractVersion: 1, uptimeS: 1, instances: 0, modelTypes: ["TANK"] }),
      json(422, { error: "parameter volume must be greater than zero", code: "invalid-configuration" }),
      json(409, { error: "the instance is LOADED, not RUNNING", code: "wrong-state" }),
      json(404, { error: "instance not found", code: "not-found" }),
      json(401, { error: "a bearer token is required", code: "unauthorized" }),
      json(204, undefined),
    ];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return answers.shift() ?? json(500, { error: "x", code: "internal" });
    });
    const client = createProcessSimClient({
      url: "http://sim.local:7700/",
      token: "secret-token-0123456789",
      fetch: fetcher,
    });

    expect((await client.health()).modelTypes).toEqual(["TANK"]);
    expect(calls[0]?.url).toBe("http://sim.local:7700/healthz");
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token-0123456789");

    const codes = async (action: Promise<unknown>) =>
      action.then(
        () => "ok",
        (error: unknown) => (error instanceof DomainError ? `${error.code}:${error.details.rule}` : String(error)),
      );
    expect(
      await codes(
        client.load({
          contractVersion: PROCESS_SIM_CONTRACT_VERSION,
          instanceId: "t",
          factoryId: "f",
          moduleType: "TANK",
          ...PROCESS_SIM_MODELS.TANK!,
          configVersion: 1,
          tickMs: 100,
          clock: "manual",
          parameters: { volume: 0 },
        }),
      ),
    ).toBe("VALIDATION:process-sim-configuration");
    expect(await codes(client.step("t", 3))).toBe("CONFLICT:process-sim-state");
    expect(await codes(client.inspect("t"))).toBe("NOT_FOUND:process-sim");
    expect(await codes(client.start("t"))).toBe("RUNTIME_FAILURE:process-sim-token");
    expect(await client.unload("t")).toBeUndefined();
    expect(calls.map((call) => `${call.init.method} ${new URL(call.url).pathname}${new URL(call.url).search}`)).toEqual(
      [
        "GET /healthz",
        "PUT /v1/instances/t",
        "POST /v1/instances/t/step?ticks=3",
        "GET /v1/instances/t",
        "POST /v1/instances/t/start",
        "DELETE /v1/instances/t",
      ],
    );
  });

  it("sets, clears and lists overrides on the instance's measured values", async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    const state = { signal: "LEVEL", mode: "MANUAL_OVERRIDE", effective: 97 };
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return String(url).endsWith("/overrides") ? json(200, { signals: [state] }) : json(200, state);
    });
    const client = createProcessSimClient({
      url: "http://sim.local:7700",
      token: "secret-token-0123456789",
      fetch: fetcher,
    });
    await client.setOverride("m 1", "LEVEL", { mode: "MANUAL_OVERRIDE", value: 97, source: "alice" });
    await client.clearOverride("m 1", "LEVEL", "alice");
    expect(await client.overrides("m 1")).toEqual([state]);
    expect(calls).toEqual([
      {
        url: "http://sim.local:7700/v1/instances/m%201/overrides/LEVEL",
        method: "PUT",
        body: { mode: "MANUAL_OVERRIDE", value: 97, source: "alice" },
      },
      {
        url: "http://sim.local:7700/v1/instances/m%201/overrides/LEVEL?source=alice",
        method: "DELETE",
        body: undefined,
      },
      { url: "http://sim.local:7700/v1/instances/m%201/overrides", method: "GET", body: undefined },
    ]);
  });

  it("reaches the catalog device runtime under /v1/factories and keeps the rule a refusal names", async () => {
    const calls: Array<{ method?: string; path: string; body?: unknown }> = [];
    const answers = [
      json(200, { profiles: [{ key: "VFD" }] }),
      json(200, { factoryId: "f 1", status: "LOADED", devices: [] }),
      json(200, { factoryId: "f 1", status: "RUNNING", devices: [] }),
      json(200, { deviceId: "vfd", outputs: { running: 1 } }),
      json(422, {
        error: "invalid configuration: VFD-01: flow is not an input of profile VFD",
        code: "invalid-configuration",
        rule: "input-signal",
      }),
      json(409, { error: "Dry running is already active on P-01", code: "wrong-state", rule: "fault-active" }),
      json(200, { deviceId: "pt", forced: 7 }),
      json(200, { factoryId: "f 1", deviceCount: 3 }),
      json(204, undefined),
    ];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url));
      calls.push({
        method: init?.method,
        path: `${parsed.pathname}${parsed.search}`,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return answers.shift() ?? json(500, { error: "x", code: "internal" });
    });
    const client = createProcessSimClient({
      url: "http://sim.local:7700",
      token: "secret-token-0123456789",
      fetch: fetcher,
    });
    const rule = (action: Promise<unknown>) =>
      action.then(
        () => "ok",
        (error: unknown) => (error instanceof DomainError ? `${error.code}:${error.details.rule}` : String(error)),
      );

    expect((await client.devices.profiles()).map((profile) => profile.key)).toEqual(["VFD"]);
    await client.devices.load({
      contractVersion: 1,
      factoryId: "f 1",
      configVersion: 1,
      tickMs: 100,
      clock: "manual",
      devices: [],
    });
    await client.devices.step("f 1", 5);
    expect((await client.devices.device("f 1", "vfd")).outputs).toEqual({ running: 1 });
    expect(await rule(client.devices.setInputs("f 1", "vfd", { flow: 1 }))).toBe("VALIDATION:input-signal");
    expect(await rule(client.devices.injectFault("f 1", "p", "DRY_RUN"))).toBe("CONFLICT:fault-active");
    expect((await client.devices.force("f 1", "pt", 7)).forced).toBe(7);
    expect((await client.devices.removeDevice("f 1", "xv")).deviceCount).toBe(3);
    await client.devices.unload("f 1");
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /v1/profiles",
      "PUT /v1/factories/f%201",
      "POST /v1/factories/f%201/step?ticks=5",
      "GET /v1/factories/f%201/devices/vfd",
      "PUT /v1/factories/f%201/devices/vfd/inputs",
      "POST /v1/factories/f%201/devices/p/faults/DRY_RUN",
      "PUT /v1/factories/f%201/devices/pt/force",
      "DELETE /v1/factories/f%201/devices/xv",
      "DELETE /v1/factories/f%201",
    ]);
    expect(calls[6]?.body).toEqual({ value: 7 });
  });

  it("says when the service cannot be reached", async () => {
    const client = createProcessSimClient({
      url: "http://127.0.0.1:1",
      token: "secret-token-0123456789",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(client.list()).rejects.toMatchObject({
      code: "RUNTIME_FAILURE",
      details: { rule: "process-sim-unreachable" },
    });
  });
});

describe("where the service may be reached from", () => {
  const sources = (directory: string): string[] =>
    readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) return name === "generated" || name === "node_modules" ? [] : sources(path);
      return /\.(ts|tsx|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  const imports = (path: string) =>
    [...readFileSync(path, "utf8").matchAll(/from\s+"([^"]+)"|import\("([^"]+)"\)/g)].map(
      (match) => match[1] ?? match[2] ?? "",
    );

  it("is server code only: no page, route, action or component imports the client", () => {
    const users = [...sources("app"), ...sources("components"), ...sources("lib")].filter((path) =>
      imports(path).some((specifier) => /runtimes\/process-sim\/client$/.test(specifier)),
    );
    // Nothing uses it yet; the bridge of TASK-603 will, from a service.
    expect(users.every((path) => path.startsWith("lib/services/") || path.startsWith("lib/runtimes/"))).toBe(true);
    for (const path of [...sources("app"), ...sources("components")]) {
      expect(readFileSync(path, "utf8"), path).not.toMatch(/PROCESS_SIM_TOKEN|NEXT_PUBLIC_PROCESS_SIM/);
    }
  });

  it("is optional and never configured for a browser", () => {
    const base = { DATABASE_URL: "postgresql://u:p@localhost:5432/db" };
    expect(parseServerEnv(base).PROCESS_SIM_URL).toBeUndefined();
    expect(
      parseServerEnv({ ...base, PROCESS_SIM_URL: "http://127.0.0.1:7700", PROCESS_SIM_TOKEN: "x".repeat(16) }),
    ).toMatchObject({
      PROCESS_SIM_URL: "http://127.0.0.1:7700",
    });
    expect(() => parseServerEnv({ ...base, PROCESS_SIM_URL: "ftp://x" })).toThrow("PROCESS_SIM_URL");
    expect(() => parseServerEnv({ ...base, PROCESS_SIM_TOKEN: "short" })).toThrow("PROCESS_SIM_TOKEN");
    expect(readFileSync(".env.example", "utf8")).toMatch(/^# PROCESS_SIM_TOKEN=$/m);
  });
});
