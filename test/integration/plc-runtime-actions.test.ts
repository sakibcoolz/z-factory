// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { loadCatalog } from "@/lib/catalog";
import { ingestCatalog } from "@/lib/catalog/ingest";
import { createDockerClient } from "@/lib/docker/client";
import { DEFAULT_LIMITS } from "@/lib/docker/policy";
import { RUNTIME_IMAGES } from "@/lib/docker/runtime-images";
import { DomainError } from "@/lib/domain/errors";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { EMPTY_OPERATION_STATE } from "@/lib/plc/operation-state";
import { DeviceSimulatorRuntime } from "@/lib/runtimes/device-sim/runtime";
import { createFactory } from "@/lib/services/factory-service";
import { addPeripheral, createPlc } from "@/lib/services/plc-config-service";
import type { RuntimeDeps } from "@/lib/services/plc-runtime-service";
import { getPlcProgramView, getPlcVersionsView } from "@/lib/services/plc-runtime-view-service";
import { getSimulationView, type SimulationDeps } from "@/lib/services/simulation-service";
import { describeDb, openTestDb, resetDb } from "./harness";
import { startTestPlc, type TestPlc } from "./modbus-server";

/**
 * The program, runtime and simulator server actions with their real services, database
 * and compiler. Only the request plumbing is replaced. No Docker Engine is involved:
 * these are the paths that must answer without one. The full lifecycle on a real
 * runtime is in plc-runtime-screens-docker.test.ts.
 */
const state = vi.hoisted(() => ({
  db: undefined as unknown,
  actor: { ownerId: "alice" },
  runtimeDeps: (() => {
    throw new Error("not set");
  }) as () => unknown,
  simulationDeps: undefined as unknown,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db/client", async (original) => ({ ...(await original<object>()), getDb: () => state.db }));
vi.mock("@/lib/auth/actor", () => ({ requireActor: async () => state.actor }));
vi.mock("@/lib/services/runtime-deps", () => ({
  getRuntimeDeps: () => state.runtimeDeps(),
  getSimulationDeps: () => state.simulationDeps,
}));

const plcActions = await import("@/app/factories/[factoryId]/plcs/runtime-actions");
const simulatorActions = await import("@/app/factories/[factoryId]/simulator/actions");

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

describeDb("program, runtime and simulator server actions", () => {
  let db: PrismaClient;
  let plc: TestPlc;
  let simulation: SimulationDeps;
  let factoryId: string;
  let plcId: string;
  let valveId: string;
  let starter: string;
  const alice = { ownerId: "alice" };

  const modelId = async (modelName: string) => (await db.deviceModel.findFirstOrThrow({ where: { modelName } })).id;
  const program = (fields: Record<string, string>) =>
    plcActions.programAction(factoryId, plcId, EMPTY_OPERATION_STATE, form(fields));
  const runtime = (operation: string) =>
    plcActions.runtimeAction(factoryId, plcId, EMPTY_OPERATION_STATE, form({ operation }));
  const simulate = (operation: string) =>
    simulatorActions.simulationAction(factoryId, EMPTY_OPERATION_STATE, form({ operation }));
  const fault = (operation: string) =>
    simulatorActions.deviceFaultAction(factoryId, valveId, EMPTY_OPERATION_STATE, form({ operation }));

  beforeAll(async () => {
    db = openTestDb();
    state.db = db;
    plc = await startTestPlc();
    await resetDb(db);
    await ingestCatalog(db, loadCatalog());
  });
  beforeEach(async () => {
    state.actor = alice;
    await db.factory.deleteMany();
    simulation = { db, simulator: new DeviceSimulatorRuntime(), tickMs: 100 };
    state.simulationDeps = simulation;
    // A Docker client that is never connected: nothing in this file may reach an engine.
    const deps: RuntimeDeps = {
      db,
      docker: createDockerClient("unix:///nonexistent/docker.sock"),
      policy: {
        images: RUNTIME_IMAGES,
        portRange: { min: 15900, max: 15949 },
        bindAddresses: ["127.0.0.1"],
        limits: DEFAULT_LIMITS,
        labels: {},
      },
      runtimeSecret: "integration-test-runtime-secret-0123456789",
    };
    state.runtimeDeps = () => deps;

    factoryId = (await createFactory(db, alice, { name: "Line", slug: "line", subnetCidr: "172.22.1.0/24" })).id;
    plcId = (
      await createPlc(db, alice, { factoryId, deviceModelId: await modelId("CPU 1214C DC/DC/DC"), name: "PLC-01" })
    ).id;
    await addPeripheral(db, alice, plcId, {
      deviceModelId: await modelId("Generic on/off valve, 24 V DC"),
      name: "XV-101",
    });
    valveId = (await db.deviceInstance.findFirstOrThrow({ where: { factoryId, name: "XV-101" } })).id;
    starter = (await getPlcProgramView(db, alice, plcId)).source;
  });
  afterAll(async () => {
    await plc.close();
    await db.$disconnect();
  });

  it("checks a program without saving it and returns the compiler's findings", async () => {
    expect(await program({ intent: "check", sourceText: starter })).toEqual({
      notice: "The program compiles. Nothing was saved.",
      diagnostics: [],
    });
    const broken = await program({ intent: "check", sourceText: starter.replace("Scans + 1", "Missing + 1") });
    expect(broken.message).toBe("The program does not compile.");
    expect(broken.diagnostics).toEqual([
      expect.objectContaining({ severity: "error", message: expect.stringMatching(/MISSING/i) }),
    ]);
    expect(await db.programVersion.count()).toBe(0);
  });

  it("saves a version with LF line ends, whatever the browser submitted", async () => {
    const saved = await program({ intent: "save", sourceText: starter.replace(/\n/g, "\r\n") });
    expect(saved).toEqual({
      notice: "Saved as version 1. It is used by the next start or deploy.",
      savedVersion: 1,
    });
    const view = await getPlcProgramView(db, alice, plcId);
    expect(view).toMatchObject({ source: starter, sourceVersion: 1 });
    expect(view.versions).toEqual([expect.objectContaining({ version: 1, status: "DRAFT", selected: true })]);

    expect(await program({ intent: "save", sourceText: "   " })).toEqual({ message: "The program source is empty." });
    expect(await program({ intent: "format", sourceText: starter })).toEqual({ message: "Unknown program action." });
    expect(await db.programVersion.count()).toBe(1);
  });

  it("does not save anything when deploying is impossible because the runtime was never started", async () => {
    expect(await program({ intent: "deploy", sourceText: starter })).toEqual({
      message: "The PLC runtime has not been started.",
    });
    expect(await db.programVersion.count()).toBe(0);
  });

  it("selects an earlier version for the next start and refuses versions that are not this PLC's", async () => {
    await program({ intent: "save", sourceText: starter });
    await program({ intent: "save", sourceText: starter.replace("Scans + 1", "Scans + 2") });
    const [second, first] = (await getPlcVersionsView(db, alice, plcId)).versions;
    expect([first?.selected, second?.selected]).toEqual([false, true]);

    const act = (versionId: string, operation: string) =>
      plcActions.programVersionAction(factoryId, plcId, versionId, EMPTY_OPERATION_STATE, form({ operation }));
    expect(await act(first?.id ?? "", "select")).toEqual({
      notice: "Version 1 is used by the next start or deploy.",
    });
    expect((await getPlcVersionsView(db, alice, plcId)).versions.map((version) => version.selected)).toEqual([
      false,
      true,
    ]);
    expect(await act(first?.id ?? "", "deploy")).toEqual({ message: "The PLC runtime has not been started." });
    expect(await act("not-a-uuid", "select")).toEqual({ message: "The program version does not exist." });
    expect(await act("018f6f2e-0000-7000-8000-000000000000", "select")).toEqual({
      message: "The program version does not exist.",
    });
    expect(await act(first?.id ?? "", "archive")).toEqual({ message: "Unknown version operation." });
  });

  it("answers runtime operations that cannot run with their reason instead of failing", async () => {
    for (const operation of ["stop", "restart", "deploy"]) {
      expect(await runtime(operation)).toEqual({
        message:
          operation === "deploy"
            ? "The PLC has no program version to deploy."
            : "The PLC runtime has not been started.",
      });
    }
    expect(await runtime("explode")).toEqual({ message: "Unknown runtime operation." });
    // Without a runtime there is nothing to ask: the state is stopped.
    expect(await runtime("refresh")).toEqual({ notice: "The runtime reports: stopped." });
    expect(await runtime("remove")).toEqual({
      notice: "The runtime is removed. Program versions and the Modbus endpoint are kept.",
    });
  });

  it("reports an unreachable Docker Engine on start, marks the PLC faulted and leaks no host detail", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await runtime("start");
    expect(result).toEqual({ message: "The Docker Engine is not reachable." });
    expect(JSON.stringify(result)).not.toContain("docker.sock");
    // The failure is visible afterwards too: state and a critical event.
    const device = await db.deviceInstance.findUniqueOrThrow({ where: { id: plcId } });
    expect(device.runtimeStatus).toBe("FAULTED");
    const events = await db.runtimeEvent.findMany({ where: { deviceId: plcId }, orderBy: { occurredAt: "asc" } });
    expect(events.map((event) => [event.type, event.severity]).slice(-2)).toEqual([
      ["DEVICE_STARTING", "INFO"],
      ["DEVICE_FAULTED", "CRITICAL"],
    ]);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("returns a deployment that is not configured, and unexpected failures, as messages", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.runtimeDeps = () => {
      throw new DomainError("RUNTIME_FAILURE", "RUNTIME_SECRET is not configured for this deployment.");
    };
    expect(await runtime("start")).toEqual({ message: "RUNTIME_SECRET is not configured for this deployment." });
    state.runtimeDeps = () => {
      throw new Error("connect ENOENT /var/run/docker.sock");
    };
    expect(await runtime("start")).toEqual({ message: "Something went wrong. Try again." });
    log.mockRestore();
  });

  it("treats the PLC and factory of another owner as not found", async () => {
    state.actor = { ownerId: "bob" };
    expect(await program({ intent: "save", sourceText: starter })).toEqual({ message: "The PLC does not exist." });
    expect(await program({ intent: "check", sourceText: starter })).toEqual({ message: "The PLC does not exist." });
    expect(await runtime("start")).toEqual({ message: "The PLC does not exist." });
    expect(await simulate("start")).toEqual({ message: "The factory does not exist." });
    expect(await fault("inject:STUCK")).toEqual({ message: "The device does not exist." });
    expect(await db.programVersion.count()).toBe(0);
  });

  it("starts the simulation only once the PLC has an endpoint, and operates faults while it runs", async () => {
    expect(await simulate("start")).toEqual({
      message: "Start PLC-01 first: its Modbus endpoint is not configured yet.",
    });
    expect(await fault("inject:STUCK")).toEqual({
      message: "The device simulation of this factory is not running.",
    });

    await db.runtimePort.create({
      data: { deviceInstanceId: plcId, protocol: "MODBUS_TCP", containerPort: 502, hostPort: plc.port },
    });
    expect(await simulate("start")).toEqual({ notice: "The simulation is running 1 device." });
    expect(await simulate("start")).toEqual({
      message: "The device simulation of this factory is already running.",
    });

    const valve = async () =>
      (await getSimulationView(simulation, alice, factoryId)).devices.find((device) => device.deviceId === valveId);
    expect(await fault("inject:STUCK")).toEqual({ notice: "Fault STUCK injected." });
    expect((await valve())?.faults).toEqual([expect.objectContaining({ code: "STUCK", active: true })]);
    expect(await fault("inject:NO_SUCH_FAULT")).toMatchObject({ message: expect.any(String) });
    expect(await fault("clear:STUCK")).toEqual({ notice: "Fault STUCK cleared." });
    expect((await valve())?.faults).toEqual([expect.objectContaining({ code: "STUCK", active: false })]);
    expect(await fault("reset")).toEqual({ notice: "Device reset." });
    expect(await fault("explode")).toEqual({ message: "Unknown device operation." });

    // Every operator action on the simulated equipment is recorded.
    const recorded = await db.runtimeEvent.findMany({ where: { deviceId: valveId }, orderBy: { occurredAt: "asc" } });
    expect(recorded.map((event) => event.type)).toEqual(
      expect.arrayContaining(["FAULT_INJECTED", "FAULT_CLEARED", "DEVICE_RESET"]),
    );

    expect(await simulate("stop")).toEqual({
      notice: "The simulation is stopped. The last device states were stored.",
    });
    expect(await simulate("stop")).toEqual({ message: "The device simulation of this factory is not running." });
    expect(await simulate("pause")).toEqual({ message: "Unknown simulation operation." });
  });
});
