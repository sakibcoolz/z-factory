// @vitest-environment node
import { randomUUID } from "node:crypto";
import type Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCatalog } from "@/lib/catalog";
import { ingestCatalog } from "@/lib/catalog/ingest";
import { createDockerClient } from "@/lib/docker/client";
import { DEFAULT_LIMITS } from "@/lib/docker/policy";
import { RUNTIME_IMAGES } from "@/lib/docker/runtime-images";
import { EventBus } from "@/lib/events/bus";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { PlcLinkMonitorRuntime } from "@/lib/runtimes/plc-link/monitor";
import { listEvents } from "@/lib/services/event-service";
import { createFactory } from "@/lib/services/factory-service";
import {
  addPlcLinkMapping,
  createPlcLink,
  getPlcLinkHealth,
  type PlcLinkDeps,
  startPlcLinkMonitor,
  stopPlcLinkMonitor,
} from "@/lib/services/plc-communication-service";
import { createPlc } from "@/lib/services/plc-config-service";
import { createProgramVersion, type RuntimeDeps, startPlc, stopPlc } from "@/lib/services/plc-runtime-service";
import { createTag, readTag, writeTag } from "@/lib/services/tag-service";
import { cidrsOverlap } from "@/lib/validation/network";
import { openTestDb, resetDb } from "./harness";

/**
 * PLC-to-PLC communication on the factory network (TASK-703): two OpenPLC runtimes, the
 * client's own runtime is the Modbus master and reaches the server by its service name. A
 * command given to the client reaches the server only through the client's program; the
 * server's values come back into the client's input image and memory. Stopping the server
 * shows as a disconnected link and recovers when it is back. Needs TEST_DATABASE_URL and
 * TEST_DOCKER=1.
 */
const enabled = process.env.TEST_DOCKER === "1" && Boolean(process.env.TEST_DATABASE_URL);
const describeRuntime = enabled ? describe : describe.skip;

const RUN_LABEL = "zfactory.test-run";
const runId = randomUUID();
const alice = { ownerId: "alice" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const task = (name: string) => `
CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#50ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : ${name};
  END_RESOURCE
END_CONFIGURATION
`;

/** The machine: it runs while its command says so and counts while it runs. */
const MACHINE = `PROGRAM machine
  VAR
    Start_Cmd AT %QX100.0 : BOOL;
    Running AT %QX101.0 : BOOL;
    Counter AT %QW100 : INT;
  END_VAR
  Running := Start_Cmd;
  IF Running THEN
    Counter := Counter + 1;
  END_IF;
END_PROGRAM
${task("machine")}`;

/** The supervisor: it decides to start the machine, and mirrors what the machine reports. */
const SUPERVISOR = `PROGRAM supervisor
  VAR
    Gw_Start AT %QX102.0 : BOOL;
    Start_B AT %QX101.0 : BOOL;
    B_Running AT %IX10.0 : BOOL;
    B_Counter AT %MW10 : INT;
    Echo AT %QW100 : INT;
  END_VAR
  Start_B := Gw_Start;
  Echo := B_Counter;
END_PROGRAM
${task("supervisor")}`;

async function freeSubnet(docker: Docker): Promise<string> {
  const used = (await docker.listNetworks()).flatMap((network) =>
    (network.IPAM?.Config ?? []).map((config) => config.Subnet).filter((subnet): subnet is string => Boolean(subnet)),
  );
  for (let third = 61; third < 80; third += 1) {
    const candidate = `10.213.${third}.0/28`;
    if (!used.some((subnet) => !subnet.includes(":") && cidrsOverlap(candidate, subnet))) return candidate;
  }
  throw new Error("no free test subnet");
}

describeRuntime("PLC-to-PLC link between two OpenPLC runtimes", () => {
  let db: PrismaClient;
  let docker: Docker;
  let runtime: RuntimeDeps;
  let links: PlcLinkDeps;
  let factoryId: string;
  let supervisor: string;
  let machine: string;
  let linkId: string;

  const read = async (plcId: string, name: string) => (await readTag(runtime, alice, plcId, name)).value;
  async function until(plcId: string, name: string, condition: (value: unknown) => boolean, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    let value = await read(plcId, name).catch(() => null);
    while (!condition(value) && Date.now() < deadline) {
      await sleep(200);
      value = await read(plcId, name).catch(() => null);
    }
    return value;
  }
  async function quality(expected: string, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await links.monitor.tick(factoryId);
      const health = await getPlcLinkHealth(links, alice, factoryId);
      const current = health.find((entry) => entry.linkId === linkId)?.quality;
      if (current === expected || Date.now() > deadline) return current;
      await sleep(300);
    }
  }

  beforeAll(async () => {
    db = openTestDb();
    await resetDb(db);
    await ingestCatalog(db, loadCatalog());
    docker = createDockerClient(process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock");
    const bus = new EventBus();
    runtime = {
      db,
      docker,
      bus,
      policy: {
        images: RUNTIME_IMAGES,
        portRange: { min: 15_800, max: 15_879 },
        bindAddresses: ["127.0.0.1"],
        limits: DEFAULT_LIMITS,
        labels: { [RUN_LABEL]: runId },
      },
      runtimeSecret: "integration-test-runtime-secret-0123456789",
    };
    links = { db, bus, monitor: new PlcLinkMonitorRuntime(), pollMs: 500 };

    factoryId = (await createFactory(db, alice, { name: "Line", slug: "line", subnetCidr: await freeSubnet(docker) }))
      .id;
    const cpu = (
      await db.deviceModel.findFirstOrThrow({ where: { modelName: "CPU 1214C DC/DC/DC" }, select: { id: true } })
    ).id;
    supervisor = (await createPlc(db, alice, { factoryId, deviceModelId: cpu, name: "PLC-SUP" })).id;
    machine = (await createPlc(db, alice, { factoryId, deviceModelId: cpu, name: "PLC-MACHINE" })).id;

    for (const tag of [
      { name: "Start_Cmd", dataType: "BOOL", role: "COMMAND", logicalAddress: "%QX100.0" },
      { name: "Running", dataType: "BOOL", role: "STATUS", logicalAddress: "%QX101.0" },
      { name: "Counter", dataType: "INT16", role: "STATUS", logicalAddress: "%QW100" },
    ]) {
      await createTag(db, alice, machine, tag);
    }
    for (const tag of [
      { name: "Gw_Start", dataType: "BOOL", role: "COMMAND", logicalAddress: "%QX102.0" },
      { name: "Start_B", dataType: "BOOL", role: "STATUS", logicalAddress: "%QX101.0" },
      { name: "B_Running", dataType: "BOOL", role: "STATUS", logicalAddress: "%IX10.0" },
      { name: "B_Counter", dataType: "INT16", role: "STATUS", logicalAddress: "%MW10" },
      { name: "Echo", dataType: "INT16", role: "STATUS", logicalAddress: "%QW100" },
    ]) {
      await createTag(db, alice, supervisor, tag);
    }
    await createProgramVersion(db, alice, machine, { sourceText: MACHINE });
    await createProgramVersion(db, alice, supervisor, { sourceText: SUPERVISOR });

    linkId = (
      await createPlcLink(db, alice, {
        factoryId,
        sourcePlcId: supervisor,
        targetPlcId: machine,
        relationship: "SUPERVISES",
        pollIntervalMs: 200,
      })
    ).id;
    const tagId = async (plcId: string, name: string) =>
      (await db.tag.findFirstOrThrow({ where: { plcInstanceId: plcId, name }, select: { id: true } })).id;
    for (const [operation, local, remote] of [
      ["READ", "B_Running", "Running"],
      ["READ", "B_Counter", "Counter"],
      ["WRITE", "Start_B", "Start_Cmd"],
    ] as const) {
      await addPlcLinkMapping(db, alice, linkId, {
        operation,
        localTagId: await tagId(supervisor, local),
        remoteTagId: await tagId(machine, remote),
      });
    }
  }, 120_000);

  afterAll(async () => {
    await links?.monitor.stopAll();
    const filters = { label: [`${RUN_LABEL}=${runId}`] };
    for (const container of await docker.listContainers({ all: true, filters })) {
      await docker.getContainer(container.Id).remove({ force: true, v: true });
    }
    for (const network of await docker.listNetworks({ filters })) {
      await docker.getNetwork(network.Id).remove();
    }
    await db.$disconnect();
  }, 120_000);

  it("deploys the client's links with its program and reaches the server by its service name", async () => {
    expect(await startPlc(runtime, alice, machine)).toEqual({ state: "RUNNING" });
    expect(await startPlc(runtime, alice, supervisor)).toEqual({ state: "RUNNING" });
    const snapshot = await db.configurationVersion.findFirstOrThrow({
      where: { scopeType: "PLC", scopeId: supervisor },
      orderBy: { version: "desc" },
    });
    expect((snapshot.snapshotJson as { plcLinks: unknown }).plcLinks).toEqual([{ linkId, configVersion: 4 }]);
    startPlcLinkMonitor(links, factoryId, { autoTick: false });
    expect(await quality("GOOD")).toBe("GOOD");
  }, 400_000);

  it("carries a decision of the client's program to the server, and the server's values back", async () => {
    expect(await read(supervisor, "B_Running")).toBe(false);
    // The command is given to the supervisor; its program decides to start the machine.
    await writeTag(runtime, alice, supervisor, "Gw_Start", true);
    expect(await until(machine, "Start_Cmd", (value) => value === true)).toBe(true);
    expect(await until(machine, "Running", (value) => value === true)).toBe(true);
    // The machine's state and counter arrive in the supervisor's input image and memory.
    expect(await until(supervisor, "B_Running", (value) => value === true)).toBe(true);
    const counter = Number(await until(supervisor, "B_Counter", (value) => Number(value) > 5));
    expect(counter).toBeGreaterThan(5);
    expect(Number(await until(supervisor, "Echo", (value) => Number(value) >= counter))).toBeGreaterThanOrEqual(
      counter,
    );
    // A gateway cannot write the link's input on the supervisor: the link owns it.
    const refused = await writeTag(runtime, alice, supervisor, "B_Running", false, "GATEWAY").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((refused as { details: { rule: string } }).details.rule).toBe("tag-read-only");
  }, 60_000);

  it("shows the link disconnected while the server is stopped, keeps the last value, and recovers", async () => {
    await stopPlc(runtime, alice, machine);
    expect(await quality("DISCONNECTED")).toBe("DISCONNECTED");
    const frozen = Number(await read(supervisor, "B_Counter"));
    await sleep(800);
    expect(Number(await read(supervisor, "B_Counter"))).toBe(frozen);
    // The supervisor itself keeps running; one failed link stops nothing else.
    expect(await read(supervisor, "Gw_Start")).toBe(true);

    expect(await startPlc(runtime, alice, machine)).toEqual({ state: "RUNNING" });
    expect(await quality("GOOD", 40_000)).toBe("GOOD");
    // The command is delivered again and the machine counts on.
    expect(await until(machine, "Running", (value) => value === true, 30_000)).toBe(true);
    expect(Number(await until(supervisor, "B_Counter", (value) => Number(value) > 3, 30_000))).toBeGreaterThan(3);
    const types = (await listEvents(db, alice, factoryId, { limit: 200 })).filter(
      (event) => event.payload.link === "plc-link",
    );
    expect(types.map((event) => event.type)).toEqual(expect.arrayContaining(["CONNECTION_DOWN", "CONNECTION_UP"]));
    stopPlcLinkMonitor(links, factoryId);
  }, 120_000);
});
