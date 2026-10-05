// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { loadCatalog } from "@/lib/catalog";
import { ingestCatalog } from "@/lib/catalog/ingest";
import { plcRepository } from "@/lib/db/repositories/plc-repository";
import { DomainError, type DomainErrorCode } from "@/lib/domain/errors";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { DeviceSimulatorRuntime } from "@/lib/runtimes/device-sim/runtime";
import { createFactory } from "@/lib/services/factory-service";
import { addPeripheral, createPlc } from "@/lib/services/plc-config-service";
import {
  checkProgram,
  createProgramVersion,
  type RuntimeDeps,
  selectProgramVersion,
} from "@/lib/services/plc-runtime-service";
import {
  getPlcProgramView,
  getPlcRuntimeView,
  getPlcVersionsView,
  readLivePlcState,
} from "@/lib/services/plc-runtime-view-service";
import {
  getSimulationView,
  injectDeviceFault,
  type SimulationDeps,
  startFactorySimulation,
  stopFactorySimulation,
} from "@/lib/services/simulation-service";
import { describeDb, openTestDb, resetDb } from "./harness";
import { startTestPlc, type TestPlc } from "./modbus-server";

const alice = { ownerId: "alice" };
const bob = { ownerId: "bob" };

async function expectDomainError(action: Promise<unknown>, code: DomainErrorCode, rule?: string) {
  const error = await action.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe(code);
  if (rule) expect((error as DomainError).details.rule).toBe(rule);
}

/**
 * The read models behind the Program, Versions, Runtime and Simulator screens of a stored
 * PLC, against PostgreSQL and the real compiler. An in-process Modbus server stands in
 * for the running PLC; the screens with a real OpenPLC runtime are covered by
 * plc-runtime-screens-docker.test.ts.
 */
describeDb("program, versions, runtime and simulator read models", () => {
  let db: PrismaClient;
  let plc: TestPlc;
  let simulation: SimulationDeps;
  let factoryId: string;
  let plcId: string;
  let valveId: string;

  const modelId = async (modelName: string) => (await db.deviceModel.findFirstOrThrow({ where: { modelName } })).id;
  const noDeps = (): RuntimeDeps => {
    throw new Error("the runtime must not be asked");
  };

  beforeAll(async () => {
    db = openTestDb();
    plc = await startTestPlc();
    await resetDb(db);
    await ingestCatalog(db, loadCatalog());
  });
  beforeEach(async () => {
    await db.factory.deleteMany();
    plc.coils.fill(false);
    plc.holding.fill(0);
    simulation = { db, simulator: new DeviceSimulatorRuntime(), tickMs: 100 };
    factoryId = (await createFactory(db, alice, { name: "Line", slug: "line", subnetCidr: "172.22.1.0/24" })).id;
    plcId = (
      await createPlc(db, alice, { factoryId, deviceModelId: await modelId("CPU 1214C DC/DC/DC"), name: "PLC-01" })
    ).id;
    await addPeripheral(db, alice, plcId, {
      deviceModelId: await modelId("Generic on/off valve, 24 V DC"),
      name: "XV-101",
    });
    valveId = (await db.deviceInstance.findFirstOrThrow({ where: { factoryId, name: "XV-101" } })).id;
  });
  afterAll(async () => {
    await plc.close();
    await db.$disconnect();
  });

  it("opens a new PLC with a starter program that declares its tags and compiles", async () => {
    const view = await getPlcProgramView(db, alice, plcId);
    expect(view).toMatchObject({ versions: [], sourceVersion: null });
    expect(view.locatedVariables).toEqual([
      { name: "XV_101_ZSC", address: "%MX0.0", type: "BOOL", source: "XV-101 · closed" },
      { name: "XV_101_ZSO", address: "%MX0.1", type: "BOOL", source: "XV-101 · opened" },
      { name: "XV_101_Y1", address: "%QX0.0", type: "BOOL", source: "XV-101 · open" },
    ]);
    expect(view.source).toContain("PROGRAM plc_01");
    expect(view.source).toContain("XV_101_Y1  AT %QX0.0 : BOOL; (* XV-101 · open *)");
    expect(await checkProgram(db, alice, plcId, { sourceText: view.source })).toEqual({
      success: true,
      errors: [],
      warnings: [],
    });
  });

  it("reports where a program does not compile, without saving anything", async () => {
    const { source } = await getPlcProgramView(db, alice, plcId);
    const broken = source.replace("Scans := Scans + 1;", "Scans := Scans + ;");
    const line = broken.split("\n").findIndex((text) => text.includes("Scans := Scans + ;")) + 1;
    const result = await checkProgram(db, alice, plcId, { sourceText: broken });
    expect(result.success).toBe(false);
    expect(result.errors).toEqual([
      {
        message: expect.stringContaining("Unexpected"),
        line,
        column: "  Scans := Scans + ;".length,
        severity: "error",
      },
    ]);
    expect(await db.programVersion.count()).toBe(0);
    await expectDomainError(checkProgram(db, alice, plcId, { sourceText: "  \n" }), "VALIDATION", "program-source");
  });

  it("opens the selected version, or the one asked for, and lets an earlier one be selected again", async () => {
    const first = await createProgramVersion(db, alice, plcId, { sourceText: "(* one *)" });
    const second = await createProgramVersion(db, alice, plcId, { sourceText: "(* two *)" });

    expect(await getPlcProgramView(db, alice, plcId)).toMatchObject({ source: "(* two *)", sourceVersion: 2 });
    expect(await getPlcProgramView(db, alice, plcId, { version: 1 })).toMatchObject({
      source: "(* one *)",
      sourceVersion: 1,
    });
    // A version that does not exist falls back to the selected one.
    expect((await getPlcProgramView(db, alice, plcId, { version: 9 })).sourceVersion).toBe(2);

    expect(await selectProgramVersion(db, alice, plcId, first.id)).toEqual({ version: 1 });
    const view = await getPlcVersionsView(db, alice, plcId);
    expect(view.versions.map((version) => [version.version, version.status, version.selected])).toEqual([
      [2, "DRAFT", false],
      [1, "DRAFT", true],
    ]);
    expect(view.versions[0]?.id).toBe(second.id);
    expect((await getPlcProgramView(db, alice, plcId)).sourceVersion).toBe(1);

    // A version of another PLC cannot be selected.
    const otherPlc = await createPlc(db, alice, {
      factoryId,
      deviceModelId: await modelId("CPU 1214C DC/DC/DC"),
      name: "PLC-02",
    });
    await expectDomainError(selectProgramVersion(db, alice, otherPlc.id, first.id), "NOT_FOUND");
  });

  it("lists deployment snapshots newest first and tolerates an unreadable one", async () => {
    const record = (snapshotJson: Record<string, string | number | string[]>) =>
      plcRepository.recordConfigurationSnapshot(db, { factoryId, deviceId: plcId, createdBy: "alice", snapshotJson });
    await record({
      programVersion: 1,
      programChecksum: "abc",
      compiler: "STruC++ 0.7.0",
      ioMappingVersion: 2,
      modbusMappingVersion: 4,
      runtime: "OpenPLC Runtime v4.2.4",
      tags: ["a", "b"],
    });
    await record({ programVersion: "not a number" });

    const view = await getPlcVersionsView(db, alice, plcId);
    expect(view.runtimeCreated).toBe(false);
    expect(view.deployments).toEqual([
      expect.objectContaining({ version: 2, programVersion: null, compiler: null, tagCount: null }),
      expect.objectContaining({
        version: 1,
        programVersion: 1,
        programChecksum: "abc",
        compiler: "STruC++ 0.7.0",
        ioMappingVersion: 2,
        modbusMappingVersion: 4,
        runtime: "OpenPLC Runtime v4.2.4",
        tagCount: 2,
      }),
    ]);
  });

  it("shows the stored runtime without its container id or management port", async () => {
    expect(await getPlcRuntimeView(db, alice, plcId)).toMatchObject({
      state: "STOPPED",
      created: false,
      serviceName: null,
      modbus: null,
      selectedProgram: null,
      deployedProgram: null,
      liveError: null,
    });

    const containerId = "c0ffee".repeat(10) + "beef";
    await plcRepository.setDeviceRuntime(db, plcId, {
      dockerContainerId: containerId,
      hostName: "plc-01",
      runtimeStatus: "FAULTED",
    });
    await plcRepository.setRuntimeMetadata(db, plcId, {
      apiHostPort: 15951,
      runtimeImage: "ghcr.io/example/openplc-runtime:v4@sha256:1234",
      runtimeVersion: "OpenPLC Runtime v4.2.4",
    });
    await plcRepository.replaceModbusPort(db, plcId, { containerPort: 502, hostPort: 15950, bindAddress: "127.0.0.1" });
    const version = await createProgramVersion(db, alice, plcId, { sourceText: "(* one *)" });
    await plcRepository.setProgramStatus(db, version.id, "DEPLOYED");
    await plcRepository.recordEvent(db, {
      factoryId,
      deviceId: plcId,
      type: "DEVICE_FAULTED",
      severity: "CRITICAL",
      payloadJson: { action: "start", code: "RUNTIME_FAILURE", rule: "runtime-start-timeout", log: ["/workdir/x"] },
    });

    const view = await getPlcRuntimeView(db, alice, plcId, { liveError: "The Docker Engine is not reachable." });
    expect(view).toMatchObject({
      state: "FAULTED",
      created: true,
      serviceName: "plc-01",
      runtimeVersion: "OpenPLC Runtime v4.2.4",
      image: "ghcr.io/example/openplc-runtime:v4@sha256:1234",
      modbus: { bindAddress: "127.0.0.1", hostPort: 15950 },
      selectedProgram: { version: 1, status: "DEPLOYED" },
      deployedProgram: { version: 1 },
      liveError: "The Docker Engine is not reachable.",
    });
    expect(view.events[0]).toMatchObject({
      type: "DEVICE_FAULTED",
      severity: "CRITICAL",
      detail: "action start · code RUNTIME_FAILURE · rule runtime-start-timeout",
    });
    const rendered = JSON.stringify([view, await getPlcVersionsView(db, alice, plcId)]);
    expect(rendered).not.toContain(containerId);
    expect(rendered).not.toContain("15951");
    expect(rendered).not.toContain("/workdir");
  });

  it("asks the runtime for its state only when there is one, and never fails the page over it", async () => {
    // No runtime yet: nothing to ask, and the runtime dependencies are not even resolved.
    expect(await readLivePlcState(db, noDeps, alice, plcId)).toEqual({ liveError: null });

    await plcRepository.setDeviceRuntime(db, plcId, { dockerContainerId: "abc", runtimeStatus: "STARTING" });
    // A start is in progress: its own result is awaited instead.
    expect(await readLivePlcState(db, noDeps, alice, plcId)).toEqual({ liveError: null });

    await plcRepository.setDeviceRuntime(db, plcId, { runtimeStatus: "RUNNING" });
    const unconfigured = vi.fn((): RuntimeDeps => {
      throw new DomainError("RUNTIME_FAILURE", "RUNTIME_SECRET is not configured for this deployment.");
    });
    expect(await readLivePlcState(db, unconfigured, alice, plcId)).toEqual({
      liveError: "RUNTIME_SECRET is not configured for this deployment.",
    });
    expect(unconfigured).toHaveBeenCalledOnce();
    const unexpected = (): RuntimeDeps => {
      throw new Error("connect ENOENT /var/run/docker.sock");
    };
    expect(await readLivePlcState(db, unexpected, alice, plcId)).toEqual({
      liveError: "The live state could not be read.",
    });
    // The stored state is untouched.
    expect((await getPlcRuntimeView(db, alice, plcId)).state).toBe("RUNNING");
  });

  it("treats the PLC of another owner as not found on every screen", async () => {
    await expectDomainError(getPlcProgramView(db, bob, plcId), "NOT_FOUND");
    await expectDomainError(getPlcVersionsView(db, bob, plcId), "NOT_FOUND");
    await expectDomainError(getPlcRuntimeView(db, bob, plcId), "NOT_FOUND");
    await expectDomainError(readLivePlcState(db, noDeps, bob, plcId), "NOT_FOUND");
    await expectDomainError(checkProgram(db, bob, plcId, { sourceText: "x" }), "NOT_FOUND");
    await expectDomainError(getSimulationView(simulation, bob, factoryId), "NOT_FOUND");
  });

  it("shows what would be simulated and what stands in the way before the PLC was ever started", async () => {
    const view = await getSimulationView(simulation, alice, factoryId);
    expect(view).toMatchObject({
      running: false,
      ticks: null,
      lastError: null,
      blocker: "Start PLC-01 first: its Modbus endpoint is not configured yet.",
      plcs: [{ id: plcId, name: "PLC-01", runtimeStatus: "STOPPED", endpointReady: false }],
    });
    const valve = view.devices.find((device) => device.deviceId === valveId);
    expect(valve).toMatchObject({ name: "XV-101", type: "VALVE", state: null, faulted: false, quality: null });
    // Command signals and feedback signals are separate lists, each with the tag it is wired to.
    expect(valve?.inputs.map((signal) => [signal.key, signal.value, signal.tag])).toEqual([
      ["open", null, "PLC-01 · XV_101_Y1"],
      ["close", null, null],
      ["positionSetpoint", null, null],
      ["faultReset", null, null],
    ]);
    expect(valve?.outputs.map((signal) => [signal.key, signal.tag])).toEqual([
      ["position", null],
      ["opened", "PLC-01 · XV_101_ZSO"],
      ["closed", "PLC-01 · XV_101_ZSC"],
      ["faulted", null],
    ]);
    expect(valve?.faults).toEqual([{ code: "STUCK", name: "Stuck", latching: false, active: false }]);
  });

  it("shows live commands, feedback and injected faults while the simulation runs", async () => {
    await db.runtimePort.create({
      data: { deviceInstanceId: plcId, protocol: "MODBUS_TCP", containerPort: 502, hostPort: plc.port },
    });
    expect((await getSimulationView(simulation, alice, factoryId)).blocker).toBeNull();
    await startFactorySimulation(simulation, alice, factoryId, { autoTick: false });

    // The PLC program energizes the valve's output; the valve travels for 5 s.
    plc.coils[0] = true;
    for (let step = 0; step < 20; step += 1) await simulation.simulator.tick(factoryId, 100);
    let view = await getSimulationView(simulation, alice, factoryId);
    let valve = view.devices.find((device) => device.deviceId === valveId);
    expect(view).toMatchObject({ running: true, ticks: 20, tickMs: 100, blocker: null, lastError: null });
    expect(valve?.inputs.find((signal) => signal.key === "open")?.value).toBe(true);
    expect(valve?.outputs.find((signal) => signal.key === "position")?.value).toBeCloseTo(40, 0);
    expect(valve?.state).not.toBeNull();

    await injectDeviceFault(simulation, alice, valveId, "STUCK");
    for (let step = 0; step < 20; step += 1) await simulation.simulator.tick(factoryId, 100);
    view = await getSimulationView(simulation, alice, factoryId);
    valve = view.devices.find((device) => device.deviceId === valveId);
    expect(valve).toMatchObject({ faulted: true, faults: [expect.objectContaining({ code: "STUCK", active: true })] });
    // A stuck valve does not move, whatever the PLC commands.
    expect(valve?.outputs.find((signal) => signal.key === "position")?.value).toBeCloseTo(40, 0);

    await stopFactorySimulation(simulation, alice, factoryId);
    expect(await getSimulationView(simulation, alice, factoryId)).toMatchObject({ running: false, ticks: null });
  });

  it("says so when the factory has nothing to simulate", async () => {
    const empty = await createFactory(db, alice, { name: "Empty", slug: "empty", subnetCidr: "172.22.2.0/24" });
    expect(await getSimulationView(simulation, alice, empty.id)).toMatchObject({
      running: false,
      devices: [],
      plcs: [],
      blocker: "This factory has no devices the simulator can run.",
    });
  });
});
