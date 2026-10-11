// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { loadCatalog } from "@/lib/catalog";
import { ingestCatalog } from "@/lib/catalog/ingest";
import { DomainError, type DomainErrorCode } from "@/lib/domain/errors";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { getDeviceDetail, isControllerDevice, saveDeviceParameters } from "@/lib/services/device-detail-service";
import { createFactory } from "@/lib/services/factory-service";
import { createPlc, getPlcConfiguration } from "@/lib/services/plc-config-service";
import {
  checkProgram,
  createProgramVersion,
  deployProgramVersion,
  listProgramVersions,
} from "@/lib/services/plc-runtime-service";
import { getFactoryDeviceTree } from "@/lib/services/plc-config-service";
import { planSimulation } from "@/lib/services/simulation-service";
import { placeDevice } from "@/lib/services/topology-service";
import { createGenericModel, describeDb, openTestDb, resetDb, wireAllSignals } from "./harness";

/**
 * Capability-driven device screens against PostgreSQL (TASK-308): what a device shows
 * follows its exact catalog model; a programmable RTU takes the PLC program workflow; a
 * configurable drive stores parameter versions; deploy is refused for what a model cannot do.
 */
const alice = { ownerId: "alice" };
const bob = { ownerId: "bob" };

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

describeDb("capability-driven device screens", () => {
  let db: PrismaClient;
  let factories = 0;
  let factoryId: string;

  const modelId = async (modelName: string) =>
    (await db.deviceModel.findFirstOrThrow({ where: { modelName }, select: { id: true } })).id;
  const place = async (modelName: string, name: string) =>
    (await placeDevice(db, alice, factoryId, { deviceModelId: await modelId(modelName), x: 0, y: 0, name })).id;
  const sections = async (deviceId: string) =>
    (await getDeviceDetail(db, alice, deviceId)).sections.map((section) => section.key);

  beforeAll(async () => {
    db = openTestDb();
    await resetDb(db);
    await ingestCatalog(db, loadCatalog());
  });
  afterAll(async () => {
    await db.$disconnect();
  });
  beforeEach(async () => {
    factories += 1;
    const input = { name: `Site ${factories}`, slug: `site-${factories}`, subnetCidr: `172.23.${factories}.0/24` };
    factoryId = (await createFactory(db, alice, input)).id;
  });

  it("assembles a device's screens from the capabilities of its exact model", async () => {
    const drive = await place("Generic VFD, hardwired control", "VFD-01");
    const modbusDrive = await place("Generic VFD, Modbus TCP", "VFD-02");
    const sensor = await place("Generic pressure transmitter, 4–20 mA", "PT-101");
    const supply = await place("Generic 24 V DC power supply", "PS-01");
    const controller = await place("Generic temperature controller", "TC-01");

    // The same category, two models, two different sets of screens; neither has a program editor.
    expect(await sections(drive)).toEqual(["overview", "connections", "parameters", "runtime"]);
    expect(await sections(modbusDrive)).toEqual([
      "overview",
      "connections",
      "parameters",
      "registers",
      "communications",
      "runtime",
    ]);
    expect(await sections(sensor)).toEqual(["overview", "connections", "runtime"]);
    expect(await sections(supply)).toEqual(["overview", "connections"]);
    // Since TASK-1011 the temperature controller's category has a behaviour profile (PID_CONTROLLER).
    expect(await sections(controller)).toEqual(["overview", "connections", "parameters", "runtime"]);

    const detail = await getDeviceDetail(db, alice, modbusDrive);
    expect(detail).toMatchObject({
      name: "VFD-02",
      categoryCode: "VFD",
      capabilities: ["PARAMETER_CONFIGURABLE", "REMOTE_CONTROL", "MODBUS_SERVER"],
      architectureType: null,
      programNote: null,
      ports: [{ name: "Ethernet", protocols: ["MODBUS_TCP"], maxConnections: 16 }],
      registers: [],
    });
    // The controller shows the PID profile's parameters; nothing applies them until TASK-1015.
    const controllerParameters = (await getDeviceDetail(db, alice, controller)).parameters;
    expect(controllerParameters?.applied).toBe(false);
    expect(controllerParameters?.fields.map((field) => field.key)).toEqual([
      "kp",
      "ki",
      "kd",
      "outputMin",
      "outputMax",
      "setpoint",
      "deadband",
    ]);
    await refused(getDeviceDetail(db, bob, drive), "NOT_FOUND");
    await refused(getDeviceDetail(db, alice, "not-an-id"), "NOT_FOUND");
  });

  it("shows a device's wires and the registers its signals are carried on", async () => {
    const plc = (
      await createPlc(db, alice, { factoryId, deviceModelId: await modelId("CPU 1214C DC/DC/DC"), name: "PLC-01" })
    ).id;
    const valve = await place("Generic on/off valve, 24 V DC", "XV-101");
    expect(await wireAllSignals(db, alice, factoryId, plc, valve)).toBe(3);

    const detail = await getDeviceDetail(db, alice, valve);
    expect(detail.wires).toHaveLength(3);
    expect(
      detail.registers.map((register) => [register.tagName, register.plcName, register.signal, register.area]),
    ).toEqual([
      ["XV_101_Y1", "PLC-01", "open", "COIL"],
      // Inputs live in memory addresses (ADR-0010), so they are coils to Modbus too.
      ["XV_101_ZSC", "PLC-01", "closed", "COIL"],
      ["XV_101_ZSO", "PLC-01", "opened", "COIL"],
    ]);
    expect(detail.registers[0]).toMatchObject({ dataType: "BOOL", logicalAddress: "%QX0.0", displayAddress: "00001" });
    expect(await isControllerDevice(db, alice, plc)).toBe(true);
    expect(await isControllerDevice(db, alice, valve)).toBe(false);
  });

  it("stores a configurable device's parameters as immutable versions that the simulation reads", async () => {
    const drive = await place("Generic VFD, hardwired control", "VFD-01");
    const before = await getDeviceDetail(db, alice, drive);
    expect(before.parameters).toMatchObject({
      applied: true,
      values: { maxFrequencyHz: 50, accelTimeS: 5, decelTimeS: 5 },
      versions: [],
    });

    const first = await saveDeviceParameters(db, alice, drive, { maxFrequencyHz: "60", accelTimeS: 8 });
    expect(first.values).toEqual({ maxFrequencyHz: 60, accelTimeS: 8, decelTimeS: 5 });
    expect(first.versions.map((entry) => [entry.version, entry.createdBy, entry.values.maxFrequencyHz])).toEqual([
      [1, "alice", 60],
    ]);
    const second = await saveDeviceParameters(db, alice, drive, { maxFrequencyHz: 60, accelTimeS: 8, decelTimeS: 12 });
    expect(second.versions.map((entry) => entry.version)).toEqual([2, 1]);
    expect(second.versions[1]?.values.decelTimeS).toBe(5);

    // One profile per device, with the latest values; the simulation plans with them.
    const profiles = await db.simulationProfile.findMany({ where: { deviceInstanceId: drive } });
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      kind: "STATE_MACHINE",
      parametersJson: { maxFrequencyHz: 60, accelTimeS: 8, decelTimeS: 12 },
    });
    expect(await db.configurationVersion.count({ where: { scopeType: "DEVICE_PARAMETERS", scopeId: drive } })).toBe(2);
    expect((await planSimulation(db, alice, factoryId)).devices.map((device) => device.name)).toEqual(["VFD-01"]);
  });

  it("refuses parameters the behaviour model does not take, and parameters on a model that has none", async () => {
    const drive = await place("Generic VFD, hardwired control", "VFD-01");
    const sensor = await place("Generic pressure transmitter, 4–20 mA", "PT-101");
    const controller = await place("Generic temperature controller", "TC-01");

    await refused(saveDeviceParameters(db, alice, drive, { accelTimeS: 0 }), "VALIDATION", "simulation-params");
    await refused(saveDeviceParameters(db, alice, drive, { maxFrequencyHz: 5000 }), "VALIDATION", "simulation-params");
    await refused(saveDeviceParameters(db, alice, drive, { ratedFlow: 3 }), "VALIDATION", "parameters-field");
    await refused(saveDeviceParameters(db, alice, drive, { accelTimeS: "soon" }), "VALIDATION");
    await refused(saveDeviceParameters(db, alice, sensor, { accelTimeS: 1 }), "INCOMPATIBLE", "parameters-capability");
    // The temperature controller has the PID profile's parameters (TASK-1011): checked
    // against the behaviour contract, since the server's simulator does not run it.
    await refused(saveDeviceParameters(db, alice, controller, { gain: 1 }), "VALIDATION", "parameters-field");
    await refused(saveDeviceParameters(db, alice, controller, { kp: -1 }), "VALIDATION", "simulation-params");
    await refused(saveDeviceParameters(db, bob, drive, { accelTimeS: 1 }), "NOT_FOUND");
    expect(await db.configurationVersion.count({ where: { factoryId } })).toBe(0);
    expect(await db.simulationProfile.count({ where: { deviceInstanceId: drive } })).toBe(0);
  });

  it("gives a programmable RTU the PLC program and version workflow", async () => {
    const rtu = (
      await createPlc(db, alice, {
        factoryId,
        deviceModelId: await modelId("Generic RTU, IEC 61131-3"),
        name: "RTU-01",
      })
    ).id;

    const configuration = await getPlcConfiguration(db, alice, rtu);
    expect(configuration.plc.architectureType).toBe("COMPACT");
    expect(configuration.model).toMatchObject({
      categoryCode: "RTU",
      capabilities: ["PROGRAMMABLE", "IEC_61131_3", "MODBUS_SERVER", "REMOTE_CONTROL", "DATA_LOGGING"],
      runtimeSupport: "OPENPLC",
    });
    expect(configuration.occupancy.total).toBe(16);

    const source = "PROGRAM main\n  VAR\n    Run AT %QX0.0 : BOOL;\n  END_VAR\n  Run := TRUE;\nEND_PROGRAM";
    const version = await createProgramVersion(db, alice, rtu, { sourceText: source });
    expect(version).toMatchObject({ version: 1 });
    expect((await listProgramVersions(db, alice, rtu)).map((entry) => entry.version)).toEqual([1]);
    expect((await checkProgram(db, alice, rtu, { sourceText: source })).errors).toEqual([]);

    // The RTU is a controller in the factory's hierarchy and a wireable PLC side.
    const tree = await getFactoryDeviceTree(db, alice, factoryId);
    expect(tree.map((node) => [node.device.name, node.device.categoryCode])).toEqual([["RTU-01", "RTU"]]);
    // Its screens are the PLC screens, so it is a controller device, not a device of its own kind.
    expect(await isControllerDevice(db, alice, rtu)).toBe(true);
  }, 60_000);

  it("refuses the program workflow for a model without the capability, before anything is stored", async () => {
    // A controller model that is programmable but not in an IEC 61131-3 language, on the OpenPLC adapter.
    const model = await createGenericModel(db, "PLC", "Scripted controller", { architectureType: "COMPACT" });
    await db.deviceModel.update({ where: { id: model.id }, data: { capabilities: ["PROGRAMMABLE", "SCRIPTABLE"] } });
    const plc = (await createPlc(db, alice, { factoryId, deviceModelId: model.id, name: "PLC-09" })).id;

    const source = "PROGRAM main\nEND_PROGRAM";
    await refused(createProgramVersion(db, alice, plc, { sourceText: source }), "INCOMPATIBLE", "program-capability");
    await refused(checkProgram(db, alice, plc, { sourceText: source }), "INCOMPATIBLE", "program-capability");
    expect(await db.programVersion.count({ where: { plcInstanceId: plc } })).toBe(0);

    // A program in a language the adapter does not compile is not deployed either.
    const ok = await createPlc(db, alice, {
      factoryId,
      deviceModelId: await modelId("CPU 1214C DC/DC/DC"),
      name: "PLC-01",
    });
    const ladder = await db.programVersion.create({
      data: { plcInstanceId: ok.id, version: 1, language: "LD", sourceText: "| |", checksum: "x", status: "DRAFT" },
    });
    const deps = {
      db,
      docker: {} as never,
      policy: {} as never,
      runtimeSecret: "x".repeat(32),
      events: undefined as never,
    };
    await refused(deployProgramVersion(deps as never, alice, ok.id, ladder.id), "INCOMPATIBLE", "program-language");
    expect((await db.programVersion.findUniqueOrThrow({ where: { id: ladder.id } })).status).toBe("DRAFT");
  });
});
