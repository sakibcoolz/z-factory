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
    await stopProcess(agent);
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

  itAgent(
    "closes the loop over MQTT: telemetry up, a checked command down, PLC logic, feedback, ack; and spools an outage (TASK-503c)",
    async () => {
      // The agent of the previous test makes way for one with an uplink.
      await stopProcess(agent);
      const mqttPort = await freePort();
      const broker = await docker!.createContainer({
        Image: "eclipse-mosquitto:2",
        Cmd: ["mosquitto", "-c", "/mosquitto-no-auth.conf"],
        Labels: { [RUN_LABEL]: runId },
        HostConfig: { PortBindings: { "1883/tcp": [{ HostIp: "127.0.0.1", HostPort: String(mqttPort) }] } },
      });
      await broker.start();
      const brokerName = (await broker.inspect()).Name.replace(/^\//, "");

      // The cloud: what mosquitto_sub sees, and commands sent with mosquitto_pub.
      const seen: Array<{ topic: string; body: Record<string, unknown> | null }> = [];
      let subscriber: ChildProcess | undefined;
      const subscribe = () => {
        subscriber = spawn("docker", ["exec", brokerName, "mosquitto_sub", "-t", "zfactory/#", "-v", "-q", "1"]);
        let pending = "";
        subscriber.stdout?.on("data", (chunk: Buffer) => {
          pending += chunk.toString();
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            const space = line.indexOf(" ");
            const topic = space < 0 ? line : line.slice(0, space);
            let body: Record<string, unknown> | null = null;
            try {
              body = space < 0 ? null : (JSON.parse(line.slice(space + 1)) as Record<string, unknown>);
            } catch {
              body = null;
            }
            seen.push({ topic, body });
          }
        });
      };
      await until("the broker", async () => {
        const probe = spawn("docker", ["exec", brokerName, "mosquitto_pub", "-t", "probe", "-m", "x"]);
        return (await new Promise<number | null>((resolve) => probe.once("exit", resolve))) === 0 ? true : undefined;
      });
      subscribe();
      const publish = async (topic: string, body: unknown) => {
        const child = spawn("docker", [
          "exec",
          brokerName,
          "mosquitto_pub",
          "-q",
          "1",
          "-t",
          topic,
          "-m",
          JSON.stringify(body),
        ]);
        expect(await new Promise<number | null>((resolve) => child.once("exit", resolve))).toBe(0);
      };

      const edge = mkdtempSync(join(tmpdir(), "zfactory-agent-mqtt-"));
      const health = await freePort();
      const args = ["-dir", edge, "-health", `127.0.0.1:${health}`, "-scan", "200ms", "-settle", "0s"];
      const mqtt = [
        "-mqtt-url",
        `tcp://127.0.0.1:${mqttPort}`,
        "-site-id",
        "plant-1",
        "-agent-id",
        "edge-1",
        "-heartbeat",
        "1s",
        "-replay-rate",
        "20",
      ];
      let mqttAgent = spawn(binary ?? "", [...args, ...mqtt], { stdio: ["ignore", "pipe", "pipe"] });
      mqttAgent.stdout?.resume();
      mqttAgent.stderr?.resume();
      const status = async () => {
        const response = await fetch(`http://127.0.0.1:${health}/v1/status`).catch(() => undefined);
        return response?.ok
          ? ((await response.json()) as { uplink: { connected: boolean; spool: { entries: number } } })
          : undefined;
      };
      try {
        await until("the agent", status);
        const document = await exportEdgeDeployment(db, alice, plcId, { pollIntervalMs: 200 });
        const name = edgeDeploymentFileName("PLC-01");
        writeFileSync(join(edge, "staging", `.${name}.tmp`), JSON.stringify(document));
        renameSync(join(edge, "staging", `.${name}.tmp`), join(edge, "staging", name));

        const root = "zfactory/plant-1/edge-1";
        type Value = { id: string; name: string; value: unknown; quality: string };
        const latest = (live = true) => {
          const batches = seen.filter(
            (m) => m.topic === `${root}/telemetry/${plcId}` && (!live || m.body?.replayed !== true),
          );
          return batches.at(-1)?.body as { values: Value[]; configVersion: number; replayed?: boolean } | undefined;
        };
        const value = (name: string) => latest()?.values.find((v) => v.name === name);
        await until("telemetry over MQTT", async () => (value("Speed_Ref")?.quality === "GOOD" ? true : undefined));
        // What reaches the cloud is what Z-Factory reads from the PLC.
        for (const tag of ["Start_Cmd", "Running", "Speed_Ref", "Run_Hours"]) {
          expect(value(tag)?.value, tag).toEqual((await readTag(runtime, alice, plcId, tag)).value);
        }
        expect(latest()?.configVersion).toBe(document.configVersion);

        const mapping = (tagName: string) => document.deployment.mappings.find((m) => m.name === tagName)!.id;
        const command = (id: string, tagName: string, commandValue: unknown) => ({
          schema: "zfactory.command",
          version: 1,
          commandId: id,
          plcId,
          mappingId: mapping(tagName),
          value: commandValue,
          configVersion: document.configVersion,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
          requestedBy: "integration-test",
        });
        const acks = (id: string) =>
          seen.filter((m) => m.topic === `${root}/ack/${plcId}` && m.body?.commandId === id).map((m) => m.body!);

        // A setpoint from the cloud: written to the command tag, the program carries it to its output.
        await publish(`${root}/command/${plcId}`, command("e2e-speed", "Speed_SP", 30));
        await until("the setpoint applied", async () => (acks("e2e-speed").length >= 2 ? true : undefined));
        expect(acks("e2e-speed").map((a) => a.status)).toEqual(["ACCEPTED", "APPLIED"]);
        expect(acks("e2e-speed")[1]).toMatchObject({ observed: 30 });
        await until("the program's output in telemetry", async () =>
          value("Speed_Ref")?.value === 30 ? true : undefined,
        );

        // A stop from the cloud: the program withdraws its output, the feedback says so.
        await publish(`${root}/command/${plcId}`, command("e2e-stop", "Start_Cmd", false));
        await until("the stop applied", async () => (acks("e2e-stop").at(-1)?.status === "APPLIED" ? true : undefined));
        await until("Running off in telemetry", async () =>
          value("Running")?.value === false && value("Speed_Ref")?.value === 0 ? true : undefined,
        );
        expect(await readTag(runtime, alice, plcId, "Running")).toMatchObject({ value: false });

        // The program's own output cannot be written from the cloud.
        await publish(`${root}/command/${plcId}`, command("e2e-force", "Running", true));
        await until("the refusal", async () => (acks("e2e-force").length > 0 ? true : undefined));
        expect(acks("e2e-force")[0]).toMatchObject({ status: "REJECTED", rule: "not-writable" });
        await sleep(500);
        expect(await readTag(runtime, alice, plcId, "Running")).toMatchObject({ value: false });

        // The broker goes away: polling goes on into the spool, which survives an agent restart.
        await stopProcess(subscriber);
        await broker.stop({ t: 0 });
        await until("the spool to fill", async () =>
          ((await status())?.uplink.spool.entries ?? 0) >= 5 ? true : undefined,
        );
        await stopProcess(mqttAgent);
        mqttAgent = spawn(binary ?? "", [...args, ...mqtt], { stdio: ["ignore", "pipe", "pipe"] });
        mqttAgent.stdout?.resume();
        mqttAgent.stderr?.resume();
        const kept = await until("the agent back with its spool", async () => {
          const entries = (await status())?.uplink.spool.entries;
          return entries !== undefined && entries >= 5 ? entries : undefined;
        });
        expect(kept).toBeGreaterThanOrEqual(5);

        // The broker returns: the backlog is replayed and the live loop goes on.
        await broker.start();
        await until("the broker again", async () => {
          const probe = spawn("docker", ["exec", brokerName, "mosquitto_pub", "-t", "probe", "-m", "x"]);
          return (await new Promise<number | null>((resolve) => probe.once("exit", resolve))) === 0 ? true : undefined;
        });
        const before = seen.length;
        subscribe();
        await until(
          "the spool to drain",
          async () =>
            (await status())?.uplink.spool.entries === 0 && (await status())?.uplink.connected ? true : undefined,
          60_000,
        );
        const replayed = seen
          .slice(before)
          .filter((m) => m.topic === `${root}/telemetry/${plcId}` && m.body?.replayed === true);
        expect(replayed.length).toBeGreaterThanOrEqual(kept);
        await until("live telemetry again", async () => (latest()?.values.length ? true : undefined));
      } finally {
        await stopProcess(subscriber);
        await stopProcess(mqttAgent);
        rmSync(edge, { recursive: true, force: true });
      }
    },
    400_000,
  );
});

async function stopProcess(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

async function until<T>(what: string, check: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result !== undefined) return result;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

/** The agent creates its directories when it starts. */
function expectAgentDirectories(dir: string) {
  expect(readdirSync(dir).sort()).toEqual(["active", "rejected", "spool", "staging"]);
}
