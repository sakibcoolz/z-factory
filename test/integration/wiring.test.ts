// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { loadCatalog } from "@/lib/catalog";
import { ingestCatalog } from "@/lib/catalog/ingest";
import { DomainError, type DomainErrorCode } from "@/lib/domain/errors";
import type { PairWiringView } from "@/lib/domain/wiring-view";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { createFactory } from "@/lib/services/factory-service";
import { createPlc, getPlcConfiguration } from "@/lib/services/plc-config-service";
import { planSimulation } from "@/lib/services/simulation-service";
import { getTopology, linkDevices, placeDevice, removeDevice, unlinkDevices } from "@/lib/services/topology-service";
import { connectWire, disconnectWire, getPairWiring, reconnectWire } from "@/lib/services/wiring-service";
import { describeDb, openTestDb, resetDb } from "./harness";

/**
 * Pin-to-pin wiring against PostgreSQL with the shipped catalog: one wire between two
 * exact endpoints, what refuses it, what it creates on a PLC channel, shared endpoints,
 * and moving or removing a wire.
 */
const alice = { ownerId: "alice" };
const bob = { ownerId: "bob" };

const PLC = "CPU 1214C DC/DC/DC";
const PT_VOLTAGE = "Generic pressure transmitter, 0–10 V";
const PT_CURRENT = "Generic pressure transmitter, 4–20 mA";
const VALVE = "Generic on/off valve, 24 V DC";
const SWITCH = "Generic limit switch, 24 V DC";
const SUPPLY = "Generic 24 V DC power supply";
const VFD = "Generic VFD, hardwired control";

async function refused(action: Promise<unknown>, code: DomainErrorCode, rule?: string): Promise<DomainError> {
  const error = await action.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe(code);
  if (rule) expect((error as DomainError).details.rule).toBe(rule);
  return error as DomainError;
}

describeDb("pin-to-pin wiring", () => {
  let db: PrismaClient;
  let factories = 0;
  let factoryId: string;
  let plcId: string;

  const modelId = async (modelName: string) =>
    (await db.deviceModel.findFirstOrThrow({ where: { modelName }, select: { id: true } })).id;
  const newFactory = async (owner = alice) => {
    factories += 1;
    const input = { name: `Plant ${factories}`, slug: `plant-${factories}`, subnetCidr: `172.22.${factories}.0/24` };
    return (await createFactory(db, owner, input)).id;
  };
  const place = async (modelName: string, name: string, inFactory = factoryId) =>
    (await placeDevice(db, alice, inFactory, { deviceModelId: await modelId(modelName), x: 0, y: 0, name })).id;
  const pair = (firstId: string, secondId: string, replacing?: string) =>
    getPairWiring(db, alice, factoryId, firstId, secondId, replacing);

  /** The end of a wire: an endpoint of one side of a pair, found by its label. */
  const end = (view: PairWiringView, side: "first" | "second", label: string | RegExp, nth = 0) => {
    const matches = view[side].endpoints.filter((endpoint) =>
      typeof label === "string" ? endpoint.label === label : label.test(endpoint.label),
    );
    const endpoint = matches[nth];
    if (!endpoint) throw new Error(`no endpoint ${String(label)} #${nth} on ${view[side].name}`);
    return { deviceId: view[side].deviceId, type: endpoint.type, id: endpoint.id };
  };
  const wire = (from: unknown, to: unknown) => connectWire(db, alice, factoryId, { from, to });
  const pointStatus = async (pointId: string) =>
    (await db.plcIoPoint.findUniqueOrThrow({ where: { id: pointId } })).status;
  const tagNames = async () =>
    (await db.tag.findMany({ where: { plcInstanceId: plcId }, orderBy: { name: "asc" } })).map((tag) => tag.name);

  beforeAll(async () => {
    db = openTestDb();
    await resetDb(db);
    await ingestCatalog(db, loadCatalog());
  });
  afterAll(async () => {
    await db.$disconnect();
  });
  beforeEach(async () => {
    factoryId = await newFactory();
    plcId = (await createPlc(db, alice, { factoryId, deviceModelId: await modelId(PLC), name: "PLC-01" })).id;
  });

  it("lists every endpoint of two devices and wires nothing by itself", async () => {
    const vfd = await place(VFD, "VFD-01");

    // Drawing an edge between a PLC and a device opens the wiring; it stores nothing.
    expect(await linkDevices(db, alice, factoryId, { fromId: vfd, toId: plcId })).toEqual({
      status: "WIRE",
      firstId: plcId,
      secondId: vfd,
    });
    expect(await db.deviceConnection.count({ where: { factoryId } })).toBe(0);
    expect(await db.tag.count({ where: { plcInstanceId: plcId } })).toBe(0);

    const view = await pair(plcId, vfd);
    expect(view.wires).toEqual([]);
    expect(view.first.endpoints.filter((endpoint) => endpoint.type === "PLC_IO_POINT")).toHaveLength(26);
    expect(view.second.endpoints.map((endpoint) => [endpoint.label, endpoint.kind, endpoint.summary])).toEqual([
      ["FAULT", "SIGNAL", "digital output · 24 V DC"],
      ["FREQ", "SIGNAL", "analog output · 0–10 V"],
      ["REF", "SIGNAL", "analog input · 0–10 V"],
      ["RESET", "SIGNAL", "digital input · 24 V DC"],
      ["REV", "SIGNAL", "digital input · 24 V DC"],
      ["RUN", "SIGNAL", "digital input · 24 V DC"],
      ["RUNNING", "SIGNAL", "digital output · 24 V DC"],
      ["COM", "COMMON", "0 V / common"],
      ["PE", "EARTH", "protective earth"],
    ]);
    // The editor knows before anything is saved which destinations are refused, and why.
    const run = view.second.endpoints.find((endpoint) => endpoint.label === "RUN");
    const firstInput = view.first.endpoints.find((endpoint) => endpoint.label.startsWith("DI "));
    const firstOutput = view.first.endpoints.find((endpoint) => endpoint.label.startsWith("DO "));
    if (!run || !firstInput || !firstOutput) throw new Error("endpoints missing");
    expect(view.refusals[firstInput.key]?.[run.key]).toBe(
      `PLC-01 / ${firstInput.label} and VFD-01 / RUN both read a signal; an output is wired to an input.`,
    );
    expect(view.refusals[firstOutput.key]?.[run.key]).toBeUndefined();
  });

  it("stores one exact wire and gives a PLC channel its tag", async () => {
    const pt = await place(PT_VOLTAGE, "PT-101");
    const view = await pair(pt, plcId);
    const input = end(view, "second", /^AI /, 1);

    const { wireId } = await wire(end(view, "first", "OUT"), input);

    const stored = await db.deviceConnection.findUniqueOrThrow({ where: { id: wireId } });
    expect(stored).toMatchObject({
      sourceDeviceId: pt,
      sourceEndpointType: "DEVICE_IO",
      targetDeviceId: plcId,
      targetEndpointType: "PLC_IO_POINT",
      targetEndpointRef: input.id,
      relationship: "FEEDS_BACK_TO",
    });
    expect(await pointStatus(input.id)).toBe("OCCUPIED");
    const tag = await db.tag.findFirstOrThrow({ where: { plcIoPointId: input.id } });
    expect(tag).toMatchObject({ name: "PT_101_OUT", sourceDeviceInstanceId: pt, sourceSignal: "value" });

    // Reloaded, the wire is there with both ends by name, its tag and its address.
    const reloaded = await pair(pt, plcId);
    expect(reloaded.wires).toEqual([
      {
        id: wireId,
        kind: "SIGNAL",
        from: expect.objectContaining({ name: "PT-101 / OUT", deviceId: pt }),
        to: expect.objectContaining({ deviceId: plcId, endpointId: input.id }),
        tagName: "PT_101_OUT",
        logicalAddress: tag.logicalAddress,
      },
    ]);
    // The same wiring is what the PLC screens, the simulator and the topology read.
    const config = await getPlcConfiguration(db, alice, plcId);
    expect(config.peripherals.map((peripheral) => [peripheral.name, peripheral.wires.length])).toEqual([["PT-101", 1]]);
    expect((await planSimulation(db, alice, factoryId)).devices.map((device) => device.name)).toEqual(["PT-101"]);
    const topology = await getTopology(db, alice, factoryId);
    expect(topology.edges).toEqual([
      expect.objectContaining({ id: `${plcId}|${pt}|WIRED_TO`, relationship: "WIRED_TO", sourceId: plcId }),
    ]);
    expect(topology.edges[0]?.wires.map((item) => item.id)).toEqual([wireId]);
  });

  it("refuses a wrong pin, naming both ends and the rule, and stores nothing", async () => {
    const current = await place(PT_CURRENT, "PT-102");
    const valve = await place(VALVE, "XV-101");
    const transmitter = await pair(current, plcId);
    const out = end(transmitter, "first", "OUT");

    const range = await refused(wire(out, end(transmitter, "second", /^AI /)), "INCOMPATIBLE", "wire-signal-type");
    expect(range.message).toMatch(/^PT-102 \/ OUT is 4–20 mA; PLC-01 \/ AI .+ takes 0–10 V\.$/);
    expect(range.details).toMatchObject({ from: "PT-102 / OUT" });
    await refused(wire(out, end(transmitter, "second", /^DI /)), "INCOMPATIBLE", "wire-signal-class");

    const valveView = await pair(valve, plcId);
    const direction = await refused(
      wire(end(valveView, "first", "Y1"), end(valveView, "second", /^DI /)),
      "INCOMPATIBLE",
      "wire-direction",
    );
    expect(direction.message).toContain("both read a signal");
    await refused(
      wire(end(valveView, "first", "ZSO"), end(valveView, "second", /^DO /)),
      "INCOMPATIBLE",
      "wire-direction",
    );
    // A supply terminal is no signal.
    await refused(
      wire(end(transmitter, "first", "+24V"), end(transmitter, "second", /^DI /)),
      "INCOMPATIBLE",
      "wire-kind",
    );
    // Two endpoints of one device.
    await refused(
      wire(end(valveView, "first", "ZSO"), { ...end(valveView, "first", "Y1") }),
      "VALIDATION",
      "wire-same-device",
    );

    expect(await db.deviceConnection.count({ where: { factoryId } })).toBe(0);
    expect(await db.tag.count({ where: { plcInstanceId: plcId } })).toBe(0);
    expect(await db.plcIoPoint.count({ where: { plcInstanceId: plcId, status: "OCCUPIED" } })).toBe(0);
  });

  it("gives a signal endpoint one wire", async () => {
    const first = await place(SWITCH, "LS-1");
    const second = await place(SWITCH, "LS-2");
    const view = await pair(first, plcId);
    const input = end(view, "second", /^DI /, 0);
    await wire(end(view, "first", "OUT"), input);

    // The PLC input is taken …
    const other = await pair(second, plcId);
    const taken = await refused(wire(end(other, "first", "OUT"), input), "OCCUPIED_ENDPOINT", "wire-occupied");
    expect(taken.message).toMatch(/^PLC-01 \/ DI .+ already has its wire, to LS-1 \/ OUT\.$/);
    // … and so is the switch's output, for any other input.
    await refused(
      wire(end(view, "first", "OUT"), end(view, "second", /^DI /, 1)),
      "OCCUPIED_ENDPOINT",
      "wire-occupied",
    );
    // Another switch of the same model is another endpoint: it takes the next input.
    await wire(end(other, "first", "OUT"), end(other, "second", /^DI /, 1));
    expect(await tagNames()).toEqual(["LS_1_OUT", "LS_2_OUT"]);
    // The editor shows the refusal before saving.
    const again = await pair(second, plcId);
    const out = again.first.endpoints.find((endpoint) => endpoint.label === "OUT");
    expect(Object.values(again.refusals[out?.key ?? ""] ?? {})).toHaveLength(again.second.endpoints.length);
  });

  it("gives a channel to one of several wires made at the same time", async () => {
    const switches = await Promise.all(["LS-1", "LS-2", "LS-3", "LS-4"].map((name) => place(SWITCH, name)));
    const views = await Promise.all(switches.map((id) => pair(id, plcId)));
    await Promise.all(switches.map(() => db.$executeRaw`SELECT pg_sleep(0.05)`));

    const results = await Promise.allSettled(
      views.map((view) => wire(end(view, "first", "OUT"), end(view, "second", /^DI /, 0))),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await db.deviceConnection.count({ where: { factoryId } })).toBe(1);
    expect(await db.tag.count({ where: { plcInstanceId: plcId } })).toBe(1);
  });

  it("shares supply, 0 V and earth terminals within the number of wires they take", async () => {
    const supply = await place(SUPPLY, "PS-01");
    const vfd = await place(VFD, "VFD-01");
    const transmitters = [];
    for (let index = 1; index <= 9; index += 1) transmitters.push(await place(PT_CURRENT, `PT-10${index}`));

    for (const pt of transmitters.slice(0, 8)) {
      const view = await pair(supply, pt);
      await wire(end(view, "first", "+24V"), end(view, "second", "+24V"));
    }
    const ninth = await pair(supply, transmitters[8] ?? "");
    const full = await refused(
      wire(end(ninth, "first", "+24V"), end(ninth, "second", "+24V")),
      "OCCUPIED_ENDPOINT",
      "wire-occupied",
    );
    expect(full.message).toBe("PS-01 / +24V already has 8 of the 8 wires it takes.");

    // 0 V to 0 V and earth to earth; the wire is stored as a wire, not as PLC I/O.
    const first = await pair(supply, transmitters[0] ?? "");
    const common = await wire(end(first, "second", "0V"), end(first, "first", "0V"));
    expect(await db.deviceConnection.findUniqueOrThrow({ where: { id: common.wireId } })).toMatchObject({
      relationship: "WIRED_TO",
      sourceEndpointType: "DEVICE_IO",
      targetEndpointType: "DEVICE_IO",
    });
    await refused(wire(end(first, "first", "0V"), end(first, "second", "0V")), "CONFLICT", "wire-duplicate");
    const drive = await pair(supply, vfd);
    await wire(end(drive, "first", "PE"), end(drive, "second", "PE"));
    await wire(end(drive, "first", "0V"), end(drive, "second", "COM"));
    // Shared endpoints are still checked: a supply does not feed a 0 V terminal or another supply's output.
    await refused(wire(end(first, "first", "+24V"), end(first, "second", "0V")), "INCOMPATIBLE", "wire-kind");
    await refused(wire(end(drive, "first", "PE"), end(drive, "second", "COM")), "INCOMPATIBLE", "wire-kind");
    // The transmitter's own supply input takes one wire.
    const second = await place(SUPPLY, "PS-02");
    const double = await pair(second, transmitters[0] ?? "");
    await refused(
      wire(end(double, "first", "+24V"), end(double, "second", "+24V")),
      "OCCUPIED_ENDPOINT",
      "wire-occupied",
    );

    // None of this touched a PLC: no tag, no channel.
    expect(await db.tag.count({ where: { plcInstanceId: plcId } })).toBe(0);
    // All the wires of two devices are one edge.
    const edges = (await getTopology(db, alice, factoryId)).edges;
    expect(edges.filter((edge) => edge.relationship === "WIRED_TO")).toHaveLength(9);
    expect(edges.find((edge) => edge.id.includes(vfd))?.wires.map((item) => [item.from.name, item.to.name])).toEqual([
      ["PS-01 / PE", "VFD-01 / PE"],
      ["PS-01 / 0V", "VFD-01 / COM"],
    ]);
  });

  it("does not overfill a shared terminal when wires are made at the same time", async () => {
    const supply = await place(SUPPLY, "PS-01");
    const names = Array.from({ length: 10 }, (_, index) => `PT-2${index}`);
    const transmitters = [];
    for (const name of names) transmitters.push(await place(PT_CURRENT, name));
    const views = await Promise.all(transmitters.map((pt) => pair(supply, pt)));
    await Promise.all(views.map(() => db.$executeRaw`SELECT pg_sleep(0.05)`));

    const results = await Promise.allSettled(
      views.map((view) => wire(end(view, "first", "+24V"), end(view, "second", "+24V"))),
    );

    // The supply terminal takes eight wires: eight are stored, two are refused.
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(8);
    for (const result of results) {
      if (result.status === "rejected") expect((result.reason as DomainError).details.rule).toBe("wire-occupied");
    }
    expect(await db.deviceConnection.count({ where: { factoryId } })).toBe(8);
  });

  it("wires a signal from one device to another when the reading end takes it", async () => {
    const pt = await place(PT_VOLTAGE, "PT-101");
    const current = await place(PT_CURRENT, "PT-102");
    const vfd = await place(VFD, "VFD-01");

    const view = await pair(pt, vfd);
    const { wireId } = await wire(end(view, "first", "OUT"), end(view, "second", "REF"));
    expect(await db.deviceConnection.findUniqueOrThrow({ where: { id: wireId } })).toMatchObject({
      sourceDeviceId: pt,
      targetDeviceId: vfd,
      relationship: "WIRED_TO",
    });
    const mismatch = await pair(current, vfd);
    // REF is taken by now; the first reason given is the electrical one.
    await refused(
      wire(end(mismatch, "first", "OUT"), end(mismatch, "second", "REF")),
      "INCOMPATIBLE",
      "wire-signal-type",
    );
    await refused(wire(end(view, "first", "OUT"), end(view, "second", "FREQ")), "INCOMPATIBLE", "wire-direction");
  });

  it("moves a wire only when the new one is allowed", async () => {
    const pt = await place(PT_VOLTAGE, "PT-101");
    const view = await pair(pt, plcId);
    const [out, first, second] = [
      end(view, "first", "OUT"),
      end(view, "second", /^AI /, 0),
      end(view, "second", /^AI /, 1),
    ];
    const { wireId } = await wire(out, first);
    const before = await db.tag.findFirstOrThrow({ where: { plcIoPointId: first.id } });

    // Asked for this wire, the editor does not count its own ends as taken.
    const moving = await pair(pt, plcId, wireId);
    const outKey = moving.first.endpoints.find((endpoint) => endpoint.label === "OUT")?.key ?? "";
    expect(moving.refusals[outKey]?.[`PLC_IO_POINT:${second.id}`]).toBeUndefined();
    expect((await pair(pt, plcId)).refusals[outKey]?.[`PLC_IO_POINT:${second.id}`]).toContain("already has its wire");

    // A refused replacement leaves the old wire, its tag and its channel as they were.
    const input = end(view, "second", /^DI /);
    await refused(
      reconnectWire(db, alice, factoryId, wireId, { from: out, to: input }),
      "INCOMPATIBLE",
      "wire-signal-class",
    );
    expect(await db.deviceConnection.count({ where: { id: wireId } })).toBe(1);
    expect(await db.tag.findFirstOrThrow({ where: { plcIoPointId: first.id } })).toEqual(before);

    // An allowed one replaces it: one wire, one tag, at the new channel.
    const moved = await reconnectWire(db, alice, factoryId, wireId, { from: out, to: second });
    expect(await db.deviceConnection.count({ where: { factoryId } })).toBe(1);
    expect(await db.deviceConnection.count({ where: { id: wireId } })).toBe(0);
    expect(await pointStatus(first.id)).toBe("FREE");
    expect(await pointStatus(second.id)).toBe("OCCUPIED");
    const after = await db.tag.findFirstOrThrow({ where: { plcIoPointId: second.id } });
    expect(after.name).toBe("PT_101_OUT");
    expect(after.logicalAddress).not.toBe(before.logicalAddress);
    expect(await tagNames()).toEqual(["PT_101_OUT"]);
    expect((await pair(pt, plcId)).wires.map((item) => item.id)).toEqual([moved.wireId]);
  });

  it("removes one wire, or every wire of an edge, and frees what they held", async () => {
    const valve = await place(VALVE, "XV-101");
    const view = await pair(plcId, valve);
    const open = await wire(end(view, "first", /^DO /), end(view, "second", "Y1"));
    await wire(end(view, "second", "ZSO"), end(view, "first", /^DI /, 0));
    await wire(end(view, "second", "ZSC"), end(view, "first", /^DI /, 1));
    expect(await tagNames()).toEqual(["XV_101_Y1", "XV_101_ZSC", "XV_101_ZSO"]);
    const edge = (await getTopology(db, alice, factoryId)).edges;
    expect(edge.map((item) => [item.relationship, item.wires.length])).toEqual([["WIRED_TO", 3]]);

    await disconnectWire(db, alice, factoryId, open.wireId);
    expect(await tagNames()).toEqual(["XV_101_ZSC", "XV_101_ZSO"]);
    expect(await db.plcIoPoint.count({ where: { plcInstanceId: plcId, status: "OCCUPIED" } })).toBe(2);
    await refused(disconnectWire(db, alice, factoryId, open.wireId), "NOT_FOUND");

    await unlinkDevices(db, alice, factoryId, { sourceId: plcId, targetId: valve, relationship: "WIRED_TO" });
    expect(await tagNames()).toEqual([]);
    expect(await db.plcIoPoint.count({ where: { plcInstanceId: plcId, status: "OCCUPIED" } })).toBe(0);
    expect(await db.deviceConnection.count({ where: { factoryId } })).toBe(0);
    await refused(
      unlinkDevices(db, alice, factoryId, { sourceId: plcId, targetId: valve, relationship: "WIRED_TO" }),
      "NOT_FOUND",
    );
    // The device is still there, and deleting a wired device frees its channels too.
    const again = await pair(plcId, valve);
    await wire(end(again, "first", /^DO /), end(again, "second", "Y1"));
    await removeDevice(db, alice, valve);
    expect(await tagNames()).toEqual([]);
    expect(await db.plcIoPoint.count({ where: { plcInstanceId: plcId, status: "OCCUPIED" } })).toBe(0);
  });

  it("keeps wiring inside one factory and one owner", async () => {
    const pt = await place(PT_VOLTAGE, "PT-101");
    const view = await pair(pt, plcId);
    const [out, input] = [end(view, "first", "OUT"), end(view, "second", /^AI /)];
    const otherFactory = await newFactory();
    const foreign = await place(PT_VOLTAGE, "PT-900", otherFactory);

    // A device of another factory is not a device of this one.
    await refused(wire({ ...out, deviceId: foreign }, input), "NOT_FOUND");
    await refused(getPairWiring(db, alice, factoryId, foreign, plcId), "NOT_FOUND");
    // An endpoint that is not on the device it is claimed for.
    await refused(wire({ ...out, id: input.id }, input), "NOT_FOUND");
    await refused(wire({ ...out, type: "TAG" }, input), "VALIDATION");
    // Another owner sees no factory.
    await refused(connectWire(db, bob, factoryId, { from: out, to: input }), "NOT_FOUND");
    await refused(getPairWiring(db, bob, factoryId, pt, plcId), "NOT_FOUND");
    const { wireId } = await wire(out, input);
    await refused(disconnectWire(db, bob, factoryId, wireId), "NOT_FOUND");
    await refused(reconnectWire(db, bob, factoryId, wireId, { from: out, to: input }), "NOT_FOUND");
    await refused(disconnectWire(db, alice, otherFactory, wireId), "NOT_FOUND");
    expect(await db.deviceConnection.count({ where: { id: wireId } })).toBe(1);
  });
});
