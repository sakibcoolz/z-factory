// @vitest-environment node
import { randomUUID } from "node:crypto";
import type Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDockerClient } from "@/lib/docker/client";
import { DEFAULT_LIMITS } from "@/lib/docker/policy";
import { RUNTIME_IMAGES } from "@/lib/docker/runtime-images";
import type { DomainError } from "@/lib/domain/errors";
import { qualityAt } from "@/lib/domain/live";
import { EventBus } from "@/lib/events/bus";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { DeviceSimulatorRuntime } from "@/lib/runtimes/device-sim/runtime";
import { ProcessBridgeRuntime } from "@/lib/runtimes/process-bridge/runtime";
import { TagMonitorRuntime } from "@/lib/runtimes/tag-monitor/monitor";
import { connectDevices } from "@/lib/services/connection-service";
import { createDeviceInstance } from "@/lib/services/device-service";
import { createFactory } from "@/lib/services/factory-service";
import { getLiveTags, type LiveDeps, type LiveTagRow } from "@/lib/services/live-service";
import { createProgramVersion, type RuntimeDeps, startPlc } from "@/lib/services/plc-runtime-service";
import {
  getSimulationState,
  injectDeviceFault,
  clearDeviceFault,
  type SimulationDeps,
  startFactorySimulation,
  stopFactorySimulation,
} from "@/lib/services/simulation-service";
import { createTag, readTag, writeTag } from "@/lib/services/tag-service";
import { cidrsOverlap } from "@/lib/validation/network";
import { createGenericModel, openTestDb, resetDb } from "./harness";

/**
 * TASK-803: the program's outputs command simulated equipment, the equipment answers over
 * time, and its feedback returns to the program, which decides again. A line with a suction
 * valve and a drive: the program opens the valve on request and runs the drive only once
 * the valve's open limit switch proves it open. Then the simulation goes away and the
 * feedback says so, both to the program and on the Live Tags screen. Needs
 * TEST_DATABASE_URL and TEST_DOCKER=1.
 */
const enabled = process.env.TEST_DOCKER === "1" && Boolean(process.env.TEST_DATABASE_URL);
const describeRuntime = enabled ? describe : describe.skip;

const RUN_LABEL = "zfactory.test-run";
const runId = randomUUID();
const alice = { ownerId: "alice" };

const PROGRAM = `PROGRAM line
  VAR
    StartRequest AT %MX10.0 : BOOL;
    SpeedSetpoint AT %MW20 : INT;
    Valve_Open AT %QX0.0 : BOOL;
    Interlock AT %QX0.1 : BOOL;
    VFD_FrequencyRef AT %QW0 : INT;
    VFD_Run AT %MX1.0 : BOOL;
    Valve_Opened AT %MX0.0 : BOOL;
    VFD_Running AT %MX0.1 : BOOL;
    Valve_Position AT %MW0 : INT;
    VFD_ActualFrequency AT %MW1 : INT;
    Motor_Speed AT %MW2 : INT;
  END_VAR

  Valve_Open := StartRequest;
  VFD_Run := StartRequest AND Valve_Opened;
  Interlock := StartRequest AND NOT Valve_Opened;
  IF VFD_Run THEN
    VFD_FrequencyRef := SpeedSetpoint;
  ELSE
    VFD_FrequencyRef := 0;
  END_IF;
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
  for (let third = 1; third < 20; third += 1) {
    const candidate = `10.217.${third}.0/28`;
    if (!used.some((subnet) => !subnet.includes(":") && cidrsOverlap(candidate, subnet))) return candidate;
  }
  throw new Error("no free test subnet");
}

const FEEDBACK = ["Valve01_Position", "Valve01_Opened", "VFD01_ActualFrequency", "VFD01_Running", "M01_Speed"];
const PROGRAM_DRIVEN = ["Valve01_Open", "VFD01_Run", "VFD01_FrequencyRef", "Line_Interlock"];

describeRuntime("PLC outputs command simulated equipment, and its feedback returns (TASK-803)", () => {
  let db: PrismaClient;
  let docker: Docker;
  let runtime: RuntimeDeps;
  let simulation: SimulationDeps;
  let live: LiveDeps;
  let factoryId: string;
  let plcId: string;
  const ids = { valve: "", vfd: "", motor: "" };

  const read = async (name: string) => (await readTag(runtime, alice, plcId, name)).value;

  /** Polls a tag until it satisfies the condition; returns the last value either way. */
  async function until(name: string, condition: (value: number | boolean | null) => boolean, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    let value = await read(name);
    while (!condition(value) && Date.now() < deadline) {
      await sleep(50);
      value = await read(name);
    }
    return value;
  }

  const liveRows = async () => new Map((await getLiveTags(live, alice, factoryId)).tags.map((row) => [row.name, row]));
  const quality = (row: LiveTagRow | undefined) => (row ? qualityAt(row.reading, Date.now(), 10_000) : undefined);
  /** Polls the Live Tags screen until every named tag shows the quality. */
  async function untilQuality(names: readonly string[], wanted: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    let rows = await liveRows();
    while (names.some((name) => quality(rows.get(name)) !== wanted) && Date.now() < deadline) {
      await sleep(100);
      rows = await liveRows();
    }
    return Object.fromEntries(names.map((name) => [name, quality(rows.get(name))]));
  }

  beforeAll(async () => {
    db = openTestDb();
    await resetDb(db);
    docker = createDockerClient(process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock");
    const bus = new EventBus();
    runtime = {
      db,
      docker,
      bus,
      policy: {
        images: RUNTIME_IMAGES,
        portRange: { min: 15_980, max: 15_999 },
        bindAddresses: ["127.0.0.1"],
        limits: DEFAULT_LIMITS,
        labels: { [RUN_LABEL]: runId },
      },
      runtimeSecret: "integration-test-runtime-secret-0123456789",
    };
    const simulator = new DeviceSimulatorRuntime();
    simulation = { db, bus, simulator, tickMs: 50, snapshotIntervalMs: 5000 };
    live = {
      db,
      bus,
      simulator,
      processBridge: new ProcessBridgeRuntime(),
      monitor: new TagMonitorRuntime(),
      pollMs: 200,
      sampling: { minIntervalMs: 200, maxIntervalMs: 60_000, deadbandRatio: 0.01 },
    };

    const factory = await createFactory(db, alice, {
      name: "Command Bridge",
      slug: "command-bridge",
      subnetCidr: await freeSubnet(docker),
    });
    factoryId = factory.id;
    const create = async (category: string, name: string) =>
      (
        await createDeviceInstance(db, {
          factoryId,
          deviceModelId: (
            await createGenericModel(
              db,
              category,
              `Generic ${category}`,
              category === "PLC" ? { architectureType: "COMPACT" } : {},
            )
          ).id,
          name,
        })
      ).id;
    plcId = await create("PLC", "PLC-01");
    ids.valve = await create("VALVE", "XV-01");
    ids.vfd = await create("VFD", "VFD-01");
    ids.motor = await create("MOTOR", "M-01");
    await connectDevices(db, {
      factoryId,
      relationship: "DRIVES",
      source: { deviceId: ids.vfd },
      target: { deviceId: ids.motor },
    });
    await db.simulationProfile.createMany({
      data: [
        { deviceInstanceId: ids.valve, kind: "STATE_MACHINE", parametersJson: { travelTimeS: 2 } },
        { deviceInstanceId: ids.vfd, kind: "STATE_MACHINE", parametersJson: { accelTimeS: 3, decelTimeS: 1 } },
        { deviceInstanceId: ids.motor, kind: "STATE_MACHINE", parametersJson: { timeConstantS: 0.2 } },
      ],
    });

    await createProgramVersion(db, alice, plcId, { sourceText: PROGRAM });
    const hz = { dataType: "INT16", scale: 0.1, unit: "Hz" };
    const tags: Array<Record<string, unknown>> = [
      // What a gateway or the UI may ask for.
      { name: "Line_StartRequest", dataType: "BOOL", role: "COMMAND", logicalAddress: "%MX10.0" },
      { name: "Line_SpeedSetpoint", ...hz, role: "SETPOINT", logicalAddress: "%MW20" },
      // What the program commands the equipment with: a %Q output and %M memory alike.
      {
        name: "Valve01_Open",
        dataType: "BOOL",
        role: "STATUS",
        logicalAddress: "%QX0.0",
        device: ids.valve,
        signal: "open",
      },
      { name: "VFD01_Run", dataType: "BOOL", role: "STATUS", logicalAddress: "%MX1.0", device: ids.vfd, signal: "run" },
      {
        name: "VFD01_FrequencyRef",
        ...hz,
        role: "STATUS",
        logicalAddress: "%QW0",
        device: ids.vfd,
        signal: "frequencySetpoint",
      },
      { name: "Line_Interlock", dataType: "BOOL", role: "ALARM", logicalAddress: "%QX0.1" },
      // What the equipment answers.
      {
        name: "Valve01_Position",
        dataType: "INT16",
        scale: 0.1,
        unit: "%",
        role: "FEEDBACK",
        logicalAddress: "%MW0",
        device: ids.valve,
        signal: "position",
      },
      {
        name: "Valve01_Opened",
        dataType: "BOOL",
        role: "STATUS",
        logicalAddress: "%MX0.0",
        device: ids.valve,
        signal: "opened",
      },
      {
        name: "VFD01_Running",
        dataType: "BOOL",
        role: "STATUS",
        logicalAddress: "%MX0.1",
        device: ids.vfd,
        signal: "running",
      },
      {
        name: "VFD01_ActualFrequency",
        ...hz,
        role: "FEEDBACK",
        logicalAddress: "%MW1",
        device: ids.vfd,
        signal: "actualFrequency",
      },
      {
        name: "M01_Speed",
        dataType: "INT16",
        unit: "rpm",
        role: "FEEDBACK",
        logicalAddress: "%MW2",
        device: ids.motor,
        signal: "actualSpeed",
      },
    ];
    for (const { device, signal, ...tag } of tags) {
      await createTag(db, alice, plcId, { ...tag, sourceDeviceInstanceId: device, sourceSignal: signal });
    }
  }, 120_000);

  afterAll(async () => {
    await live.monitor.stopAll();
    await simulation.simulator.stopAll();
    const filters = { label: [`${RUN_LABEL}=${runId}`] };
    for (const container of await docker.listContainers({ all: true, filters })) {
      await docker.getContainer(container.Id).remove({ force: true, v: true });
    }
    for (const network of await docker.listNetworks({ filters })) {
      await docker.getNetwork(network.Id).remove();
    }
    await db.$disconnect();
  }, 120_000);

  it("keeps commands, program outputs and feedback apart on the Live Tags screen", async () => {
    expect(await startPlc(runtime, alice, plcId)).toEqual({ state: "RUNNING" });
    const rows = await liveRows();
    const authority = (name: string) => [rows.get(name)?.authority, rows.get(name)?.writable];
    expect(authority("Line_StartRequest")).toEqual(["EXTERNAL_COMMAND", true]);
    // A device command on %M is the program's output, not feedback and not writable.
    expect(authority("VFD01_Run")).toEqual(["PROGRAM_OUTPUT", false]);
    for (const name of PROGRAM_DRIVEN) expect(rows.get(name)?.authority, name).toBe("PROGRAM_OUTPUT");
    for (const name of FEEDBACK) expect(authority(name), name).toEqual(["SIMULATION_FEEDBACK", false]);

    // The PLC answers but nothing simulates the equipment yet: its feedback is not healthy.
    expect(await untilQuality(FEEDBACK, "STALE")).toEqual(Object.fromEntries(FEEDBACK.map((name) => [name, "STALE"])));
    expect(await untilQuality(PROGRAM_DRIVEN, "GOOD")).toEqual(
      Object.fromEntries(PROGRAM_DRIVEN.map((name) => [name, "GOOD"])),
    );
  }, 400_000);

  it("carries the valve command to the simulated valve and its travel and limit switch back", async () => {
    await startFactorySimulation(simulation, alice, factoryId);
    expect(await untilQuality(FEEDBACK, "GOOD")).toEqual(Object.fromEntries(FEEDBACK.map((name) => [name, "GOOD"])));
    expect(await read("Valve01_Opened")).toBe(false);

    await writeTag(runtime, alice, plcId, "Line_SpeedSetpoint", 30);
    await writeTag(runtime, alice, plcId, "Line_StartRequest", true);
    // The program opens the valve at once; the valve takes its stroke time to get there.
    expect(await until("Valve01_Open", (value) => value === true)).toBe(true);
    const travelling = await until("Valve01_Position", (value) => Number(value) > 10);
    expect(Number(travelling)).toBeLessThan(100);
    expect(await read("Valve01_Opened")).toBe(false);
    // Not proven open: the program holds the drive and says why.
    expect(await read("Line_Interlock")).toBe(true);
    expect(await read("VFD01_Run")).toBe(false);
    expect(await read("VFD01_FrequencyRef")).toBe(0);

    expect(await until("Valve01_Opened", (value) => value === true)).toBe(true);
    expect(await read("Valve01_Position")).toBe(100);
  }, 60_000);

  it("runs the drive once the valve is proven open: setpoint and actual frequency stay separate", async () => {
    expect(await until("VFD01_Run", (value) => value === true)).toBe(true);
    expect(await read("Line_Interlock")).toBe(false);
    expect(await read("VFD01_FrequencyRef")).toBe(30);
    // The command is 30 Hz at once; the drive ramps towards it (50 Hz in 3 s).
    const ramping = await until("VFD01_ActualFrequency", (value) => Number(value) > 2);
    expect(Number(ramping)).toBeLessThan(30);
    expect(await read("VFD01_FrequencyRef")).toBe(30);
    expect(await until("VFD01_ActualFrequency", (value) => value === 30)).toBe(30);
    expect(await read("VFD01_Running")).toBe(true);
    expect(Number(await until("M01_Speed", (value) => Number(value) > 0))).toBeGreaterThan(0);

    // Nobody but the program writes what it drives, wherever it sits.
    for (const name of ["VFD01_Run", "Valve01_Open", "VFD01_ActualFrequency"]) {
      const refused = await writeTag(runtime, alice, plcId, name, name === "VFD01_ActualFrequency" ? 0 : false).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect((refused as DomainError).details.rule, name).toBe("tag-read-only");
    }
    expect(await read("VFD01_Run")).toBe(true);
  }, 60_000);

  it("reports what a stuck valve does, not what it was commanded", async () => {
    // Stuck while open, before the command changes: the valve must not move at all.
    await injectDeviceFault(simulation, alice, ids.valve, "STUCK");
    try {
      await writeTag(runtime, alice, plcId, "Line_StartRequest", false);
      expect(await until("Valve01_Open", (value) => value === false)).toBe(false);
      expect(await until("VFD01_Run", (value) => value === false)).toBe(false);
      await sleep(1000);
      // Commanded closed, it stays open, and its limit switch says so.
      expect(await read("Valve01_Position")).toBe(100);
      expect(await read("Valve01_Opened")).toBe(true);
    } finally {
      await clearDeviceFault(simulation, alice, ids.valve, "STUCK");
    }
    expect(await until("Valve01_Opened", (value) => value === false)).toBe(false);
    expect(await until("Valve01_Position", (value) => value === 0)).toBe(0);
  }, 60_000);

  it("releases the feedback when the simulation stops: the program reacts, and the screen shows it stale", async () => {
    await writeTag(runtime, alice, plcId, "Line_StartRequest", true);
    expect(await until("VFD01_ActualFrequency", (value) => value === 30)).toBe(30);
    expect(await untilQuality(FEEDBACK, "GOOD")).toEqual(Object.fromEntries(FEEDBACK.map((name) => [name, "GOOD"])));

    await stopFactorySimulation(simulation, alice, factoryId);
    // De-energized like the wiring of powered-down equipment, not frozen at its last values.
    expect(await read("Valve01_Opened")).toBe(false);
    expect(await read("VFD01_ActualFrequency")).toBe(0);
    expect(await read("VFD01_Running")).toBe(false);
    // The program sees the valve no longer proven open and withdraws the drive.
    expect(await until("VFD01_Run", (value) => value === false)).toBe(false);
    expect(await read("Line_Interlock")).toBe(true);
    // The PLC still answers, but no simulation stands behind its feedback.
    expect(await untilQuality(FEEDBACK, "STALE")).toEqual(Object.fromEntries(FEEDBACK.map((name) => [name, "STALE"])));
    expect(await untilQuality(PROGRAM_DRIVEN, "GOOD")).toEqual(
      Object.fromEntries(PROGRAM_DRIVEN.map((name) => [name, "GOOD"])),
    );
    const samples = await db.telemetrySample.findMany({
      where: { tag: { name: "Valve01_Opened" } },
      orderBy: { sampledAt: "asc" },
    });
    expect(samples.map((sample) => sample.quality)).toContain("STALE");
  }, 60_000);

  it("closes the loop again when the simulation is back", async () => {
    await startFactorySimulation(simulation, alice, factoryId);
    expect(await until("Valve01_Opened", (value) => value === true)).toBe(true);
    expect(await until("VFD01_ActualFrequency", (value) => value === 30)).toBe(30);
    expect(await untilQuality(FEEDBACK, "GOOD")).toEqual(Object.fromEntries(FEEDBACK.map((name) => [name, "GOOD"])));
    const state = await getSimulationState(simulation, alice, factoryId);
    const valve = state.running ? state.devices.find((device) => device.deviceId === ids.valve) : undefined;
    expect(valve).toMatchObject({ state: "OPEN", inputs: { open: true } });
    await stopFactorySimulation(simulation, alice, factoryId);
  }, 60_000);
});
