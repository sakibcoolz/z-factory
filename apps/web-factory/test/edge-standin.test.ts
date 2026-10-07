import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mqtt from "mqtt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/auth/actor";
import { commandEnvelope } from "@/lib/domain/commands";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { MqttRuntime } from "@/lib/mqtt/runtime";
import { issueCommand } from "@/lib/services/command-service";
import { issueAgentCredentials } from "@/lib/services/onboarding-service";
import { createAgent, createSite, registerDeployment } from "@/lib/services/site-service";
import { getLatest } from "@/lib/services/telemetry-service";
import { actorForSession, authenticate, bootstrapAdmin } from "@/lib/services/user-service";
import { docker, freePort, startBroker, until, withBroker } from "./broker-harness";
import { deploymentFile, mapping, openTestDb, resetDb } from "./harness";
import { ModbusServer } from "./modbus-server";

/**
 * The production-like edge run (TASK-906, docs/edge-deployment.md): no physical edge host
 * yet, so the closest stand-in on this machine.
 *
 * - The agent is the release container image (packaging/Dockerfile, AGENT_IMAGE), run
 *   hardened: read-only root, every capability dropped, no new privileges, not root,
 *   bounded memory and processes. Its state (staging/, active/, rejected/, spool/) is a
 *   directory that survives restarts, like /var/lib/zfactory-agent on a gateway.
 * - The broker speaks MQTT over TLS only (broker/mosquitto-tls.conf); agent and Web Factory
 *   verify it with a CA file and sign in with their own Dynamic Security passwords.
 * - The PLCs are EDGE_STANDIN_N simulated Modbus PLCs (default 20) and, when the PLC lab
 *   ran (EDGE_STANDIN_OPENPLC: test/edge-standin/plc-lab.ts), real OpenPLC runtimes with a
 *   real program.
 *
 * It measures and checks: hot add, isolation from a slow and a dead PLC, refused files, a
 * hot update, commands through the PLC's own logic, a broker outage with an agent restart
 * in it, spool pressure, and the agent's resources. EDGE_STANDIN_REPORT names a file for
 * the measurements. Needs Docker, the test database and AGENT_IMAGE.
 */
const image = process.env.AGENT_IMAGE;
const describeStandin = withBroker && image ? describe : describe.skip;
// The scenarios use PLCs sim-0 to sim-9 for their roles: at least 10.
const N = Math.max(10, Number(process.env.EDGE_STANDIN_N ?? "20"));
const openplcDir = process.env.EDGE_STANDIN_OPENPLC;
const POLL_MS = 500;

type Metrics = Map<string, number>;

describeStandin("production-like edge run: hardened agent container, TLS, many PLCs (TASK-906)", () => {
  let db: PrismaClient;
  let admin: Actor;
  let agentId = "";
  let work = "";
  let state = "";
  let secrets = "";
  let broker: Awaited<ReturnType<typeof startBroker>>;
  let runtime: MqttRuntime;
  let agentContainer = "";
  let healthPort = 0;
  let username = "";
  const plcs: ModbusServer[] = [];
  const ports: number[] = [];
  const files = new Map<string, string>();
  const ids = new Map<string, string>();
  const openplc: Array<{ name: string; file: string; external: string }> = [];
  const report: Record<string, unknown> = { n: N, pollMs: POLL_MS, image, startedAt: new Date().toISOString() };

  const metrics = async (): Promise<Metrics> => {
    const text = await (await fetch(`http://127.0.0.1:${healthPort}/metrics`)).text();
    const values: Metrics = new Map();
    for (const line of text.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const space = line.lastIndexOf(" ");
      values.set(line.slice(0, space), Number(line.slice(space + 1)));
    }
    return values;
  };
  const metric = (values: Metrics, name: string) => values.get(name) ?? 0;
  const containerStats = () => {
    const [memory, cpu, pids] = docker(
      "stats",
      "--no-stream",
      "--format",
      "{{.MemUsage}}|{{.CPUPerc}}|{{.PIDs}}",
      agentContainer,
    ).split("|");
    return { memory, cpu, pids: Number(pids) };
  };
  const stage = (name: string, text: string) => {
    writeFileSync(join(state, "staging", `.${name}.tmp`), text);
    renameSync(join(state, "staging", `.${name}.tmp`), join(state, "staging", name));
  };
  const batches = async (plcId: string, since: Date, until?: Date) =>
    Number(
      (
        await db.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*) AS n FROM telemetry.batch WHERE plc_id = $1::uuid AND at >= $2 AND at < $3`,
          plcId,
          since,
          until ?? new Date(Date.now() + 60_000),
        )
      )[0]?.n ?? 0,
    );
  const startAgent = (env: Record<string, string> = {}) => {
    const settings: Record<string, string> = {
      ZFACTORY_AGENT_MQTT_URL: broker.url,
      ZFACTORY_AGENT_SITE_ID: "plant-1",
      ZFACTORY_AGENT_ID: "edge-1",
      ZFACTORY_AGENT_MQTT_USERNAME: username,
      ZFACTORY_AGENT_MQTT_PASSWORD_FILE: "/etc/zfactory-agent/mqtt-password",
      ZFACTORY_AGENT_MQTT_CA_FILE: "/etc/zfactory-agent/broker-ca.crt",
      ZFACTORY_AGENT_HEALTH_ADDR: `127.0.0.1:${healthPort}`,
      ZFACTORY_AGENT_SCAN_INTERVAL: "200ms",
      ZFACTORY_AGENT_SETTLE: "0s",
      ZFACTORY_AGENT_HEARTBEAT: "1s",
      ZFACTORY_AGENT_REPLAY_RATE: "200",
      ...env,
    };
    agentContainer = docker(
      "run",
      "-d",
      "--label",
      "web-factory-test=edge-standin",
      "--network",
      "host",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      "--memory",
      "256m",
      "--pids-limit",
      "512",
      "-v",
      `${state}:/var/lib/zfactory-agent`,
      "-v",
      `${secrets}:/etc/zfactory-agent:ro`,
      ...Object.entries(settings).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      image!,
    );
  };
  const stopAgent = () => {
    if (agentContainer) docker("rm", "-f", agentContainer);
    agentContainer = "";
  };

  beforeAll(async () => {
    db = openTestDb();
    await resetDb(db);
    const { organizationId } = await bootstrapAdmin(db, {
      organization: "Acme Water",
      slug: "acme-water",
      email: "admin@acme.example",
      name: "Ada Admin",
      password: "a long admin password",
    });
    const signedIn = await authenticate(db, "admin@acme.example", "a long admin password");
    admin = (await actorForSession(db, signedIn?.userId, signedIn?.sessionVersion))!;
    const site = await createSite(db, admin, organizationId, { siteKey: "plant-1", name: "Plant 1" });
    agentId = (await createAgent(db, admin, site.id, { agentKey: "edge-1", name: "Edge gateway 1" })).id;

    for (let index = 0; index < N; index += 1) {
      const plc = new ModbusServer();
      const port = await freePort();
      await plc.listen(port);
      plc.registers.set(101, 100 + index);
      plcs.push(plc);
      ports.push(port);
      const external = `sim-${index}`;
      const file = deploymentFile({
        plcId: external,
        plcName: `SIM-${String(index).padStart(3, "0")}`,
        host: "127.0.0.1",
        port,
        pollIntervalMs: POLL_MS,
        mappings: [
          mapping("t-start", "Start_Cmd", "WRITE", "COMMAND", "EXTERNAL_COMMAND", "BOOL", "COIL", 800),
          {
            ...mapping(
              "t-speed",
              "Speed_SP",
              "WRITE",
              "SETPOINT",
              "EXTERNAL_COMMAND",
              "INT16",
              "HOLDING_REGISTER",
              101,
            ),
            scale: 0.1,
            unit: "Hz",
            min: 0,
            max: 50,
          },
          mapping("t-running", "Running", "READ", "STATUS", "PROGRAM_OUTPUT", "BOOL", "COIL", 8192),
        ],
      });
      files.set(external, file);
      await registerDeployment(db, admin, agentId, file);
      ids.set(external, (await db.plc.findFirstOrThrow({ where: { externalPlcId: external } })).id);
    }
    // PLC sim-4 runs a "program" with an interlock: the PLC decides, not the cloud.
    plcs[4]!.registers.set(101, 0);
    plcs[4]!.run((plc) => plc.coils.set(8192, Boolean(plc.coils.get(800)) && (plc.registers.get(101) ?? 0) > 0));
    if (openplcDir && existsSync(join(openplcDir, "manifest.json"))) {
      const manifest = JSON.parse(readFileSync(join(openplcDir, "manifest.json"), "utf8")) as {
        plcs: Array<{ name: string; plcId: string; file: string }>;
      };
      for (const entry of manifest.plcs) {
        const text = readFileSync(join(openplcDir, entry.file), "utf8");
        await registerDeployment(db, admin, agentId, text);
        files.set(entry.plcId, text);
        ids.set(entry.plcId, (await db.plc.findFirstOrThrow({ where: { externalPlcId: entry.plcId } })).id);
        openplc.push({ name: entry.name, file: entry.file, external: entry.plcId });
      }
    }
    report.openplc = openplc.map((entry) => entry.name);

    work = mkdtempSync(join(tmpdir(), "web-factory-standin-"));
    broker = await startBroker(work, "edge-standin", { tls: true });
    runtime = new MqttRuntime(
      {
        url: broker.url,
        username: "admin",
        passwordFile: broker.passwordFile,
        caFile: broker.caFile,
        clientId: "web-factory-standin",
      },
      db,
      () => {},
      { agentCacheMs: 0 },
      { plcCacheMs: 0, capacity: 50_000, writers: 2 },
      { intervalMs: 1000, limits: { heartbeatMs: 1000 } },
    );
    await until(
      "Web Factory over TLS",
      () => (runtime.status().connected && runtime.status().commandsAllowed) || undefined,
      30_000,
    );
    const issued = await issueAgentCredentials(db, runtime.dynsec, admin, agentId);
    username = issued.username;
    state = join(work, "state");
    secrets = join(work, "secrets");
    for (const directory of ["staging", "active", "rejected", "spool"])
      mkdirSync(join(state, directory), { recursive: true });
    mkdirSync(secrets, { recursive: true });
    writeFileSync(join(secrets, "mqtt-password"), `${issued.password}\n`, { mode: 0o600 });
    writeFileSync(join(secrets, "broker-ca.crt"), readFileSync(broker.caFile!));
    chmodSync(secrets, 0o750);
    healthPort = await freePort();
    startAgent();
    await until(
      "the agent's health",
      async () => ((await fetch(`http://127.0.0.1:${healthPort}/healthz`)).ok ? true : undefined),
      30_000,
    );
  }, 180_000);

  afterAll(async () => {
    stopAgent();
    await runtime?.stop();
    if (broker?.container) docker("rm", "-f", broker.container);
    for (const plc of plcs) await plc.close();
    if (work) rmSync(work, { recursive: true, force: true });
    if (process.env.EDGE_STANDIN_REPORT) {
      writeFileSync(
        process.env.EDGE_STANDIN_REPORT,
        `${JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2)}\n`,
      );
    }
    await db?.$disconnect();
  }, 60_000);

  it("speaks TLS only to a broker it can verify", async () => {
    // Without the CA the broker's certificate is not trusted: no connection.
    const refused = await mqtt
      .connectAsync(broker.url, { username: "admin", password: "x", reconnectPeriod: 0, connectTimeout: 5000 })
      .then(
        (client) => {
          client.end(true);
          return "connected";
        },
        (error: Error) => error.message,
      );
    expect(refused).toMatch(/certificate|self.signed|unable to verify/i);
    // The agent signed in over TLS with its own credentials.
    await until(
      "the agent on the broker",
      async () => (metric(await metrics(), "zfactory_agent_mqtt_connected") === 1 ? true : undefined),
      30_000,
    );
    report.tls = { brokerUrl: broker.url.replace(/:\d+$/, ":<port>"), untrustedRefused: refused };
  }, 60_000);

  it("adds every PLC while running and brings all their telemetry to Web Factory", async () => {
    const started = Date.now();
    for (const [external, text] of files) stage(`plc-${external}.json`, text);
    await until(
      "every PLC online in Web Factory",
      async () => {
        const fresh = await db.tagLatest.groupBy({
          by: ["plcId"],
          where: { tag: "t-speed", at: { gt: new Date(Date.now() - 5000) } },
        });
        return fresh.length >= N ? true : undefined;
      },
      120_000,
    );
    const values = await metrics();
    report.hotAdd = {
      plcs: files.size,
      secondsToAllOnline: Math.round((Date.now() - started) / 100) / 10,
      workersOnline: metric(values, 'zfactory_agent_workers{state="ONLINE"}'),
    };
    expect(metric(values, "zfactory_agent_active_configs")).toBe(files.size);
    // Values count as good once the agent has also reported the PLC's connection (its state
    // message follows on the next heartbeat); until then they are shown as disconnected.
    const sample = await until("sim-7 reported online", async () => {
      const latest = await getLatest(db, admin, ids.get("sim-7")!);
      return latest.connection === "ONLINE" ? latest : undefined;
    });
    const speed = sample.tags.find((tag) => tag.tag === "t-speed");
    expect(speed?.quality).toBe("GOOD");
    expect(speed?.value as number).toBeCloseTo(10.7, 9);
  }, 180_000);

  it("keeps every other PLC polling while one is slow and one is gone", async () => {
    const others = [...ids.entries()]
      .filter(([external]) => /^sim-(?:[5-9]|\d{2,})$/.test(external))
      .map(([, id]) => id);
    const window = 10_000;
    const before = new Date();
    await new Promise((done) => setTimeout(done, window));
    const healthy = await Promise.all(others.map((id) => batches(id, before, new Date())));
    plcs[0]!.delayMs = 3000; // longer than its 2 s timeout
    await plcs[1]!.close();
    await new Promise((done) => setTimeout(done, 5000));
    const during = new Date();
    await new Promise((done) => setTimeout(done, window));
    const degraded = await Promise.all(others.map((id) => batches(id, during, new Date())));
    const ratio =
      degraded.reduce((a, b) => a + b, 0) /
      Math.max(
        1,
        healthy.reduce((a, b) => a + b, 0),
      );
    report.isolation = {
      otherPlcs: others.length,
      batchesBefore: healthy.reduce((a, b) => a + b, 0),
      batchesDuring: degraded.reduce((a, b) => a + b, 0),
      ratio: Math.round(ratio * 100) / 100,
    };
    expect(ratio).toBeGreaterThan(0.85);
    // Web Factory shows both, and raised their alarms.
    await until(
      "both PLCs disconnected with alarms",
      async () => {
        const alarms = await db.alarm.findMany({
          where: {
            source: "PLC_CONNECTION",
            activeKey: { not: null },
            plcId: { in: [ids.get("sim-0")!, ids.get("sim-1")!] },
          },
        });
        return alarms.length === 2 ? true : undefined;
      },
      60_000,
    );
    const values = await metrics();
    report.isolation = {
      ...(report.isolation as object),
      slowPlcFailures: metric(values, `zfactory_agent_plc_poll_failures_total{plc_id="sim-0"}`),
      deadPlcFailures: metric(values, `zfactory_agent_plc_poll_failures_total{plc_id="sim-1"}`),
    };
  }, 120_000);

  it("refuses broken and tampered files without touching the PLCs that run", async () => {
    const id = ids.get("sim-2")!;
    const since = new Date();
    stage("plc-garbage.json", "{ this is not a deployment");
    stage("plc-tampered.json", files.get("sim-2")!.replace('"host": "127.0.0.1"', '"host": "10.66.66.66"'));
    await until(
      "both refused",
      () =>
        readdirSync(join(state, "rejected")).filter((name) => name.endsWith(".reason.json")).length >= 2
          ? true
          : undefined,
      30_000,
    );
    const values = await metrics();
    expect(metric(values, "zfactory_agent_rejected_configs")).toBeGreaterThanOrEqual(2);
    await new Promise((done) => setTimeout(done, 3000));
    expect(await batches(id, since)).toBeGreaterThan(3);
    report.refusedFiles = readdirSync(join(state, "rejected")).filter((name) => !name.endsWith(".reason.json")).length;
  }, 60_000);

  it("takes a new version of one PLC without disturbing the others", async () => {
    const updated = deploymentFile({
      plcId: "sim-3",
      plcName: "SIM-003",
      host: "127.0.0.1",
      port: ports[3]!,
      pollIntervalMs: 1000,
      version: 2,
      mappings: JSON.parse(files.get("sim-3")!).deployment.mappings,
    });
    await registerDeployment(db, admin, agentId, updated);
    stage("plc-sim-3.json", updated);
    await until("the agent runs version 2", async () =>
      (await db.plc.findUniqueOrThrow({ where: { id: ids.get("sim-3")! } })).edgeConfigVersion === 2 ? true : undefined,
    );
    files.set("sim-3", updated);
  }, 60_000);

  it("carries commands to the PLC, whose own logic decides what runs", async () => {
    const publish = (topic: string, payload: string) => runtime.publishCommand(topic, payload);
    const done = async (id: string) =>
      until(
        `command ${id}`,
        async () => {
          const command = await db.command.findUniqueOrThrow({ where: { id } });
          return ["APPLIED", "FAILED", "REJECTED", "TIMED_OUT"].includes(command.status) ? command : undefined;
        },
        30_000,
      );
    const running = async (external: string) =>
      (await getLatest(db, admin, ids.get(external)!)).tags.find(
        (tag) => tag.tag === (external.startsWith("sim") ? "t-running" : "Running"),
      )?.value;

    // The simulated PLC with an interlock: start without a speed is written, but the PLC does not run.
    const writes = plcs[4]!.writes.length;
    const start = await issueCommand(db, publish, admin, ids.get("sim-4")!, {
      tag: "t-start",
      value: true,
      requestKey: "standin-start",
    });
    expect((await done(start.command.id)).status).toBe("APPLIED");
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(await running("sim-4")).toBe(false);
    const speed = await issueCommand(db, publish, admin, ids.get("sim-4")!, {
      tag: "t-speed",
      value: 25,
      requestKey: "standin-speed",
    });
    expect((await done(speed.command.id)).status).toBe("APPLIED");
    await until("the PLC runs once its interlock allows", async () =>
      (await running("sim-4")) === true ? true : undefined,
    );
    // A redelivered command: answered, not written again.
    await publish(
      "zfactory/plant-1/edge-1/command/sim-4",
      JSON.stringify(
        commandEnvelope({
          commandId: speed.command.id,
          plcId: "sim-4",
          mappingId: "t-speed",
          value: 25,
          configVersion: speed.command.configVersion,
          issuedAt: speed.command.requestedAt,
          expiresAt: speed.command.expiresAt,
          requestedBy: speed.command.requestedBy,
        }),
      ),
    );
    await until("the duplicate answer", async () =>
      (await db.command.findUniqueOrThrow({ where: { id: speed.command.id } })).duplicateAcks > 0 ? true : undefined,
    );
    expect(plcs[4]!.writes.length).toBe(writes + 2);
    const commandReport: Record<string, unknown> = {
      simulated: { writes: plcs[4]!.writes.length - writes, interlockHeld: true },
    };

    // The real OpenPLC program, the same way.
    for (const entry of openplc) {
      const plcId = ids.get(entry.external)!;
      const document = JSON.parse(files.get(entry.external)!) as {
        deployment: { mappings: Array<{ id: string; name: string }> };
      };
      const tagOf = (name: string) => document.deployment.mappings.find((m) => m.name === name)!.id;
      const command = async (name: string, value: number | boolean, key: string) =>
        (
          await done(
            (await issueCommand(db, publish, admin, plcId, { tag: tagOf(name), value, requestKey: key })).command.id,
          )
        ).status;
      const latest = async (name: string) =>
        (await getLatest(db, admin, plcId)).tags.find((tag) => tag.name === name)?.value;
      expect(await command("Speed_SP", 0, `${entry.name}-zero`)).toBe("APPLIED");
      expect(await command("Start_Cmd", true, `${entry.name}-start`)).toBe("APPLIED");
      await new Promise((resolve) => setTimeout(resolve, 2000));
      expect(await latest("Running")).toBe(false);
      expect(await command("Speed_SP", 25, `${entry.name}-speed`)).toBe("APPLIED");
      await until(`${entry.name} running at 25 Hz`, async () =>
        (await latest("Running")) === true && (await latest("Speed_Ref")) === 25 ? true : undefined,
      );
      expect(await command("Start_Cmd", false, `${entry.name}-stop`)).toBe("APPLIED");
      await until(`${entry.name} stopped`, async () => ((await latest("Running")) === false ? true : undefined));
      commandReport[entry.name] = { interlockHeld: true, ranAt: 25, stopped: true };
    }
    // The agent's own count, before any restart resets it.
    commandReport.agentCounters = Object.fromEntries(
      [...(await metrics())].filter(([key]) => key.startsWith("zfactory_agent_commands_total")),
    );
    report.commands = commandReport;
  }, 180_000);

  it("keeps polling through a broker outage and an agent restart, then replays every batch once", async () => {
    const id = ids.get("sim-9")!;
    const outageStart = new Date();
    docker("stop", "-t", "1", broker.container);
    await until(
      "the agent spools",
      async () => (metric(await metrics(), "zfactory_agent_spool_entries") > 20 ? true : undefined),
      60_000,
    );
    await new Promise((done) => setTimeout(done, 10_000));
    // The agent restarts while the cloud is away: its spool is on disk.
    const restartStart = Date.now();
    docker("restart", "-t", "10", agentContainer);
    await until(
      "the agent back",
      async () => (await fetch(`http://127.0.0.1:${healthPort}/healthz`).catch(() => null))?.ok || undefined,
      30_000,
    );
    const restartSeconds = (Date.now() - restartStart) / 1000;
    await new Promise((done) => setTimeout(done, 15_000));
    const spooled = metric(await metrics(), "zfactory_agent_spool_entries");
    const outageEnd = new Date();
    docker("start", broker.container);
    await until("Web Factory back", () => runtime.status().connected || undefined, 60_000);
    await until(
      "the spool drained",
      async () => {
        const values = await metrics();
        return metric(values, "zfactory_agent_mqtt_connected") === 1 &&
          metric(values, "zfactory_agent_spool_entries") === 0
          ? true
          : undefined;
      },
      120_000,
    );
    await new Promise((done) => setTimeout(done, 3000));
    await runtime.telemetry.idle();
    const outageSeconds = (outageEnd.getTime() - outageStart.getTime()) / 1000;
    const stored = await batches(id, outageStart, outageEnd);
    // While the agent itself restarts nothing polls: that gap is not expected to be filled.
    const expected = Math.max(0, outageSeconds - restartSeconds - 2) * (1000 / POLL_MS);
    const samples = Number(
      (
        await db.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*) AS n FROM telemetry.sample WHERE plc_id = $1::uuid AND tag = 't-speed' AND at >= $2 AND at < $3`,
          id,
          outageStart,
          outageEnd,
        )
      )[0]?.n ?? 0,
    );
    report.outage = {
      seconds: Math.round(outageSeconds),
      agentRestartedDuringOutage: true,
      agentRestartSeconds: Math.round(restartSeconds * 10) / 10,
      spooledAtEnd: spooled,
      storedForOnePlc: stored,
      expectedForOnePlc: Math.round(expected),
      samplesEqualBatches: samples === stored,
      replayedTotal: metric(await metrics(), "zfactory_agent_spool_replayed_total"),
    };
    // Polling went on (minus the few seconds the agent itself was restarting), and each batch is stored once.
    expect(stored).toBeGreaterThan(expected * 0.8);
    expect(samples).toBe(stored);
  }, 300_000);

  it("bounds the spool under pressure: the oldest is dropped and counted", async () => {
    stopAgent();
    startAgent({ ZFACTORY_AGENT_SPOOL_MAX_BYTES: String(256 * 1024) });
    await until(
      "the agent on the broker",
      async () =>
        metric(await metrics().catch(() => new Map()), "zfactory_agent_mqtt_connected") === 1 ? true : undefined,
      60_000,
    );
    docker("stop", "-t", "1", broker.container);
    const values = await until(
      "spool drops",
      async () => {
        const current = await metrics();
        return metric(current, "zfactory_agent_spool_dropped_total") > 0 ? current : undefined;
      },
      240_000,
    );
    report.spoolPressure = {
      maxBytes: 256 * 1024,
      bytes: metric(values, "zfactory_agent_spool_bytes"),
      entries: metric(values, "zfactory_agent_spool_entries"),
      dropped: metric(values, "zfactory_agent_spool_dropped_total"),
    };
    expect(metric(values, "zfactory_agent_spool_bytes")).toBeLessThanOrEqual(256 * 1024 * 1.25);
    docker("start", broker.container);
    await until("Web Factory back", () => runtime.status().connected || undefined, 60_000);
  }, 300_000);

  it("stays within bounded resources", async () => {
    await new Promise((done) => setTimeout(done, 5000));
    const values = await metrics();
    const stats = containerStats();
    const goroutines = metric(values, "go_goroutines");
    report.resources = {
      plcs: files.size,
      goroutines,
      heapBytes: metric(values, "go_memstats_heap_alloc_bytes"),
      sysBytes: metric(values, "go_memstats_sys_bytes"),
      cpuSeconds: metric(values, "process_cpu_seconds_total"),
      container: stats,
      queueDepth: metric(values, "zfactory_agent_queue_depth"),
      queueDropped: metric(values, "zfactory_agent_queue_dropped_total"),
      pollSeconds: [...values]
        .filter(([key]) => key.startsWith("zfactory_agent_plc_poll_duration_seconds"))
        .map(([, value]) => value)
        .sort((a, b) => a - b)
        .at(-1),
      webFactory: { ingest: runtime.status().ingest.dropped, telemetry: runtime.status().telemetry },
    };
    expect(goroutines).toBeLessThan(3 * files.size + 80);
    expect(stats.pids).toBeLessThan(512);
    expect(metric(values, "zfactory_agent_queue_dropped_total")).toBe(0);
    // No secret is in the deployment files or the agent's settings on disk.
    for (const text of files.values()) expect(text).not.toMatch(/password|secret|token/i);
    const inspected = docker("inspect", "--format", "{{json .Config.Env}}", agentContainer);
    expect(inspected).not.toContain(readFileSync(join(secrets, "mqtt-password"), "utf8").trim());
    report.security = {
      secretsInDeploymentFiles: false,
      passwordInContainerEnv: false,
      readOnlyRoot: docker("inspect", "--format", "{{.HostConfig.ReadonlyRootfs}}", agentContainer) === "true",
      capDrop: docker("inspect", "--format", "{{json .HostConfig.CapDrop}}", agentContainer),
      user: docker("inspect", "--format", "{{.Config.User}}", agentContainer),
    };
  }, 60_000);
});
