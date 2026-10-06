// @vitest-environment node
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDockerClient } from "@/lib/docker/client";
import { DEFAULT_LIMITS } from "@/lib/docker/policy";
import { RUNTIME_IMAGES } from "@/lib/docker/runtime-images";
import type { DomainError } from "@/lib/domain/errors";
import { edgeDeploymentFileName, type EdgeDeploymentDocument } from "@/lib/domain/edge-deployment";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { createDeviceInstance } from "@/lib/services/device-service";
import { edgeChecksum, exportEdgeDeployment } from "@/lib/services/edge-deployment-service";
import { createFactory } from "@/lib/services/factory-service";
import { createProgramVersion, type RuntimeDeps, startPlc } from "@/lib/services/plc-runtime-service";
import { createTag, readTag, writeTag } from "@/lib/services/tag-service";
import { cidrsOverlap } from "@/lib/validation/network";
import { createGenericModel, openTestDb, resetDb } from "./harness";

/**
 * TASK-503a: Z-Factory exports a PLC's edge deployment, the Thin Client Agent runs from
 * it. The export rules need PostgreSQL (TEST_DATABASE_URL); the agent against a real
 * OpenPLC runtime needs TEST_DOCKER=1 and AGENT_BIN (the built `zfactory-agent`).
 */
const withDb = Boolean(process.env.TEST_DATABASE_URL);
const describeDb = withDb ? describe : describe.skip;
const binary = process.env.AGENT_BIN;
const withAgent = withDb && process.env.TEST_DOCKER === "1" && Boolean(binary);
const itAgent = withAgent ? it : it.skip;

const RUN_LABEL = "zfactory.test-run";
const runId = randomUUID();
const alice = { ownerId: "alice" };

const PROGRAM = `PROGRAM line
  VAR
    Start_Cmd AT %QX101.0 : BOOL;
    Speed_SP AT %QW101 : INT;
    Running AT %QX100.0 : BOOL;
    Speed_Ref AT %QW100 : INT;
    Run_Hours AT %MD10 : REAL;
  END_VAR
  Running := Start_Cmd;
  IF Running THEN
    Speed_Ref := Speed_SP;
  ELSE
    Speed_Ref := 0;
  END_IF;
  Run_Hours := 12.5;
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#50ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : line;
  END_RESOURCE
END_CONFIGURATION
`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function freeSubnet(docker: Docker): Promise<string> {
  const used = (await docker.listNetworks()).flatMap((network) =>
    (network.IPAM?.Config ?? []).map((config) => config.Subnet).filter((subnet): subnet is string => Boolean(subnet)),
  );
  for (let third = 41; third < 60; third += 1) {
    const candidate = `10.217.${third}.0/28`;
    if (!used.some((subnet) => !subnet.includes(":") && cidrsOverlap(candidate, subnet))) return candidate;
  }
  throw new Error("no free test subnet");
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port")),
      );
    });
  });
}

describeDb("the edge deployment of a PLC and the Thin Client Agent (TASK-503a)", () => {
  let db: PrismaClient;
  let docker: Docker | undefined;
  let runtime: RuntimeDeps;
  let plcId: string;
  let dir: string;
  let agent: ChildProcess | undefined;
  let healthPort = 0;

  beforeAll(async () => {
    db = openTestDb();
    await resetDb(db);
    dir = mkdtempSync(join(tmpdir(), "zfactory-agent-"));
    docker = withAgent ? createDockerClient(process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock") : undefined;
    runtime = {
      db,
      docker: docker ?? createDockerClient("unix:///nonexistent"),
      policy: {
        images: RUNTIME_IMAGES,
        portRange: { min: 15_960, max: 15_979 },
        bindAddresses: ["127.0.0.1"],
        limits: DEFAULT_LIMITS,
        labels: { [RUN_LABEL]: runId },
      },
      runtimeSecret: "integration-test-runtime-secret-0123456789",
    };
    const factory = await createFactory(db, alice, {
      name: "Edge Line",
      slug: "edge-line",
      subnetCidr: docker ? await freeSubnet(docker) : "10.217.40.0/28",
    });
    plcId = (
      await createDeviceInstance(db, {
        factoryId: factory.id,
        deviceModelId: (await createGenericModel(db, "PLC", "Generic PLC", { architectureType: "COMPACT" })).id,
        name: "PLC-01",
      })
    ).id;
    await createProgramVersion(db, alice, plcId, { sourceText: PROGRAM });
    for (const tag of [
      { name: "Start_Cmd", dataType: "BOOL", role: "COMMAND", logicalAddress: "%QX101.0" },
      { name: "Speed_SP", dataType: "INT16", scale: 0.1, unit: "Hz", role: "SETPOINT", logicalAddress: "%QW101" },
      { name: "Running", dataType: "BOOL", role: "STATUS", logicalAddress: "%QX100.0" },
      { name: "Speed_Ref", dataType: "INT16", scale: 0.1, unit: "Hz", role: "STATUS", logicalAddress: "%QW100" },
      { name: "Run_Hours", dataType: "FLOAT32", unit: "h", role: "PROCESS_VALUE", logicalAddress: "%MD10" },
    ]) {
      await createTag(db, alice, plcId, tag);
    }
  }, 120_000);

  afterAll(async () => {
    if (agent && agent.exitCode === null) {
      await new Promise<void>((resolve) => {
        agent?.once("exit", () => resolve());
        agent?.kill("SIGTERM");
      });
    }
    rmSync(dir, { recursive: true, force: true });
    if (docker) {
      const filters = { label: [`${RUN_LABEL}=${runId}`] };
      for (const container of await docker.listContainers({ all: true, filters })) {
        await docker.getContainer(container.Id).remove({ force: true, v: true });
      }
      for (const network of await docker.listNetworks({ filters })) {
        await docker.getNetwork(network.Id).remove();
      }
    }
    await db.$disconnect();
  }, 120_000);

  it("exports every tag for reading and only command and setpoint tags for writing, with a checksum", async () => {
    const refused = await exportEdgeDeployment(db, alice, plcId).then(
      () => undefined,
      (error: unknown) => error as DomainError,
    );
    // Before the runtime ever started there is no endpoint, unless one is given.
    expect(refused?.details.rule).toBe("edge-endpoint-required");

    const document = await exportEdgeDeployment(db, alice, plcId, { host: "10.0.0.15", port: 502, unitId: 1 });
    expect(document).toMatchObject({
      schema: "zfactory.edge-deployment",
      schemaVersion: 1,
      plcId,
      deployment: {
        plc: { plcId, name: "PLC-01" },
        connection: { protocol: "MODBUS_TCP", host: "10.0.0.15", port: 502, pollIntervalMs: 1000, timeoutMs: 2000 },
      },
    });
    expect(document.checksum).toBe(edgeChecksum(document.deployment));
    const access = Object.fromEntries(document.deployment.mappings.map((m) => [m.name, [m.access, m.authority]]));
    expect(access).toEqual({
      Run_Hours: ["READ", "PROGRAM_INTERNAL"],
      Running: ["READ", "PROGRAM_OUTPUT"],
      Speed_Ref: ["READ", "PROGRAM_OUTPUT"],
      Speed_SP: ["WRITE", "EXTERNAL_COMMAND"],
      Start_Cmd: ["WRITE", "EXTERNAL_COMMAND"],
    });
    const speed = document.deployment.mappings.find((m) => m.name === "Speed_SP");
    expect(speed).toMatchObject({ area: "HOLDING_REGISTER", dataType: "INT16", scale: 0.1, min: -3276.8 });
    // Nothing secret travels to the edge.
    expect(JSON.stringify(document)).not.toMatch(/secret|password|token/i);
    await expect(exportEdgeDeployment(db, alice, plcId, { host: "bad host; rm" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(exportEdgeDeployment(db, { ownerId: "mallory" }, plcId, { host: "x", port: 1 })).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );
    expect(edgeDeploymentFileName("PLC 01/A")).toBe("plc-plc-01-a.json");
  });

  itAgent(
    "runs from the exported file against a real OpenPLC runtime, reloads an update and rejects a changed file",
    async () => {
      expect(await startPlc(runtime, alice, plcId)).toEqual({ state: "RUNNING" });
      await writeTag(runtime, alice, plcId, "Speed_SP", 42.5);
      await writeTag(runtime, alice, plcId, "Start_Cmd", true);

      const deploy = (document: EdgeDeploymentDocument, text = `${JSON.stringify(document, null, 2)}\n`) => {
        const name = edgeDeploymentFileName(document.deployment.plc.name);
        writeFileSync(join(dir, "staging", `.${name}.tmp`), text);
        renameSync(join(dir, "staging", `.${name}.tmp`), join(dir, "staging", name));
      };
      healthPort = await freePort();
      agent = spawn(
        binary ?? "",
        ["-dir", dir, "-health", `127.0.0.1:${healthPort}`, "-scan", "200ms", "-settle", "0s"],
        {
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      agent.stdout?.resume();
      agent.stderr?.resume();
      const health = async (path: string) => {
        const response = await fetch(`http://127.0.0.1:${healthPort}${path}`).catch(() => undefined);
        return response?.ok ? ((await response.json()) as Record<string, unknown>) : undefined;
      };
      const until = async <T>(what: string, check: () => Promise<T | undefined>, timeoutMs = 20_000) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const result = await check();
          if (result !== undefined) return result;
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
          await sleep(200);
        }
      };
      await until("the agent", () => health("/healthz"));
      expect(await health("/healthz")).toMatchObject({ status: "ok", workers: 0 });
      expectAgentDirectories(dir);

      // The default endpoint is the runtime's published Modbus port, which the agent reaches from this host.
      const first = await exportEdgeDeployment(db, alice, plcId, { pollIntervalMs: 200 });
      deploy(first);
      type Plc = {
        state: string;
        configVersion: number;
        values: Array<{ name: string; value: unknown; quality: string }>;
      };
      const plc = await until("the PLC online with values", async () => {
        const body = (await health(`/v1/plcs/${plcId}`)) as Plc | undefined;
        return body?.state === "ONLINE" && body.values.every((value) => value.quality === "GOOD") ? body : undefined;
      });
      const values = Object.fromEntries(plc.values.map((value) => [value.name, value.value]));
      // What the agent reads is what Z-Factory reads.
      for (const name of ["Start_Cmd", "Speed_SP", "Running", "Speed_Ref", "Run_Hours"]) {
        expect(values[name], name).toEqual((await readTag(runtime, alice, plcId, name)).value);
      }
      expect(values).toMatchObject({ Running: true, Speed_Ref: 42.5, Run_Hours: 12.5 });
      expect(readdirSync(join(dir, "active"))).toEqual([edgeDeploymentFileName("PLC-01")]);

      // A file changed after export is refused; the running deployment stays.
      const tampered = JSON.parse(JSON.stringify(first)) as EdgeDeploymentDocument;
      tampered.configVersion += 5;
      tampered.deployment.mappings.find((m) => m.name === "Running")!.access = "WRITE";
      deploy(tampered);
      const rejected = await until("the rejection", async () => {
        const status = (await health("/v1/status")) as { files: { rejections: Array<{ rule: string }> } } | undefined;
        return status && status.files.rejections.length > 0 ? status.files.rejections : undefined;
      });
      expect(rejected[0]?.rule).toBe("checksum");

      // A new tag is a new configuration version: the agent reloads that PLC without a restart.
      await createTag(db, alice, plcId, {
        name: "Spare_Word",
        dataType: "UINT16",
        role: "STATUS",
        logicalAddress: "%MW30",
      });
      const second = await exportEdgeDeployment(db, alice, plcId, { pollIntervalMs: 200 });
      expect(second.configVersion).toBeGreaterThan(first.configVersion);
      deploy(second);
      const updated = await until("the update", async () => {
        const body = (await health(`/v1/plcs/${plcId}`)) as Plc | undefined;
        return body?.configVersion === second.configVersion && body.state === "ONLINE" ? body : undefined;
      });
      expect(updated.values.map((value) => value.name)).toContain("Spare_Word");
      expect(readFileSync(join(dir, "active", edgeDeploymentFileName("PLC-01")), "utf8")).toContain("Spare_Word");
      // The agent only read: nothing was written through it.
      expect(await db.deviceCommand.count()).toBe(2);
    },
    400_000,
  );
});

/** The agent creates its directories when it starts. */
function expectAgentDirectories(dir: string) {
  expect(readdirSync(dir).sort()).toEqual(["active", "rejected", "spool", "staging"]);
}
