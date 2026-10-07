/**
 * The PLC lab of the production-like edge run (TASK-906, docs/edge-deployment.md): real
 * OpenPLC runtimes started by Z-Factory with a real program, exported as edge deployment
 * files for the Thin Client Agent. It writes `<out>/manifest.json` and the deployment
 * files, keeps the runtimes running until it gets SIGINT or SIGTERM, then removes them and
 * its factory.
 *
 *   TEST_DATABASE_URL=… tsx --conditions=react-server test/edge-standin/plc-lab.ts <out> [count]
 *   … plc-lab.ts --cleanup     removes whatever any lab run left behind
 *
 * It uses the test database (never the development one) and labels every container, so
 * nothing outlives it. The program keeps the authority over the machine: Running follows
 * Start_Cmd only while the speed setpoint is above zero, whatever the cloud writes.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDockerClient } from "../../lib/docker/client";
import { DEFAULT_LIMITS } from "../../lib/docker/policy";
import { RUNTIME_IMAGES } from "../../lib/docker/runtime-images";
import { edgeDeploymentFileName } from "../../lib/domain/edge-deployment";
import { createDeviceInstance } from "../../lib/services/device-service";
import { exportEdgeDeployment } from "../../lib/services/edge-deployment-service";
import { createFactory } from "../../lib/services/factory-service";
import { createProgramVersion, type RuntimeDeps, startPlc } from "../../lib/services/plc-runtime-service";
import { createTag } from "../../lib/services/tag-service";
import { cidrsOverlap } from "../../lib/validation/network";
import { createPrismaClient } from "../../lib/db/client";
import type { PrismaClient } from "../../lib/generated/prisma/client";
import { assertTestDatabaseUrl } from "../integration/test-database-url";

/** The test database only (the harness itself imports vitest, so it is not used here). */
function openTestDb(): PrismaClient {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set.");
  assertTestDatabaseUrl(url);
  return createPrismaClient(url);
}

/** A generic, programmable PLC model (as the integration harness makes one). */
async function createPlcModel(db: PrismaClient, modelName: string) {
  const manufacturer = await db.manufacturer.upsert({
    where: { name: "Generic / simulated" },
    create: { name: "Generic / simulated" },
    update: {},
  });
  const category = await db.deviceCategory.findUniqueOrThrow({ where: { code: "PLC" } });
  const family = await db.deviceFamily.upsert({
    where: { manufacturerId_name: { manufacturerId: manufacturer.id, name: "Generic PLC" } },
    create: { manufacturerId: manufacturer.id, deviceCategoryId: category.id, name: "Generic PLC" },
    update: {},
  });
  return db.deviceModel.create({
    data: {
      familyId: family.id,
      modelName,
      architectureType: "COMPACT",
      runtimeSupport: "OPENPLC",
      capabilities: ["PROGRAMMABLE", "IEC_61131_3"],
      verificationStatus: "GENERIC",
    },
  });
}

export const PROGRAM = `PROGRAM line
  VAR
    Start_Cmd AT %QX101.0 : BOOL;
    Speed_SP AT %QW101 : INT;
    Running AT %QX100.0 : BOOL;
    Speed_Ref AT %QW100 : INT;
  END_VAR
  (* The interlock: no run without a positive speed setpoint, whatever is commanded. *)
  Running := Start_Cmd AND (Speed_SP > 0);
  IF Running THEN
    Speed_Ref := Speed_SP;
  ELSE
    Speed_Ref := 0;
  END_IF;
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#50ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : line;
  END_RESOURCE
END_CONFIGURATION
`;

const LABEL = "zfactory.edge-standin";

/** Removes every stand-in container, network, factory and model, whatever run left them. */
async function cleanupAll() {
  const db = openTestDb();
  const docker = createDockerClient(process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock");
  const containers = await docker.listContainers({ all: true, filters: { label: [LABEL] } });
  for (const container of containers) await docker.getContainer(container.Id).remove({ force: true, v: true });
  const networks = await docker.listNetworks({ filters: { label: [LABEL] } });
  for (const network of networks) await docker.getNetwork(network.Id).remove();
  const factories = await db.factory.deleteMany({ where: { slug: { startsWith: "edge-standin-" } } });
  const models = await db.deviceModel.deleteMany({ where: { modelName: { startsWith: "Edge stand-in PLC " } } });
  await db.$disconnect();
  console.log(
    `plc-lab cleanup: ${containers.length} containers, ${networks.length} networks, ${factories.count} factories, ${models.count} models`,
  );
}

async function main() {
  if (process.argv[2] === "--cleanup") return cleanupAll();
  const out = process.argv[2];
  const count = Number(process.argv[3] ?? "1");
  if (!out || !Number.isInteger(count) || count < 1 || count > 4) {
    console.error("usage: plc-lab.ts <out-dir> [count 1-4]");
    process.exit(2);
  }
  mkdirSync(out, { recursive: true });
  const runId = randomUUID();
  const actor = { ownerId: `edge-standin-${runId.slice(0, 8)}` };
  const db = openTestDb();
  const docker = createDockerClient(process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock");
  const runtime: RuntimeDeps = {
    db,
    docker,
    policy: {
      images: RUNTIME_IMAGES,
      portRange: { min: 15_980, max: 15_999 },
      bindAddresses: ["127.0.0.1"],
      limits: DEFAULT_LIMITS,
      labels: { [LABEL]: runId },
    },
    runtimeSecret: "edge-standin-runtime-secret-0123456789abcdef",
  };
  const used = (await docker.listNetworks()).flatMap((network) =>
    (network.IPAM?.Config ?? []).map((config) => config.Subnet ?? "").filter(Boolean),
  );
  let subnet = "";
  for (let third = 60; third < 90 && !subnet; third += 1) {
    const candidate = `10.217.${third}.0/28`;
    if (!used.some((existing) => !existing.includes(":") && cidrsOverlap(candidate, existing))) subnet = candidate;
  }
  const factory = await createFactory(db, actor, {
    name: "Edge Stand-in",
    slug: `edge-standin-${runId.slice(0, 8)}`,
    subnetCidr: subnet,
  });

  const cleanup = async () => {
    for (const container of await docker.listContainers({ all: true, filters: { label: [`${LABEL}=${runId}`] } })) {
      await docker.getContainer(container.Id).remove({ force: true, v: true });
    }
    for (const network of await docker.listNetworks({ filters: { label: [`${LABEL}=${runId}`] } })) {
      await docker.getNetwork(network.Id).remove();
    }
    await db.factory.delete({ where: { id: factory.id } }).catch(() => undefined);
    await db.deviceModel
      .deleteMany({ where: { modelName: `Edge stand-in PLC ${runId.slice(0, 8)}` } })
      .catch(() => undefined);
    await db.$disconnect();
  };
  // Nothing else keeps the process alive once the runtimes run: wait for a signal.
  const alive = setInterval(() => {}, 60_000);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(alive);
    void cleanup().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    const model = await createPlcModel(db, `Edge stand-in PLC ${runId.slice(0, 8)}`);
    const plcs = [];
    for (let index = 1; index <= count; index += 1) {
      const name = `OPENPLC-${index}`;
      const plc = await createDeviceInstance(db, { factoryId: factory.id, deviceModelId: model.id, name });
      await createProgramVersion(db, actor, plc.id, { sourceText: PROGRAM });
      for (const tag of [
        { name: "Start_Cmd", dataType: "BOOL", role: "COMMAND", logicalAddress: "%QX101.0" },
        { name: "Speed_SP", dataType: "INT16", scale: 0.1, unit: "Hz", role: "SETPOINT", logicalAddress: "%QW101" },
        { name: "Running", dataType: "BOOL", role: "STATUS", logicalAddress: "%QX100.0" },
        { name: "Speed_Ref", dataType: "INT16", scale: 0.1, unit: "Hz", role: "STATUS", logicalAddress: "%QW100" },
      ] as const) {
        await createTag(db, actor, plc.id, tag);
      }
      const started = await startPlc(runtime, actor, plc.id);
      if (started.state !== "RUNNING") throw new Error(`${name} did not start: ${JSON.stringify(started)}`);
      // The runtime's own Modbus endpoint on the host loopback: what an edge host on the LAN would reach.
      const document = await exportEdgeDeployment(db, actor, plc.id, { pollIntervalMs: 250 });
      const file = edgeDeploymentFileName(document.deployment.plc.name);
      writeFileSync(join(out, file), `${JSON.stringify(document, null, 2)}\n`);
      plcs.push({ name, plcId: plc.id, file, endpoint: document.deployment.connection });
    }
    writeFileSync(join(out, "manifest.json"), `${JSON.stringify({ runId, factoryId: factory.id, plcs }, null, 2)}\n`);
    console.log(`plc-lab ready: ${plcs.length} OpenPLC runtime(s); Ctrl-C to stop`);
  } catch (error) {
    console.error("plc-lab failed:", error instanceof Error ? error.message : error);
    clearInterval(alive);
    await cleanup();
    process.exit(1);
  }
}

void main();
