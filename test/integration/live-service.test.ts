// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { loadCatalog } from "@/lib/catalog";
import { ingestCatalog } from "@/lib/catalog/ingest";
import { createDockerClient } from "@/lib/docker/client";
import { DEFAULT_LIMITS } from "@/lib/docker/policy";
import { RUNTIME_IMAGES } from "@/lib/docker/runtime-images";
import { DomainError, type DomainErrorCode } from "@/lib/domain/errors";
import type { LiveMessage } from "@/lib/domain/live";
import { EventBus } from "@/lib/events/bus";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { DeviceSimulatorRuntime } from "@/lib/runtimes/device-sim/runtime";
import { TagMonitorRuntime } from "@/lib/runtimes/tag-monitor/monitor";
import { listAlarms, listEvents, recordEvent } from "@/lib/services/event-service";
import { createFactory } from "@/lib/services/factory-service";
import {
  DEVICE_STATES_DELAY_MS,
  getDeviceStates,
  getLiveSnapshot,
  getLiveTags,
  type LiveDeps,
  openLiveStream,
  stopPlcMonitoring,
  syncFactoryMonitoring,
} from "@/lib/services/live-service";
import { addPeripheral, createPlc } from "@/lib/services/plc-config-service";
import type { RuntimeDeps } from "@/lib/services/plc-runtime-service";
import { startFactorySimulation, stopFactorySimulation } from "@/lib/services/simulation-service";
import { createTag, writeTag } from "@/lib/services/tag-service";
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
 * The live service against PostgreSQL, with an in-process Modbus server standing in for
 * the running PLC: tag monitoring, alarms from PLC tags, telemetry sampling, device
 * states and the stream a browser is given.
 */
describeDb("live tags, telemetry and the live stream", () => {
  let db: PrismaClient;
  let plc: TestPlc;
  let deps: LiveDeps;
  let runtime: RuntimeDeps;
  let live: LiveMessage[];
  let factoryId: string;
  let plcId: string;
  let valveId: string;
  /** The monitor's clock, stepped by the tests that wait for a retry. */
  let monitorNow = 0;

  /** Coil and register addresses of the tags created below. */
  const COIL = { valveOutput: 0, startCmd: 80, limitAlarm: 81, closed: 8192, opened: 8193 };
  const REGISTER = { holdLimit: 10 };

  const tick = () => deps.monitor.tick(plcId);
  const tagRow = async (name: string) =>
    (await getLiveTags(deps, alice, factoryId)).tags.find((tag) => tag.name === name);
  const eventTypes = async () => (await listEvents(db, alice, factoryId)).map((event) => event.type);
  const activeAlarms = async () => (await listAlarms(db, alice, factoryId)).filter((alarm) => alarm.clearedAt === null);
  /** What `startPlc` records for a started runtime, without a container. */
  const markStarted = async () => {
    await db.deviceInstance.update({
      where: { id: plcId },
      data: { dockerContainerId: "c0ffee".repeat(10) + "beef", hostName: "plc-01", runtimeStatus: "RUNNING" },
    });
    await db.plcInstanceProfile.update({ where: { deviceInstanceId: plcId }, data: { apiHostPort: 15990 } });
    await db.runtimePort.create({
      data: { deviceInstanceId: plcId, protocol: "MODBUS_TCP", containerPort: 502, hostPort: plc.port },
    });
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
    live = [];
    monitorNow = 0;
    const bus = new EventBus();
    deps = {
      db,
      bus,
      monitor: new TagMonitorRuntime({ now: () => monitorNow, date: () => new Date() }),
      simulator: new DeviceSimulatorRuntime(),
      autoTick: false,
      pollMs: 500,
      // Every change is stored: the sampling policy itself is covered by its unit tests.
      sampling: { minIntervalMs: 0, maxIntervalMs: 3_600_000, deadbandRatio: 0.01 },
    };
    runtime = {
      db,
      bus,
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

    factoryId = (await createFactory(db, alice, { name: "Line", slug: "line", subnetCidr: "172.22.1.0/24" })).id;
    bus.subscribeLive(factoryId, (message) => live.push(message));
    const modelId = async (modelName: string) => (await db.deviceModel.findFirstOrThrow({ where: { modelName } })).id;
    plcId = (
      await createPlc(db, alice, { factoryId, deviceModelId: await modelId("CPU 1214C DC/DC/DC"), name: "PLC-01" })
    ).id;
    await addPeripheral(db, alice, plcId, {
      deviceModelId: await modelId("Generic on/off valve, 24 V DC"),
      name: "XV-101",
    });
    valveId = (await db.deviceInstance.findFirstOrThrow({ where: { factoryId, name: "XV-101" } })).id;
    await createTag(db, alice, plcId, {
      name: "Start_Cmd",
      dataType: "BOOL",
      role: "COMMAND",
      logicalAddress: "%QX10.0",
    });
    await createTag(db, alice, plcId, {
      name: "Hold_Limit",
      dataType: "INT16",
      role: "SETPOINT",
      logicalAddress: "%QW10",
      scale: 0.1,
      unit: "s",
    });
    await createTag(db, alice, plcId, {
      name: "Limit_Alarm",
      dataType: "BOOL",
      role: "ALARM",
      logicalAddress: "%QX10.1",
    });
  });
  afterAll(async () => {
    await plc.close();
    await db.$disconnect();
  });

  it("has no values for a PLC that was never started, and says which tags can be written", async () => {
    const view = await getLiveTags(deps, alice, factoryId);
    expect(view.plcs).toEqual([{ id: plcId, name: "PLC-01", runtimeStatus: "STOPPED", monitored: false, tagCount: 6 }]);
    expect(view.staleAfterMs).toBe(5000);
    expect(view.tags.map((tag) => [tag.name, tag.writable, tag.reading.value, tag.reading.quality])).toEqual([
      ["Hold_Limit", true, null, "DISCONNECTED"],
      ["Limit_Alarm", false, null, "DISCONNECTED"],
      ["Start_Cmd", true, null, "DISCONNECTED"],
      ["XV_101_Y1", false, null, "DISCONNECTED"],
      ["XV_101_ZSC", false, null, "DISCONNECTED"],
      ["XV_101_ZSO", false, null, "DISCONNECTED"],
    ]);
    expect(view.tags.find((tag) => tag.name === "XV_101_Y1")).toMatchObject({
      deviceName: "XV-101",
      plcName: "PLC-01",
    });
    expect(deps.monitor.isRunning(plcId)).toBe(false);
    await expectDomainError(getLiveTags(deps, bob, factoryId), "NOT_FOUND");
  });

  it("reads the tags of a started PLC from its memory and pushes what changes", async () => {
    await markStarted();
    await syncFactoryMonitoring(deps, factoryId);
    expect(deps.monitor.isRunning(plcId)).toBe(true);

    plc.coils[COIL.closed] = true;
    plc.holding[REGISTER.holdLimit] = 425;
    await tick();
    expect(await tagRow("Hold_Limit")).toMatchObject({ unit: "s", reading: { value: 42.5, quality: "GOOD" } });
    expect((await tagRow("XV_101_ZSC"))?.reading.value).toBe(true);
    // The first cycle reports every tag; the PLC answered, so the message confirms the rest.
    const first = live.find((message) => message.kind === "tags");
    expect(first).toMatchObject({ kind: "tags", plcId, confirmed: true });
    expect(first?.kind === "tags" && first.readings).toHaveLength(6);
    expect(await eventTypes()).toContain("CONNECTION_UP");

    // Nothing changed: nothing to push again yet.
    live.length = 0;
    await tick();
    expect(live.filter((message) => message.kind === "tags")).toEqual([]);

    plc.coils[COIL.valveOutput] = true;
    await tick();
    const changed = live.find((message) => message.kind === "tags");
    expect(changed?.kind === "tags" && changed.readings.map((reading) => [reading.name, reading.value])).toEqual([
      ["XV_101_Y1", true],
    ]);
    // Live values are not what the database holds: no tag row carries a value.
    expect((await db.tag.findMany({ where: { plcInstanceId: plcId } })).every((tag) => tag.quality === null)).toBe(
      true,
    );
  });

  it("records an alarm when the PLC program sets an ALARM tag, and ends it when the program clears it", async () => {
    await markStarted();
    await syncFactoryMonitoring(deps, factoryId);
    await tick();
    expect(await activeAlarms()).toEqual([]);

    plc.coils[COIL.limitAlarm] = true;
    await tick();
    await tick();
    expect(await activeAlarms()).toEqual([
      expect.objectContaining({
        code: "TAG:Limit_Alarm",
        message: "Limit_Alarm is active",
        tagName: "Limit_Alarm",
        deviceName: "PLC-01",
        severity: "WARNING",
      }),
    ]);
    expect((await eventTypes()).filter((type) => type === "ALARM_RAISED")).toHaveLength(1);

    plc.coils[COIL.limitAlarm] = false;
    await tick();
    expect(await activeAlarms()).toEqual([]);
    expect((await eventTypes())[0]).toBe("ALARM_CLEARED");
  });

  it("stores telemetry for changes that matter and not for every cycle", async () => {
    await markStarted();
    await syncFactoryMonitoring(deps, factoryId);
    const samples = async (name: string) =>
      (await db.telemetrySample.findMany({ where: { tag: { name } }, orderBy: { id: "asc" } })).map((sample) => [
        sample.valueNumber,
        sample.quality,
      ]);

    plc.holding[REGISTER.holdLimit] = 1000;
    await tick();
    for (let cycle = 0; cycle < 5; cycle += 1) await tick();
    expect(await samples("Hold_Limit")).toEqual([[100, "GOOD"]]);
    // Six tags, one sample each, after six cycles.
    expect(await db.telemetrySample.count()).toBe(6);

    plc.holding[REGISTER.holdLimit] = 1005; // 100.5 s: within the 1 % deadband
    await tick();
    expect(await samples("Hold_Limit")).toHaveLength(1);
    plc.holding[REGISTER.holdLimit] = 1020; // 102 s: beyond it
    plc.coils[COIL.startCmd] = true;
    await tick();
    expect(await samples("Hold_Limit")).toEqual([
      [100, "GOOD"],
      [102, "GOOD"],
    ]);
    expect(await samples("Start_Cmd")).toEqual([
      [0, "GOOD"],
      [1, "GOOD"],
    ]);
    const [sample] = await db.telemetrySample.findMany({ where: { tag: { name: "XV_101_Y1" } } });
    expect(sample).toMatchObject({ factoryId, deviceId: valveId });
  });

  it("keeps the last values of a PLC that stops answering, marks them, and raises and ends the link alarm", async () => {
    await markStarted();
    let answering = true;
    deps.openReader = () => async (area, address, count) => {
      if (!answering)
        throw new DomainError("RUNTIME_FAILURE", "The Modbus server is not reachable.", { rule: "modbus-unreachable" });
      return (area === "COIL" ? plc.coils : plc.holding).slice(address, address + count);
    };
    await syncFactoryMonitoring(deps, factoryId);
    plc.holding[REGISTER.holdLimit] = 300;
    await tick();

    answering = false;
    live.length = 0;
    await tick();
    expect((await tagRow("Hold_Limit"))?.reading).toMatchObject({ value: 30, quality: "DISCONNECTED" });
    const down = live.find((message) => message.kind === "tags");
    expect(down).toMatchObject({ confirmed: false });
    // One missed answer marks the values; the alarm waits for the PLC to stay away.
    expect(await activeAlarms()).toEqual([]);
    monitorNow += 2000;
    await tick();
    expect((await activeAlarms()).map((alarm) => alarm.code)).toEqual(["PLC_LINK_DOWN"]);
    expect((await getDeviceStates(deps, factoryId)).find((device) => device.deviceId === plcId)).toMatchObject({
      status: "RUNNING",
      source: "STORED",
      quality: "DISCONNECTED",
    });
    // The loss of a value is stored once, as a change of quality.
    expect(
      (await db.telemetrySample.findMany({ where: { tag: { name: "Hold_Limit" } }, orderBy: { id: "asc" } })).map(
        (sample) => [sample.valueNumber, sample.quality],
      ),
    ).toEqual([
      [30, "GOOD"],
      [30, "DISCONNECTED"],
    ]);

    answering = true;
    monitorNow += 2000;
    await tick();
    expect(await activeAlarms()).toEqual([]);
    expect((await tagRow("Hold_Limit"))?.reading).toMatchObject({ value: 30, quality: "GOOD" });
    expect((await eventTypes()).slice(0, 2)).toEqual(["ALARM_CLEARED", "CONNECTION_UP"]);
  });

  it("stops reading a PLC that was stopped, ends its tag alarms, and follows a changed tag mapping", async () => {
    await markStarted();
    await syncFactoryMonitoring(deps, factoryId);
    plc.coils[COIL.limitAlarm] = true;
    await tick();
    expect(await activeAlarms()).toHaveLength(1);

    // A tag added while the PLC runs: the monitor is started again with the new mapping.
    await createTag(db, alice, plcId, { name: "Extra", dataType: "BOOL", role: "STATUS", logicalAddress: "%QX11.0" });
    await syncFactoryMonitoring(deps, factoryId);
    await tick();
    expect((await getLiveTags(deps, alice, factoryId)).tags.map((tag) => tag.name)).toContain("Extra");
    expect((await tagRow("Extra"))?.reading.quality).toBe("GOOD");

    // On its way down the PLC is no longer read; stopped, nothing is known about its values.
    await db.deviceInstance.update({ where: { id: plcId }, data: { runtimeStatus: "STOPPING" } });
    live.length = 0;
    await syncFactoryMonitoring(deps, factoryId);
    expect(deps.monitor.isRunning(plcId)).toBe(false);
    expect(await activeAlarms()).toEqual([]);
    const gone = live.find((message) => message.kind === "tags");
    expect(gone).toMatchObject({ confirmed: false });
    expect(gone?.kind === "tags" && gone.readings.every((reading) => reading.value === null)).toBe(true);
    expect((await tagRow("Hold_Limit"))?.reading).toEqual({
      plcId,
      name: "Hold_Limit",
      value: null,
      quality: "DISCONNECTED",
      readAt: null,
    });
    // Taking a PLC down on purpose is not a lost connection.
    expect(await eventTypes()).not.toContain("CONNECTION_DOWN");
  });

  it("lets only the owner stop the monitoring of a PLC, and survives concurrent synchronisation", async () => {
    await markStarted();
    await Promise.all(Array.from({ length: 8 }, () => syncFactoryMonitoring(deps, factoryId)));
    expect(deps.monitor.monitored()).toHaveLength(1);
    await expectDomainError(stopPlcMonitoring(deps, bob, plcId), "NOT_FOUND");
    expect(deps.monitor.isRunning(plcId)).toBe(true);
    await stopPlcMonitoring(deps, alice, plcId);
    expect(deps.monitor.isRunning(plcId)).toBe(false);

    // A stop and passes that began before it: whatever the order, the stored state wins in the end.
    await db.deviceInstance.update({ where: { id: plcId }, data: { runtimeStatus: "STOPPED" } });
    await Promise.all(Array.from({ length: 8 }, () => syncFactoryMonitoring(deps, factoryId)));
    expect(deps.monitor.isRunning(plcId)).toBe(false);
  });

  it("takes device state from simulator memory, and treats the stored snapshot as a snapshot", async () => {
    await markStarted();
    // What a server that went down mid-simulation leaves behind: "running" and a snapshot.
    await db.deviceInstance.update({ where: { id: valveId }, data: { runtimeStatus: "RUNNING" } });
    const capturedAt = new Date("2026-10-01T10:00:00.000Z");
    await db.deviceRuntimeSnapshot.create({
      data: { deviceInstanceId: valveId, status: "RUNNING", valuesJson: { state: "OPEN" }, capturedAt },
    });

    // No simulation runs: the device is stopped, whatever was stored, and the snapshot only dates it.
    expect((await getDeviceStates(deps, factoryId)).find((device) => device.deviceId === valveId)).toEqual({
      deviceId: valveId,
      name: "XV-101",
      status: "STOPPED",
      source: "SNAPSHOT",
      quality: "STALE",
      at: capturedAt.toISOString(),
    });
    await syncFactoryMonitoring(deps, factoryId);
    expect((await db.deviceInstance.findUniqueOrThrow({ where: { id: valveId } })).runtimeStatus).toBe("STOPPED");

    // A running simulation is the authority, even over a snapshot that says "faulted".
    await startFactorySimulation({ db, simulator: deps.simulator, bus: deps.bus }, alice, factoryId, {
      autoTick: false,
    });
    await db.deviceRuntimeSnapshot.update({ where: { deviceInstanceId: valveId }, data: { status: "FAULTED" } });
    const running = (await getDeviceStates(deps, factoryId)).find((device) => device.deviceId === valveId);
    expect(running).toMatchObject({ status: "RUNNING", source: "LIVE", quality: "GOOD" });
    deps.simulator.simulation(factoryId).injectFault(valveId, "STUCK");
    expect(
      (await getLiveSnapshot(deps, factoryId)).devices.find((device) => device.deviceId === valveId),
    ).toMatchObject({
      status: "FAULTED",
      source: "LIVE",
    });
    await stopFactorySimulation({ db, simulator: deps.simulator, bus: deps.bus }, alice, factoryId);
    expect((await getDeviceStates(deps, factoryId)).find((device) => device.deviceId === valveId)).toMatchObject({
      status: "STOPPED",
      source: "SNAPSHOT",
    });
  });

  it("records every write of a command or setpoint, and every refused one", async () => {
    await markStarted();
    await syncFactoryMonitoring(deps, factoryId);

    await writeTag(runtime, alice, plcId, "Start_Cmd", true);
    await writeTag(runtime, alice, plcId, "Hold_Limit", 12.5, "GATEWAY");
    expect(plc.coils[COIL.startCmd]).toBe(true);
    expect(plc.holding[REGISTER.holdLimit]).toBe(125);
    // The value comes back from the PLC, not from the write.
    await tick();
    expect((await tagRow("Hold_Limit"))?.reading.value).toBe(12.5);

    await expectDomainError(writeTag(runtime, alice, plcId, "XV_101_ZSO", true), "INVARIANT", "tag-read-only");
    await expectDomainError(
      writeTag(runtime, alice, plcId, "Limit_Alarm", true, "GATEWAY"),
      "INVARIANT",
      "tag-read-only",
    );
    expect(plc.coils[COIL.opened]).toBe(false);
    expect(plc.coils[COIL.limitAlarm]).toBe(false);

    const commands = (await listEvents(db, alice, factoryId, { family: "COMMAND" })).reverse();
    expect(commands.map((event) => [event.type, event.severity, event.payload.tag, event.payload.source])).toEqual([
      ["COMMAND_ACCEPTED", "INFO", "Start_Cmd", "UI"],
      ["GATEWAY_COMMAND_RECEIVED", "INFO", "Hold_Limit", "GATEWAY"],
      ["COMMAND_ACCEPTED", "INFO", "Hold_Limit", "GATEWAY"],
      ["COMMAND_REJECTED", "WARNING", "XV_101_ZSO", "UI"],
      ["COMMAND_REJECTED", "WARNING", "Limit_Alarm", "GATEWAY"],
    ]);
    expect(commands[0]?.payload).toMatchObject({ value: true, commandId: expect.any(String) });
    expect(
      live.filter((message) => message.kind === "event" && message.event.type.startsWith("COMMAND_")),
    ).toHaveLength(4);
    expect(await db.deviceCommand.count({ where: { status: "ACCEPTED" } })).toBe(2);
  });

  it("gives a connecting client the whole state, then everything as it happens", async () => {
    await markStarted();
    const received: LiveMessage[] = [];
    const close = await openLiveStream(deps, alice, factoryId, null, (message) => received.push(message));
    // Opening a stream is enough to start reading the factory's PLCs.
    expect(deps.monitor.isRunning(plcId)).toBe(true);
    expect(received.map((message) => message.kind)).toEqual(["snapshot"]);
    const [first] = received;
    expect(first?.kind === "snapshot" && first.snapshot).toMatchObject({ factoryId, activeAlarms: 0 });
    expect(first?.kind === "snapshot" && first.snapshot.tags).toHaveLength(6);
    expect(first?.kind === "snapshot" && first.snapshot.devices.map((device) => device.name)).toEqual([
      "PLC-01",
      "XV-101",
    ]);

    plc.coils[COIL.limitAlarm] = true;
    await tick();
    expect(received.map((message) => (message.kind === "event" ? message.event.type : message.kind))).toEqual([
      "snapshot",
      "CONNECTION_UP",
      "tags",
      "ALARM_RAISED",
    ]);

    close();
    await recordEvent(deps, { type: "DEVICE_RESET", factoryId, deviceId: valveId });
    expect(received).toHaveLength(4);
    expect(deps.bus.liveListenerCount(factoryId)).toBe(1); // the test's own listener
    await expectDomainError(
      openLiveStream(deps, bob, factoryId, null, () => undefined),
      "NOT_FOUND",
    );
  });

  it("replays what a reconnecting client missed before the current state, without gaps or repeats", async () => {
    const [seen] = [await recordEvent(deps, { type: "DEVICE_STARTING", factoryId, deviceId: plcId })];
    const missed = [
      await recordEvent(deps, { type: "DEVICE_RUNNING", factoryId, deviceId: plcId }),
      await recordEvent(deps, { type: "PLC_PROGRAM_DEPLOYED", factoryId, deviceId: plcId, payload: { version: 1 } }),
    ];

    const received: LiveMessage[] = [];
    // Events recorded while the client is connecting must arrive exactly once.
    const opening = openLiveStream(deps, alice, factoryId, seen.id, (message) => received.push(message));
    const during = await recordEvent(deps, { type: "DEVICE_RESET", factoryId, deviceId: valveId });
    const close = await opening;
    const after = await recordEvent(deps, { type: "SIMULATED_INPUT_FORCED", factoryId, deviceId: valveId });

    const ids = received.flatMap((message) => (message.kind === "event" ? [message.event.id] : []));
    expect(ids).toEqual([...missed.map((event) => event.id), during.id, after.id]);
    expect(new Set(ids).size).toBe(ids.length);
    // History first, then the state, then the present.
    const kinds = received.map((message) => message.kind);
    expect(kinds.indexOf("snapshot")).toBeGreaterThanOrEqual(2);
    expect(kinds.lastIndexOf("event")).toBeGreaterThan(kinds.indexOf("snapshot"));
    close();

    const reset: LiveMessage[] = [];
    (
      await openLiveStream(deps, alice, factoryId, "018f6f2e-0000-7000-8000-000000000000", (message) =>
        reset.push(message),
      )
    )();
    expect(reset.map((message) => message.kind)).toEqual(["reset", "snapshot"]);
  });

  it("follows recorded events with the state of every device, once per burst, worked out by the server", async () => {
    await markStarted();
    const received: LiveMessage[] = [];
    const close = await openLiveStream(deps, alice, factoryId, null, (message) => received.push(message));
    const deviceMessages = () => received.flatMap((message) => (message.kind === "devices" ? [message] : []));
    const settle = () => new Promise((resolve) => setTimeout(resolve, DEVICE_STATES_DELAY_MS + 150));
    expect(deviceMessages()).toEqual([]);

    // A simulation starts: several events at once, one message with the resulting states.
    await startFactorySimulation({ db, simulator: deps.simulator, bus: deps.bus }, alice, factoryId, {
      autoTick: false,
    });
    await settle();
    expect(deviceMessages()).toHaveLength(1);
    expect(deviceMessages()[0]?.devices.map((device) => [device.name, device.status, device.source])).toEqual([
      ["PLC-01", "RUNNING", "STORED"],
      ["XV-101", "RUNNING", "LIVE"],
    ]);

    // A fault: the state comes from simulator memory, not from what the event says.
    deps.simulator.simulation(factoryId).injectFault(valveId, "STUCK");
    await recordEvent(deps, {
      type: "FAULT_INJECTED",
      factoryId,
      deviceId: valveId,
      severity: "WARNING",
      payload: { code: "STUCK", name: "Stuck" },
    });
    await settle();
    expect(deviceMessages()).toHaveLength(2);
    expect(deviceMessages()[1]?.devices.find((device) => device.deviceId === valveId)).toMatchObject({
      status: "FAULTED",
      source: "LIVE",
    });
    // Tag values are not a reason to send device states.
    await tick();
    await settle();
    expect(deviceMessages()).toHaveLength(3); // the monitor's first cycle recorded CONNECTION_UP
    await tick();
    await settle();
    expect(deviceMessages()).toHaveLength(3);

    // A closed stream gets nothing more, not even what was already on its way.
    await recordEvent(deps, { type: "DEVICE_RESET", factoryId, deviceId: valveId });
    close();
    await settle();
    expect(deviceMessages()).toHaveLength(3);
    await stopFactorySimulation({ db, simulator: deps.simulator, bus: deps.bus }, alice, factoryId);
  });
});
