// @vitest-environment node
import { randomUUID } from "node:crypto";
import type Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadCatalog } from "@/lib/catalog";
import { ingestCatalog } from "@/lib/catalog/ingest";
import { createDockerClient } from "@/lib/docker/client";
import { DEFAULT_LIMITS } from "@/lib/docker/policy";
import { RUNTIME_IMAGES } from "@/lib/docker/runtime-images";
import { EventBus } from "@/lib/events/bus";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { EMPTY_OPERATION_STATE } from "@/lib/plc/operation-state";
import { DeviceSimulatorRuntime } from "@/lib/runtimes/device-sim/runtime";
import { TagMonitorRuntime } from "@/lib/runtimes/tag-monitor/monitor";
import { createFactory } from "@/lib/services/factory-service";
import { addPeripheral, createPlc } from "@/lib/services/plc-config-service";
import type { RuntimeDeps } from "@/lib/services/plc-runtime-service";
import {
  getPlcProgramView,
  getPlcRuntimeView,
  getPlcVersionsView,
  readLivePlcState,
} from "@/lib/services/plc-runtime-view-service";
import { getSimulationView, type SimulationDeps } from "@/lib/services/simulation-service";
import { cidrsOverlap } from "@/lib/validation/network";
import { openTestDb, resetDb } from "./harness";

/**
 * A PLC configured from the catalog, programmed, started, deployed to, simulated, stopped
 * and removed through the same server actions its screens call, on a real OpenPLC
 * runtime. Needs TEST_DATABASE_URL and TEST_DOCKER=1.
 */
const enabled = process.env.TEST_DOCKER === "1" && Boolean(process.env.TEST_DATABASE_URL);
const describeRuntime = enabled ? describe : describe.skip;

const RUN_LABEL = "zfactory.test-run";
const runId = randomUUID();
const alice = { ownerId: "alice" };

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  runtimeDeps: undefined as unknown,
  simulationDeps: undefined as unknown,
  liveDeps: undefined as unknown,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db/client", async (original) => ({ ...(await original<object>()), getDb: () => state.db }));
vi.mock("@/lib/auth/actor", () => ({ requireActor: async () => ({ ownerId: "alice" }) }));
vi.mock("@/lib/services/runtime-deps", () => ({
  getRuntimeDeps: () => state.runtimeDeps,
  getSimulationDeps: () => state.simulationDeps,
  getLiveDeps: () => state.liveDeps,
}));

const plcActions = await import("@/app/factories/[factoryId]/plcs/runtime-actions");
const simulatorActions = await import("@/app/factories/[factoryId]/simulator/actions");

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function freeSubnet(docker: Docker): Promise<string> {
  const used = (await docker.listNetworks()).flatMap((network) =>
    (network.IPAM?.Config ?? []).map((config) => config.Subnet).filter((subnet): subnet is string => Boolean(subnet)),
  );
  for (let third = 1; third < 20; third += 1) {
    const candidate = `10.215.${third}.0/28`;
    if (!used.some((subnet) => !subnet.includes(":") && cidrsOverlap(candidate, subnet))) return candidate;
  }
  throw new Error("no free test subnet");
}

describeRuntime("a stored PLC operated from its screens on a real OpenPLC runtime", () => {
  let db: PrismaClient;
  let docker: Docker;
  let runtime: RuntimeDeps;
  let simulation: SimulationDeps;
  let monitor: TagMonitorRuntime;
  let factoryId: string;
  let plcId: string;
  let valveId: string;
  /** The starter program plus logic that cycles the valve between its limit switches. */
  let cycling: string;

  const program = (intent: string, sourceText: string) =>
    plcActions.programAction(factoryId, plcId, EMPTY_OPERATION_STATE, form({ intent, sourceText }));
  const operate = (operation: string) =>
    plcActions.runtimeAction(factoryId, plcId, EMPTY_OPERATION_STATE, form({ operation }));
  const simulate = (operation: string) =>
    simulatorActions.simulationAction(factoryId, EMPTY_OPERATION_STATE, form({ operation }));
  const storedState = async () => (await db.deviceInstance.findUniqueOrThrow({ where: { id: plcId } })).runtimeStatus;
  const valve = async () =>
    (await getSimulationView(simulation, alice, factoryId)).devices.find((device) => device.deviceId === valveId);
  const position = async () => Number((await valve())?.outputs.find((signal) => signal.key === "position")?.value);

  async function until(condition: () => Promise<boolean>, timeoutMs = 20_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await condition()) return true;
      await sleep(200);
    }
    return condition();
  }

  beforeAll(async () => {
    db = openTestDb();
    state.db = db;
    await resetDb(db);
    await ingestCatalog(db, loadCatalog());
    docker = createDockerClient(process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock");
    runtime = {
      db,
      docker,
      policy: {
        images: RUNTIME_IMAGES,
        portRange: { min: 15600, max: 15699 },
        bindAddresses: ["127.0.0.1"],
        limits: DEFAULT_LIMITS,
        labels: { [RUN_LABEL]: runId },
      },
      runtimeSecret: "integration-test-runtime-secret-0123456789",
    };
    simulation = { db, simulator: new DeviceSimulatorRuntime(), tickMs: 50, snapshotIntervalMs: 2000 };
    state.runtimeDeps = runtime;
    state.simulationDeps = simulation;
    monitor = new TagMonitorRuntime();
    state.liveDeps = { db, bus: new EventBus(), monitor, simulator: simulation.simulator, pollMs: 200 };

    const modelId = async (modelName: string) => (await db.deviceModel.findFirstOrThrow({ where: { modelName } })).id;
    factoryId = (
      await createFactory(db, alice, {
        name: "Valve Station",
        slug: "valve-station",
        subnetCidr: await freeSubnet(docker),
      })
    ).id;
    plcId = (
      await createPlc(db, alice, { factoryId, deviceModelId: await modelId("CPU 1214C DC/DC/DC"), name: "PLC-01" })
    ).id;
    await addPeripheral(db, alice, plcId, {
      deviceModelId: await modelId("Generic on/off valve, 24 V DC"),
      name: "XV-101",
    });
    valveId = (await db.deviceInstance.findFirstOrThrow({ where: { factoryId, name: "XV-101" } })).id;

    const starter = (await getPlcProgramView(db, alice, plcId)).source;
    cycling = starter
      .replace("    Scans : DINT;", "    Scans : DINT;\n    Opening : BOOL := TRUE;")
      .replace(
        "Scans := Scans + 1;",
        [
          "Scans := Scans + 1;",
          "  IF XV_101_ZSC THEN Opening := TRUE; END_IF;",
          "  IF XV_101_ZSO THEN Opening := FALSE; END_IF;",
          "  XV_101_Y1 := Opening;",
        ].join("\n"),
      );
    expect(cycling).toContain("XV_101_Y1 := Opening;");
  }, 120_000);

  afterAll(async () => {
    await simulation.simulator.stopAll();
    await monitor.stopAll();
    const filters = { label: [`${RUN_LABEL}=${runId}`] };
    for (const container of await docker.listContainers({ all: true, filters })) {
      await docker.getContainer(container.Id).remove({ force: true, v: true });
    }
    for (const network of await docker.listNetworks({ filters })) {
      await docker.getNetwork(network.Id).remove();
    }
    await db.$disconnect();
  }, 120_000);

  it("starts a runtime whose selected program does not compile, and does not stay on STARTING", async () => {
    await program("save", cycling.replace("XV_101_Y1 := Opening;", "XV_101_Y1 := Unknown;"));
    const started = await operate("start");
    expect(started.message).toBe("The program does not compile.");
    expect(started.diagnostics).toEqual([expect.objectContaining({ severity: "error" })]);
    // The container is up with no program: degraded, not a start that never ends.
    expect(await storedState()).toBe("DEGRADED");
    const view = await getPlcRuntimeView(db, alice, plcId);
    expect(view).toMatchObject({ created: true, selectedProgram: { version: 1, status: "FAILED" } });
    expect(view.events.map((event) => event.type)).toContain("PLC_PROGRAM_DEPLOY_FAILED");
  }, 300_000);

  it("saves and deploys a program from the editor and shows the runtime without Docker details", async () => {
    expect(await program("deploy", cycling)).toEqual({
      notice: "Saved as version 2 and deployed. The PLC is running it.",
      savedVersion: 2,
    });
    expect(await readLivePlcState(db, () => runtime, alice, plcId)).toEqual({ liveError: null });
    const view = await getPlcRuntimeView(db, alice, plcId);
    expect(view).toMatchObject({
      state: "RUNNING",
      created: true,
      serviceName: "plc-01",
      selectedProgram: { version: 2, status: "DEPLOYED" },
      deployedProgram: { version: 2 },
      modbus: { bindAddress: "127.0.0.1" },
    });
    expect(view.runtimeVersion).toMatch(/^OpenPLC Runtime /);

    const device = await db.deviceInstance.findUniqueOrThrow({ where: { id: plcId }, include: { plcProfile: true } });
    const rendered = JSON.stringify([view, await getPlcVersionsView(db, alice, plcId)]);
    expect(device.dockerContainerId).toMatch(/^[0-9a-f]{64}$/);
    expect(rendered).not.toContain(device.dockerContainerId);
    expect(rendered).not.toContain(String(device.dockerContainerId).slice(0, 12));
    expect(rendered).not.toContain(String(device.plcProfile?.apiHostPort));
    expect(rendered).not.toContain("docker.sock");
  }, 300_000);

  it("runs the device simulation: the program moves the valve and the valve's feedback turns it around", async () => {
    expect(await simulate("start")).toEqual({ notice: "The simulation is running 1 device." });
    const openCommand = async () => (await valve())?.inputs.find((signal) => signal.key === "open")?.value;
    // The program opens the valve...
    expect(await until(async () => (await position()) > 20)).toBe(true);
    expect(await openCommand()).toBe(true);
    // ...drops the command once the open limit switch has reached it, so the valve closes again...
    expect(await until(async () => (await openCommand()) === false, 15_000)).toBe(true);
    expect(await until(async () => (await position()) < 80, 15_000)).toBe(true);
    // ...and opens it once more when the closed limit switch reports.
    expect(await until(async () => (await openCommand()) === true, 15_000)).toBe(true);
    expect(await simulate("stop")).toEqual({
      notice: "The simulation is stopped. The last device states were stored.",
    });
  }, 120_000);

  it("keeps the running program and its selection when a new one does not compile", async () => {
    const failed = await program("deploy", cycling.replace("Scans := Scans + 1;", "Scans := Nowhere + 1;"));
    expect(failed.message).toBe("The program does not compile.");
    expect(failed.diagnostics?.[0]).toMatchObject({ severity: "error", line: expect.any(Number) });

    const versions = (await getPlcVersionsView(db, alice, plcId)).versions;
    expect(versions.map((version) => [version.version, version.status, version.selected])).toEqual([
      [3, "FAILED", false],
      [2, "DEPLOYED", true],
      [1, "FAILED", false],
    ]);
    expect(await operate("refresh")).toEqual({ notice: "The runtime reports: running." });
  }, 300_000);

  it("stops, restarts and removes the runtime; a stopped runtime does not read back as faulted", async () => {
    expect(monitor.isRunning(plcId)).toBe(true);
    // The runtime that was up without a program did not answer on Modbus: that was a lost connection.
    const lostBefore = await db.runtimeEvent.count({ where: { factoryId, type: "CONNECTION_DOWN" } });
    expect(await operate("stop")).toEqual({ notice: "The runtime is stopped. Its container and program are kept." });
    // Its tags are no longer read, and going down on purpose is not reported as one.
    expect(monitor.isRunning(plcId)).toBe(false);
    expect(await db.runtimeEvent.count({ where: { factoryId, type: "CONNECTION_DOWN" } })).toBe(lostBefore);
    expect(await db.alarmEvent.count({ where: { factoryId, code: "PLC_LINK_DOWN", clearedAt: null } })).toBe(0);
    // The container ended with the stop signal's exit code: that is a stop, not a fault.
    expect(await operate("refresh")).toEqual({ notice: "The runtime reports: stopped." });
    expect(await readLivePlcState(db, () => runtime, alice, plcId)).toEqual({ liveError: null });
    expect(await storedState()).toBe("STOPPED");

    const started = await operate("start");
    expect(started).toEqual({ notice: "The runtime is started: running." });
    const restarted = await operate("restart");
    expect(restarted.message).toBeUndefined();
    expect(await until(async () => (await operate("refresh")).notice === "The runtime reports: running.", 60_000)).toBe(
      true,
    );

    expect(await operate("remove")).toEqual({
      notice: "The runtime is removed. Program versions and the Modbus endpoint are kept.",
    });
    const view = await getPlcRuntimeView(db, alice, plcId);
    expect(view).toMatchObject({ state: "STOPPED", created: false, deployedProgram: { version: 2 } });
    expect(view.modbus).not.toBeNull();
    expect(await docker.listContainers({ all: true, filters: { label: [`${RUN_LABEL}=${runId}`] } })).toEqual([]);
  }, 300_000);
});
