// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { loadCatalog } from "@/lib/catalog";
import { ingestCatalog } from "@/lib/catalog/ingest";
import { DomainError, type DomainErrorCode } from "@/lib/domain/errors";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { createFactory } from "@/lib/services/factory-service";
import { addPeripheral, getPlcConfiguration } from "@/lib/services/plc-config-service";
import {
  getTopology,
  linkDevices,
  moveDevices,
  placeDevice,
  removeDevice,
  renameDevice,
  unlinkDevices,
} from "@/lib/services/topology-service";
import { describeDb, openTestDb, resetDb } from "./harness";

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

/** The designer's topology service against PostgreSQL with the shipped catalog. */
describeDb("factory topology against PostgreSQL", () => {
  let db: PrismaClient;
  let factoryId: string;
  let counter = 0;

  const modelId = async (modelName: string) => (await db.deviceModel.findFirstOrThrow({ where: { modelName } })).id;
  const place = async (modelName: string, x = 0, y = 0, name?: string) =>
    placeDevice(db, alice, factoryId, { deviceModelId: await modelId(modelName), x, y, name });
  const link = (fromId: string, toId: string, kind?: string) =>
    linkDevices(db, alice, factoryId, { fromId, toId, kind });
  const edges = async () =>
    (await getTopology(db, alice, factoryId)).edges.map((edge) => [
      edge.relationship,
      edge.sourceId,
      edge.targetId,
      edge.wires.length,
    ]);

  beforeAll(async () => {
    db = openTestDb();
    await resetDb(db);
    await ingestCatalog(db, loadCatalog());
  });
  beforeEach(async () => {
    counter += 1;
    factoryId = (
      await createFactory(db, alice, {
        name: `Plant ${counter}`,
        slug: `plant-${counter}`,
        subnetCidr: `172.23.${counter}.0/24`,
      })
    ).id;
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("starts empty with the catalog as palette, PLCs first", async () => {
    const view = await getTopology(db, alice, factoryId);
    expect(view.nodes).toEqual([]);
    expect(view.edges).toEqual([]);
    expect(view.palette[0]).toMatchObject({ categoryCode: "PLC" });
    expect(view.palette[0]?.items.map((item) => item.modelName)).toEqual([
      "5069-L306ER",
      "CPU 1214C DC/DC/DC",
      "CPU 1511-1 PN",
      "TM241CE24T",
    ]);
    expect(view.palette.reduce((count, group) => count + group.items.length, 0)).toBe(30);
    await expectDomainError(getTopology(db, bob, factoryId), "NOT_FOUND");
  });

  it("places catalog models as uniquely named device instances at a position", async () => {
    const plc = await place("CPU 1214C DC/DC/DC", 120, 80);
    const first = await place("Generic VFD, hardwired control", 400, 80);
    const second = await place("Generic VFD, hardwired control", 400, 240);
    expect([plc.name, first.name, second.name]).toEqual(["PLC-01", "VFD-01", "VFD-02"]);
    await expectDomainError(place("Generic fan", 0, 0, "VFD-01"), "CONFLICT");
    await expectDomainError(
      placeDevice(db, bob, factoryId, { deviceModelId: await modelId("Generic fan"), x: 0, y: 0 }),
      "NOT_FOUND",
    );

    const view = await getTopology(db, alice, factoryId);
    expect(view.nodes.map((node) => [node.name, node.x, node.y, node.placed, node.architectureType])).toEqual([
      ["PLC-01", 120, 80, true, "COMPACT"],
      ["VFD-01", 400, 80, true, null],
      ["VFD-02", 400, 240, true, null],
    ]);
    // A PLC placed on the canvas is a complete PLC: it has its I/O points.
    expect((await getPlcConfiguration(db, alice, plc.id)).occupancy.total).toBe(26);
  });

  it("saves and reloads node positions, and gives unplaced devices a grid slot", async () => {
    const plc = await place("CPU 1214C DC/DC/DC");
    // Created from the PLC's connections screen: it has no canvas position yet.
    const { deviceId } = await addPeripheral(db, alice, plc.id, {
      deviceModelId: await modelId("Generic push button, 24 V DC"),
      name: "HS-01",
    });
    let view = await getTopology(db, alice, factoryId);
    expect(view.nodes.find((node) => node.id === deviceId)).toMatchObject({ placed: false, x: 300, y: 60 });

    await moveDevices(db, alice, factoryId, [
      { deviceId: plc.id, x: 512.5, y: -40 },
      { deviceId, x: 90, y: 300 },
    ]);
    view = await getTopology(db, alice, factoryId);
    expect(view.nodes.map((node) => [node.name, node.x, node.y, node.placed])).toEqual([
      ["PLC-01", 512.5, -40, true],
      ["HS-01", 90, 300, true],
    ]);

    await expectDomainError(moveDevices(db, bob, factoryId, [{ deviceId, x: 1, y: 1 }]), "NOT_FOUND");
    await expectDomainError(
      moveDevices(db, alice, factoryId, [{ deviceId: "00000000-0000-7000-8000-000000000000", x: 1, y: 1 }]),
      "NOT_FOUND",
    );
    await expectDomainError(moveDevices(db, alice, factoryId, [{ deviceId, x: Number.NaN, y: 1 }]), "VALIDATION");
  });

  it("creates typed edges for drive, shaft and measurement relationships", async () => {
    const vfd = await place("Generic VFD, hardwired control");
    const motor = await place("Generic three-phase motor");
    const pump = await place("Generic centrifugal pump");
    const sensor = await place("Generic pressure transmitter, 4–20 mA");

    // Drawn from the motor to the drive: stored as the drive driving the motor.
    expect(await link(motor.id, vfd.id)).toEqual({ status: "LINKED" });
    await link(motor.id, pump.id);
    await link(sensor.id, pump.id);
    expect(await edges()).toEqual([
      ["DRIVES", vfd.id, motor.id, 0],
      ["MECHANICALLY_DRIVES", motor.id, pump.id, 0],
      ["MEASURES", sensor.id, pump.id, 0],
    ]);

    // One drive per motor, and no relationship at all between two pumps.
    const other = await place("Generic VFD, hardwired control");
    await expectDomainError(link(other.id, motor.id), "INVARIANT", "one-drive-per-motor");
    await expectDomainError(link(pump.id, (await place("Generic centrifugal pump")).id), "INCOMPATIBLE", "no-link");
    // Drawing the same drive connection again runs into the same rule.
    await expectDomainError(link(vfd.id, motor.id), "INVARIANT", "one-motor-per-drive");
  });

  it("wires a device to free PLC channels and shows the wires on typed edges", async () => {
    const plc = await place("CPU 1214C DC/DC/DC");
    const valve = await place("Generic on/off valve, 24 V DC");
    expect(await link(valve.id, plc.id)).toEqual({ status: "LINKED" });

    const view = await getTopology(db, alice, factoryId);
    expect(view.edges.map((edge) => [edge.relationship, edge.sourceId, edge.targetId])).toEqual([
      ["CONTROLS", plc.id, valve.id],
      ["FEEDS_BACK_TO", valve.id, plc.id],
    ]);
    expect(view.edges[0]?.wires).toEqual([
      { terminalLabel: "Y1", pointLabel: "DO Qa.0", logicalAddress: "%QX0.0", tagName: "VALVE_01_Y1" },
    ]);
    expect(view.edges[1]?.wires.map((wire) => [wire.terminalLabel, wire.pointLabel])).toEqual([
      ["ZSC", "DI Ia.0"],
      ["ZSO", "DI Ia.1"],
    ]);
    expect((await getPlcConfiguration(db, alice, plc.id)).occupancy.occupied).toBe(3);
    await expectDomainError(link(plc.id, valve.id), "CONFLICT", "already-connected");
  });

  it("refuses a connection when the PLC has no free compatible endpoint", async () => {
    const plc = await place("CPU 1214C DC/DC/DC");
    // The built-in analog inputs take 0–10 V only.
    const current = await place("Generic pressure transmitter, 4–20 mA");
    await expectDomainError(link(plc.id, current.id), "INCOMPATIBLE", "no-free-channel");

    // Two analog inputs: the third transmitter finds both occupied.
    for (const name of ["PT-101", "PT-102"]) {
      await link(plc.id, (await place("Generic pressure transmitter, 0–10 V", 0, 0, name)).id);
    }
    const third = await place("Generic pressure transmitter, 0–10 V", 0, 0, "PT-103");
    await expectDomainError(link(plc.id, third.id), "INCOMPATIBLE", "no-free-channel");
    expect((await getTopology(db, alice, factoryId)).edges).toHaveLength(2);
    expect(await db.tag.count({ where: { plcInstanceId: plc.id } })).toBe(2);

    // Two PLCs are not connected on the canvas.
    await expectDomainError(link(plc.id, (await place("TM241CE24T")).id), "INCOMPATIBLE", "no-link");
  });

  it("links protocol devices over a shared protocol and asks when several relationships are possible", async () => {
    const plc = await place("CPU 1214C DC/DC/DC");
    const drive = await place("Generic VFD, Modbus TCP");
    await link(drive.id, plc.id);
    const view = await getTopology(db, alice, factoryId);
    expect(view.edges).toMatchObject([
      { relationship: "COMMUNICATES_WITH", sourceId: plc.id, targetId: drive.id, protocol: "MODBUS_TCP", wires: [] },
    ]);
    await expectDomainError(link(plc.id, drive.id), "CONFLICT", "already-connected");

    const contactor = await place("Generic contactor, 24 V DC coil");
    const pressureSwitch = await place("Generic pressure switch, 24 V DC");
    const asked = await link(contactor.id, pressureSwitch.id);
    expect(asked).toEqual({
      status: "CHOOSE",
      options: [
        { kind: "MEASURES", label: "SWITCH-01 measures CONTACTOR-01" },
        { kind: "CONTROLS", label: "CONTACTOR-01 controls SWITCH-01" },
      ],
    });
    expect((await getTopology(db, alice, factoryId)).edges).toHaveLength(1);
    expect(await link(contactor.id, pressureSwitch.id, "CONTROLS")).toEqual({ status: "LINKED" });
    await expectDomainError(link(contactor.id, pressureSwitch.id, "DRIVES"), "INCOMPATIBLE", "link-kind");
  });

  it("removes an edge; a PLC wiring goes as a whole and frees its channels", async () => {
    const plc = await place("CPU 1214C DC/DC/DC");
    const valve = await place("Generic on/off valve, 24 V DC");
    const vfd = await place("Generic VFD, hardwired control");
    const motor = await place("Generic three-phase motor");
    await link(plc.id, valve.id);
    await link(vfd.id, motor.id);

    await unlinkDevices(db, alice, factoryId, { sourceId: vfd.id, targetId: motor.id, relationship: "DRIVES" });
    await expectDomainError(
      unlinkDevices(db, alice, factoryId, { sourceId: vfd.id, targetId: motor.id, relationship: "DRIVES" }),
      "NOT_FOUND",
    );
    // Removing the feedback edge removes the control edge too.
    await unlinkDevices(db, alice, factoryId, { sourceId: valve.id, targetId: plc.id, relationship: "FEEDS_BACK_TO" });
    expect(await edges()).toEqual([]);
    expect((await getPlcConfiguration(db, alice, plc.id)).occupancy.occupied).toBe(0);
    expect(await db.tag.count({ where: { plcInstanceId: plc.id } })).toBe(0);
    expect((await getTopology(db, alice, factoryId)).nodes).toHaveLength(4);
    await expectDomainError(
      unlinkDevices(db, bob, factoryId, { sourceId: valve.id, targetId: plc.id, relationship: "CONTROLS" }),
      "NOT_FOUND",
    );
  });

  it("renames and deletes devices, freeing what a deleted device occupied", async () => {
    const plc = await place("CPU 1214C DC/DC/DC");
    const valve = await place("Generic on/off valve, 24 V DC");
    const fan = await place("Generic fan");
    await link(plc.id, valve.id);

    await renameDevice(db, alice, valve.id, { name: "XV-101", role: "Inlet valve" });
    await expectDomainError(renameDevice(db, alice, fan.id, { name: "XV-101" }), "CONFLICT");
    await expectDomainError(renameDevice(db, alice, fan.id, { name: "no spaces allowed" }), "VALIDATION");
    await expectDomainError(renameDevice(db, bob, fan.id, { name: "FAN-09" }), "NOT_FOUND");
    expect((await getTopology(db, alice, factoryId)).nodes.find((node) => node.id === valve.id)).toMatchObject({
      name: "XV-101",
      role: "Inlet valve",
    });

    await removeDevice(db, alice, valve.id);
    expect((await getPlcConfiguration(db, alice, plc.id)).occupancy.occupied).toBe(0);
    expect(await db.tag.count({ where: { plcInstanceId: plc.id } })).toBe(0);
    await expectDomainError(removeDevice(db, bob, fan.id), "NOT_FOUND");
    await removeDevice(db, alice, plc.id);
    expect((await getTopology(db, alice, factoryId)).nodes.map((node) => node.name)).toEqual(["FAN-01"]);
  });

  it("carries runtime state for the overlay and never a Docker id", async () => {
    const plc = await place("CPU 1214C DC/DC/DC");
    const vfd = await place("Generic VFD, hardwired control");
    await db.deviceInstance.update({
      where: { id: plc.id },
      data: { runtimeStatus: "RUNNING", dockerContainerId: "docker-secret-id-123" },
    });
    await db.deviceInstance.update({ where: { id: vfd.id }, data: { runtimeStatus: "FAULTED" } });

    const view = await getTopology(db, alice, factoryId);
    expect(view.nodes.map((node) => [node.name, node.runtimeStatus])).toEqual([
      ["PLC-01", "RUNNING"],
      ["VFD-01", "FAULTED"],
    ]);
    expect(view.nodes.every((node) => /^[0-9a-f-]{36}$/.test(node.id))).toBe(true);
    expect(JSON.stringify(view)).not.toMatch(/docker/i);
  });
});
