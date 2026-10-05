// @vitest-environment node
import { connect } from "node:net";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { loadCatalog } from "@/lib/catalog";
import { ingestCatalog } from "@/lib/catalog/ingest";
import { createDockerClient } from "@/lib/docker/client";
import { DEFAULT_LIMITS } from "@/lib/docker/policy";
import { RUNTIME_IMAGES } from "@/lib/docker/runtime-images";
import { DomainError, type DomainErrorCode } from "@/lib/domain/errors";
import { EventBus } from "@/lib/events/bus";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { readModbus, writeModbus } from "@/lib/protocols/modbus/client";
import { GatewayEndpointRuntime } from "@/lib/runtimes/gateway-endpoint/runtime";
import { listEvents } from "@/lib/services/event-service";
import { createFactory } from "@/lib/services/factory-service";
import {
  addGateway,
  connectGateway,
  type GatewayDeps,
  getGatewayMap,
  getGatewaysView,
  mapAllGatewayTags,
  mapGatewayTag,
  removeGatewayConnection,
  setGatewayConnectionEnabled,
  syncGatewayEndpoints,
  unmapGatewayTag,
} from "@/lib/services/gateway-service";
import { createPlc } from "@/lib/services/plc-config-service";
import { createTag } from "@/lib/services/tag-service";
import { describeDb, openTestDb, resetDb } from "./harness";
import { startTestPlc, type TestPlc } from "./modbus-server";

/**
 * External gateways against PostgreSQL, with an in-process Modbus server standing in for
 * the running PLC and a real TCP client standing in for the edge device: what a gateway
 * is given, what it can read and write through its endpoint, and what is recorded.
 */
const alice = { ownerId: "alice" };
const bob = { ownerId: "bob" };
const HOST = "127.0.0.1";
const PORT = 15_930;

async function domainError(action: Promise<unknown>, code: DomainErrorCode, rule?: string): Promise<DomainError> {
  const error = await action.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe(code);
  if (rule) expect((error as DomainError).details.rule).toBe(rule);
  return error as DomainError;
}

describeDb("external gateways and their endpoints", () => {
  let db: PrismaClient;
  let plc: TestPlc;
  let deps: GatewayDeps;
  let factoryId: string;
  let plcId: string;
  let gatewayId: string;
  const tags: Record<string, string> = {};
  /** The edge device: a Modbus client that knows only the endpoint it was given. */
  const edge = { host: HOST, port: PORT, unitId: 1 };

  const exceptionOf = async (action: Promise<unknown>) => {
    const error = await action.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    return error instanceof DomainError ? (error.details.exceptionCode ?? error.details.rule) : error;
  };
  const events = async () =>
    (await listEvents(db, alice, factoryId)).map((event) => [event.type, event.payload] as const).reverse();
  const connection = async () => (await getGatewaysView(deps, alice, factoryId)).gateways[0]?.connections[0];
  const connectAndMap = async () => {
    const { connectionId } = await connectGateway(deps, alice, gatewayId, { plcId, host: HOST, port: PORT });
    await mapAllGatewayTags(deps, alice, connectionId);
    return connectionId;
  };
  /** What `startPlc` records for a started runtime, without a container. */
  const markStarted = async () => {
    await db.deviceInstance.update({
      where: { id: plcId },
      data: { dockerContainerId: "c0ffee".repeat(10) + "beef", hostName: "plc-01", runtimeStatus: "RUNNING" },
    });
    await db.plcInstanceProfile.update({ where: { deviceInstanceId: plcId }, data: { apiHostPort: 15_990 } });
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
    await deps?.endpoints.stopAll();
    await db.factory.deleteMany();
    plc.coils.fill(false);
    plc.holding.fill(0);
    deps = {
      db,
      bus: new EventBus(),
      docker: createDockerClient("unix:///nonexistent/docker.sock"),
      policy: {
        images: RUNTIME_IMAGES,
        portRange: { min: 15_900, max: 15_949 },
        bindAddresses: [HOST],
        limits: DEFAULT_LIMITS,
        labels: {},
      },
      runtimeSecret: "integration-test-runtime-secret-0123456789",
      endpoints: new GatewayEndpointRuntime(),
    };
    factoryId = (await createFactory(db, alice, { name: "Line", slug: "line", subnetCidr: "172.22.1.0/24" })).id;
    const model = await db.deviceModel.findFirstOrThrow({ where: { modelName: "CPU 1214C DC/DC/DC" } });
    plcId = (await createPlc(db, alice, { factoryId, deviceModelId: model.id, name: "PLC-01" })).id;
    const tag = async (name: string, dataType: string, role: string, logicalAddress: string, scale?: number) => {
      await createTag(db, alice, plcId, { name, dataType, role, logicalAddress, ...(scale ? { scale } : {}) });
      tags[name] = (await db.tag.findFirstOrThrow({ where: { plcInstanceId: plcId, name } })).id;
    };
    await tag("Start_Cmd", "BOOL", "COMMAND", "%QX10.0"); // coil 80
    await tag("Speed_SP", "INT16", "SETPOINT", "%QW10", 0.1); // holding register 10, tenths of a hertz
    await tag("Running", "BOOL", "FEEDBACK", "%MX100.0"); // coil 8992
    await tag("Speed_Actual", "INT16", "FEEDBACK", "%MW100", 0.1); // holding register 1124
    await tag("High_Level", "BOOL", "ALARM", "%MX100.1"); // coil 8993
    gatewayId = (await addGateway(deps, alice, factoryId)).id;
    await markStarted();
  });
  afterAll(async () => {
    await deps?.endpoints.stopAll();
    await plc.close();
    await db.$disconnect();
  });

  it("adds a gateway device and shows what it could be connected to", async () => {
    const view = await getGatewaysView(deps, alice, factoryId);
    expect(view).toMatchObject({
      factory: { id: factoryId, name: "Line" },
      bindAddresses: [HOST],
      portRange: { min: 15_900, max: 15_949 },
      hasPlc: true,
    });
    expect(view.gateways).toMatchObject([
      { deviceId: gatewayId, name: "GATEWAY-01", connections: [], availablePlcs: [{ id: plcId, name: "PLC-01" }] },
    ]);
    // Suggested from the top of the range: PLC runtimes are given ports from the bottom.
    expect(view.suggestedPort).toBe(15_949);
    // A gateway is a device of the factory like any other: the designer and the 3D view show it.
    expect(await db.deviceInstance.count({ where: { factoryId, id: gatewayId } })).toBe(1);
    expect((await addGateway(deps, alice, factoryId)).name).toBe("GATEWAY-02");
    await domainError(getGatewaysView(deps, bob, factoryId), "NOT_FOUND");
    await domainError(addGateway(deps, bob, factoryId), "NOT_FOUND");
  });

  it("connects a gateway to a PLC only on an address and port the host policy allows", async () => {
    const connect = (input: Record<string, unknown>, device = gatewayId, actor = alice) =>
      connectGateway(deps, actor, device, { plcId, host: HOST, port: PORT, ...input });
    await domainError(connect({ host: "0.0.0.0" }), "VALIDATION", "bind-address-allowed");
    await domainError(connect({ host: "192.168.1.20" }), "VALIDATION", "bind-address-allowed");
    await domainError(connect({ host: "plc.local" }), "VALIDATION");
    await domainError(connect({ port: 502 }), "VALIDATION", "host-port-range");
    await domainError(connect({ port: 16_000 }), "VALIDATION", "host-port-range");
    await domainError(connect({ unitId: 0 }), "VALIDATION");
    await domainError(connect({ pollIntervalMs: 5 }), "VALIDATION");
    // A port a PLC runtime is published on is not a gateway's.
    await db.runtimePort.updateMany({ where: { deviceInstanceId: plcId }, data: { hostPort: 15_931 } });
    await domainError(connect({ port: 15_931 }), "CONFLICT", "host-port-taken");
    // Only a gateway device of the owner's factory, and only a PLC of the same factory.
    await domainError(connect({}, plcId), "NOT_FOUND");
    await domainError(connect({}, gatewayId, bob), "NOT_FOUND");
    await domainError(connect({ plcId: gatewayId }), "NOT_FOUND", "gateway-same-factory");
    const other = await createFactory(db, alice, { name: "Other", slug: "other", subnetCidr: "172.22.2.0/24" });
    const model = await db.deviceModel.findFirstOrThrow({ where: { modelName: "CPU 1214C DC/DC/DC" } });
    const foreign = await createPlc(db, alice, { factoryId: other.id, deviceModelId: model.id, name: "PLC-01" });
    await domainError(connect({ plcId: foreign.id }), "NOT_FOUND", "gateway-same-factory");
    expect(await db.gatewayPlcConnection.count()).toBe(0);

    const { connectionId } = await connect({ unitId: 7, pollIntervalMs: 250 });
    expect(await connection()).toMatchObject({
      id: connectionId,
      plcName: "PLC-01",
      plcState: "RUNNING",
      host: HOST,
      port: PORT,
      unitId: 7,
      pollIntervalMs: 250,
      enabled: true,
      endpoint: { listening: true, error: null, clients: 0, requests: 0 },
      registers: [],
    });
    expect((await db.gateway.findFirstOrThrow()).status).toBe("RUNNING");
    // The same port cannot be given twice, and a gateway has one connection per PLC.
    const second = (await addGateway(deps, alice, factoryId)).id;
    await domainError(connect({}, second), "CONFLICT", "host-port-taken");
    await domainError(connect({ port: 15_932 }), "CONFLICT");
    expect((await getGatewaysView(deps, alice, factoryId)).gateways[0]?.availablePlcs).toEqual([]);
  });

  it("gives a gateway tags to read, and to write only where the tag is a command or setpoint", async () => {
    const { connectionId } = await connectGateway(deps, alice, gatewayId, { plcId, host: HOST, port: PORT });
    expect((await connection())?.unmappedTags.map((tag) => [tag.name, tag.writable])).toEqual([
      ["High_Level", false],
      ["Running", false],
      ["Speed_Actual", false],
      ["Speed_SP", true],
      ["Start_Cmd", true],
    ]);
    const map = (name: string, input: Record<string, unknown> = {}) =>
      mapGatewayTag(deps, alice, connectionId, { tagId: tags[name], ...input });

    for (const name of ["Running", "Speed_Actual", "High_Level"]) {
      await domainError(map(name, { access: "READ_WRITE" }), "INVARIANT", "gateway-write-command-only");
    }
    await map("Running");
    await map("Start_Cmd", { access: "READ_WRITE", externalName: "pump.start" });
    await map("Speed_SP");
    await domainError(map("Speed_Actual", { externalName: "pump.start" }), "CONFLICT");
    await domainError(map("Speed_Actual", { externalName: "has spaces" }), "VALIDATION");
    await domainError(mapGatewayTag(deps, bob, connectionId, { tagId: tags.Running }), "NOT_FOUND");
    await domainError(mapGatewayTag(deps, alice, connectionId, { tagId: gatewayId }), "NOT_FOUND");

    expect((await connection())?.registers).toMatchObject([
      { tagName: "Start_Cmd", externalName: "pump.start", area: "COIL", address: 80, access: "READ_WRITE" },
      {
        tagName: "Running",
        externalName: "Running",
        area: "COIL",
        address: 8992,
        displayAddress: "08993",
        access: "READ",
      },
      { tagName: "Speed_SP", area: "HOLDING_REGISTER", address: 10, displayAddress: "40011", access: "READ" },
    ]);
    // Mapping again changes the access; it does not add a second mapping.
    await map("Speed_SP", { access: "READ_WRITE" });
    expect((await connection())?.registers.map((entry) => [entry.tagName, entry.access])).toEqual([
      ["Start_Cmd", "READ_WRITE"],
      ["Running", "READ"],
      ["Speed_SP", "READ_WRITE"],
    ]);

    expect(await mapAllGatewayTags(deps, alice, connectionId)).toBe(2);
    const all = (await connection())?.registers ?? [];
    expect(all.map((entry) => [entry.tagName, entry.access])).toEqual([
      ["Start_Cmd", "READ_WRITE"],
      ["Running", "READ"],
      ["High_Level", "READ"],
      ["Speed_SP", "READ_WRITE"],
      ["Speed_Actual", "READ"],
    ]);
    expect((await connection())?.unmappedTags).toEqual([]);

    const running = all.find((entry) => entry.tagName === "Running");
    await unmapGatewayTag(deps, alice, connectionId, running?.mappingId ?? "");
    await domainError(unmapGatewayTag(deps, alice, connectionId, running?.mappingId ?? ""), "NOT_FOUND");
    expect((await connection())?.unmappedTags.map((tag) => tag.name)).toEqual(["Running"]);
    // What is no longer mapped is no longer handed out, without reopening the endpoint.
    expect(await exceptionOf(readModbus(edge, "COIL", 8992, 1))).toBe(2);
  });

  it("lets the edge device read what it was given, as the PLC holds it", async () => {
    await connectAndMap();
    plc.coils[8992] = true;
    plc.coils[8993] = true;
    plc.holding[1124] = 448;
    plc.holding[10] = 455;

    expect(await readModbus(edge, "COIL", 8992, 2)).toEqual([true, true]);
    expect(await readModbus(edge, "COIL", 80, 1)).toEqual([false]);
    expect(await readModbus(edge, "HOLDING_REGISTER", 1124, 1)).toEqual([448]);
    expect(await readModbus(edge, "HOLDING_REGISTER", 10, 1)).toEqual([455]);

    // Anything else of the PLC stays out of reach: neighbours, gaps, other areas, other unit ids.
    plc.holding[11] = 999;
    expect(await exceptionOf(readModbus(edge, "HOLDING_REGISTER", 11, 1))).toBe(2);
    expect(await exceptionOf(readModbus(edge, "HOLDING_REGISTER", 10, 2))).toBe(2);
    expect(await exceptionOf(readModbus(edge, "HOLDING_REGISTER", 0, 125))).toBe(2);
    expect(await exceptionOf(readModbus(edge, "COIL", 0, 2000))).toBe(2);
    expect(await exceptionOf(readModbus(edge, "INPUT_REGISTER", 10, 1))).toBe(2);
    expect(await exceptionOf(readModbus({ ...edge, unitId: 9 }, "COIL", 80, 1))).toBe(10);

    expect((await connection())?.endpoint).toMatchObject({ listening: true, requests: 9, refused: 5 });
    // Reading is not an event: nothing was recorded but the device's arrival.
    expect((await events()).map(([type]) => type)).toEqual([
      "FACTORY_CREATED",
      "DEVICE_CREATED",
      "DEVICE_CREATED",
      "GATEWAY_CLIENT_CONNECTED",
    ]);
  });

  it("turns a gateway write into a recorded command on the PLC's command or setpoint tag", async () => {
    await connectAndMap();
    await writeModbus(edge, "COIL", 80, true);
    await writeModbus(edge, "HOLDING_REGISTER", 10, 455);

    // The PLC has the raw values the gateway sent; what happens next is PLC logic's.
    expect(plc.coils[80]).toBe(true);
    expect(plc.holding[10]).toBe(455);
    const commands = await db.deviceCommand.findMany({ orderBy: { requestedAt: "asc" }, include: { tag: true } });
    expect(
      commands.map((command) => [command.tag?.name, command.source, command.status, command.requestedValueJson]),
    ).toEqual([
      ["Start_Cmd", "GATEWAY", "ACCEPTED", true],
      ["Speed_SP", "GATEWAY", "ACCEPTED", 45.5],
    ]);
    // Accepted by the PLC is not applied by the device: that is read back from feedback.
    expect(commands.every((command) => command.appliedAt === null)).toBe(true);
    expect(plc.coils[8992]).toBe(false);

    const recorded = (await events()).filter(
      ([type]) => type.startsWith("GATEWAY_COMMAND") || type.startsWith("COMMAND"),
    );
    expect(recorded.map(([type, payload]) => [type, payload.tag, payload.value, payload.source])).toEqual([
      ["GATEWAY_COMMAND_RECEIVED", "Start_Cmd", true, "GATEWAY"],
      ["COMMAND_ACCEPTED", "Start_Cmd", true, "GATEWAY"],
      ["GATEWAY_COMMAND_RECEIVED", "Speed_SP", 45.5, "GATEWAY"],
      ["COMMAND_ACCEPTED", "Speed_SP", 45.5, "GATEWAY"],
    ]);
  });

  it("refuses to let a gateway write feedback, status, alarms or anything unmapped", async () => {
    const connectionId = await connectAndMap();
    // What a gateway on the PLC's own port could do: set feedback the simulator and PLC logic produce.
    expect(await exceptionOf(writeModbus(edge, "COIL", 8992, true))).toBe(2);
    expect(await exceptionOf(writeModbus(edge, "COIL", 8993, true))).toBe(2);
    expect(await exceptionOf(writeModbus(edge, "HOLDING_REGISTER", 1124, 500))).toBe(2);
    expect(await exceptionOf(writeModbus(edge, "HOLDING_REGISTER", 11, 1))).toBe(2);
    expect(await exceptionOf(writeModbus(edge, "COIL", 0, true))).toBe(2);
    // A polling gateway repeats itself; the same refusal is recorded once.
    expect(await exceptionOf(writeModbus(edge, "COIL", 8992, true))).toBe(2);

    expect(plc.coils[8992]).toBe(false);
    expect(plc.coils[8993]).toBe(false);
    expect(plc.coils[0]).toBe(false);
    expect(plc.holding[1124]).toBe(0);
    expect(plc.holding[11]).toBe(0);
    expect(await db.deviceCommand.count()).toBe(0);

    const refused = (await events()).filter(([type]) => type === "COMMAND_REJECTED");
    expect(
      refused.map(([, payload]) => [payload.rule, payload.tag ?? null, payload.area, payload.address, payload.source]),
    ).toEqual([
      ["gateway-read-only", "Running", "COIL", 8992, "GATEWAY"],
      ["gateway-read-only", "High_Level", "COIL", 8993, "GATEWAY"],
      ["gateway-read-only", "Speed_Actual", "HOLDING_REGISTER", 1124, "GATEWAY"],
      ["gateway-unmapped", null, "HOLDING_REGISTER", 11, "GATEWAY"],
      ["gateway-unmapped", null, "COIL", 0, "GATEWAY"],
    ]);
    expect((await connection())?.endpoint).toMatchObject({ requests: 6, refused: 6 });

    // A setpoint mapped for reading only is refused like feedback, though the tag itself is writable.
    await mapGatewayTag(deps, alice, connectionId, { tagId: tags.Speed_SP, access: "READ" });
    expect(await exceptionOf(writeModbus(edge, "HOLDING_REGISTER", 10, 300))).toBe(2);
    expect(plc.holding[10]).toBe(0);
    // A value outside what the tag can hold is the gateway's mistake, said as such.
    await mapGatewayTag(deps, alice, connectionId, { tagId: tags.Speed_SP, access: "READ_WRITE" });
    await writeModbus(edge, "HOLDING_REGISTER", 10, 300);
    expect(plc.holding[10]).toBe(300);
  });

  it("says that the PLC does not answer instead of answering for it", async () => {
    await connectAndMap();
    await db.runtimePort.deleteMany({ where: { deviceInstanceId: plcId } });
    await db.deviceInstance.update({
      where: { id: plcId },
      data: { dockerContainerId: null, runtimeStatus: "STOPPED" },
    });
    // Within the time a PLC's endpoint is remembered the stand-in still answers; a fresh endpoint does not.
    await deps.endpoints.stopAll();
    deps.endpoints = new GatewayEndpointRuntime();
    await syncGatewayEndpoints(deps, factoryId);
    expect(await exceptionOf(readModbus(edge, "COIL", 80, 1))).toBe(11);
    expect(await exceptionOf(writeModbus(edge, "COIL", 80, true))).toBe(11);
    expect(plc.coils[80]).toBe(false);
    expect((await connection())?.plcState).toBe("STOPPED");
    // Nothing was sent, so no command is on record as accepted.
    expect(await db.deviceCommand.count({ where: { status: "ACCEPTED" } })).toBe(0);
  });

  it("closes the endpoint when the connection is disabled or removed, and opens it again on demand", async () => {
    const connectionId = await connectAndMap();
    expect(await readModbus(edge, "COIL", 80, 1)).toEqual([false]);

    await setGatewayConnectionEnabled(deps, alice, connectionId, false);
    expect(await exceptionOf(readModbus(edge, "COIL", 80, 1))).toBe("modbus-unreachable");
    expect(await connection()).toMatchObject({ enabled: false, endpoint: { listening: false } });
    expect((await db.gateway.findFirstOrThrow()).status).toBe("STOPPED");
    expect((await db.deviceInstance.findUniqueOrThrow({ where: { id: gatewayId } })).runtimeStatus).toBe("STOPPED");
    // The mappings are kept for when it is enabled again.
    expect((await connection())?.registers).toHaveLength(5);

    await setGatewayConnectionEnabled(deps, alice, connectionId, true);
    expect(await readModbus(edge, "COIL", 80, 1)).toEqual([false]);
    // The device that stands for the gateway shows the same state in every view of the factory.
    expect((await db.deviceInstance.findUniqueOrThrow({ where: { id: gatewayId } })).runtimeStatus).toBe("RUNNING");

    // After a server restart nothing listens until the factory's gateways are looked at again.
    await deps.endpoints.stopAll();
    deps.endpoints = new GatewayEndpointRuntime();
    expect(await exceptionOf(readModbus(edge, "COIL", 80, 1))).toBe("modbus-unreachable");
    await getGatewaysView(deps, alice, factoryId);
    expect(await readModbus(edge, "COIL", 80, 1)).toEqual([false]);

    await domainError(setGatewayConnectionEnabled(deps, bob, connectionId, false), "NOT_FOUND");
    await domainError(removeGatewayConnection(deps, bob, connectionId), "NOT_FOUND");
    await removeGatewayConnection(deps, alice, connectionId);
    expect(await exceptionOf(readModbus(edge, "COIL", 80, 1))).toBe("modbus-unreachable");
    expect(await db.gatewayTagMapping.count()).toBe(0);
    expect((await getGatewaysView(deps, alice, factoryId)).gateways[0]?.connections).toEqual([]);
  });

  it("reports a port another program holds instead of failing the screen", async () => {
    const blocker = await startTestPlc();
    try {
      await db.runtimePort.updateMany({ where: { deviceInstanceId: plcId }, data: { hostPort: 15_940 } });
      // The port is free in Z-Factory's records and inside the allowed range, but taken on the host.
      deps.policy = { ...deps.policy, portRange: { min: 1024, max: 65_535 } };
      await connectGateway(deps, alice, gatewayId, { plcId, host: HOST, port: blocker.port });
      expect((await connection())?.endpoint).toEqual({
        listening: false,
        error: "The port is in use by another program on this host.",
        clients: 0,
        requests: 0,
        refused: 0,
        lastRequestAt: null,
      });
      expect((await db.gateway.findFirstOrThrow()).status).toBe("FAULTED");
    } finally {
      await blocker.close();
    }
  });

  it("records an edge device coming and going", async () => {
    deps.endpoints = new GatewayEndpointRuntime({ visitQuietMs: 80 });
    await connectAndMap();
    const socket = connect({ host: HOST, port: PORT });
    await new Promise((resolve) => socket.on("connect", resolve));
    await expect.poll(async () => (await connection())?.endpoint.clients).toBe(1);
    // A device that polls with a connection per request is still one device that came once.
    for (let request = 0; request < 4; request += 1) await readModbus(edge, "COIL", 80, 1);
    socket.destroy();
    await expect
      .poll(async () => (await events()).filter(([type]) => type.startsWith("GATEWAY_CLIENT")).map(([type]) => type))
      .toEqual(["GATEWAY_CLIENT_CONNECTED", "GATEWAY_CLIENT_DISCONNECTED"]);
    const [, payload] = (await events()).find(([type]) => type === "GATEWAY_CLIENT_CONNECTED") ?? [];
    expect(payload).toMatchObject({ link: "gateway-endpoint", plcId });
    expect(String(payload?.name)).toMatch(/127\.0\.0\.1$/);
    // The events belong to the gateway device, not to the PLC: no PLC link alarm follows.
    expect(await db.alarmEvent.count()).toBe(0);
    expect((await db.runtimeEvent.findFirstOrThrow({ where: { type: "GATEWAY_CLIENT_CONNECTED" } })).deviceId).toBe(
      gatewayId,
    );
  });

  it("writes down for the edge device where to connect and what it may do", async () => {
    const connectionId = await connectGateway(deps, alice, gatewayId, {
      plcId,
      host: HOST,
      port: PORT,
      unitId: 3,
      pollIntervalMs: 500,
    }).then((result) => result.connectionId);
    await mapGatewayTag(deps, alice, connectionId, {
      tagId: tags.Speed_SP,
      access: "READ_WRITE",
      externalName: "pump.speed.sp",
    });
    await mapGatewayTag(deps, alice, connectionId, { tagId: tags.Speed_Actual, externalName: "pump.speed" });

    expect(await getGatewayMap(deps, alice, connectionId)).toEqual({
      schema: "z-factory.gateway-map",
      schemaVersion: 1,
      gateway: "GATEWAY-01",
      plc: "PLC-01",
      endpoint: { protocol: "MODBUS_TCP", host: HOST, port: PORT, unitId: 3 },
      pollIntervalMs: 500,
      conventions: { addressing: "zero-based", byteOrder: "BIG_ENDIAN", wordOrder: "HIGH_WORD_FIRST" },
      registers: [
        {
          name: "pump.speed.sp",
          tag: "Speed_SP",
          role: "SETPOINT",
          dataType: "INT16",
          area: "HOLDING_REGISTER",
          address: 10,
          displayAddress: "40011",
          wordCount: 1,
          access: "READ_WRITE",
          scale: 0.1,
          offset: 0,
          unit: null,
        },
        {
          name: "pump.speed",
          tag: "Speed_Actual",
          role: "FEEDBACK",
          dataType: "INT16",
          area: "HOLDING_REGISTER",
          address: 1124,
          displayAddress: "41125",
          wordCount: 1,
          access: "READ",
          scale: 0.1,
          offset: 0,
          unit: null,
        },
      ],
    });
    // The document names nothing of the host beyond the endpoint: no container, no management port.
    expect(JSON.stringify(await getGatewayMap(deps, alice, connectionId))).not.toMatch(/c0ffee|docker|apiHostPort/i);
    await domainError(getGatewayMap(deps, bob, connectionId), "NOT_FOUND");
    await domainError(getGatewayMap(deps, alice, "not-an-id"), "NOT_FOUND");
  });
});
