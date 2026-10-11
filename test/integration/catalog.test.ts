// @vitest-environment node
import { afterAll, beforeAll, expect, it } from "vitest";
import { loadCatalog } from "@/lib/catalog";
import { ingestCatalog } from "@/lib/catalog/ingest";
import { DomainError, type DomainErrorCode } from "@/lib/domain/errors";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import type { PeripheralCompatibility } from "@/lib/domain/catalog-view";
import { getCatalogModel, getCatalogOverview, listCompatiblePeripherals } from "@/lib/services/catalog-service";
import { connectDevices } from "@/lib/services/connection-service";
import { createDeviceInstance } from "@/lib/services/device-service";
import { createFactory } from "@/lib/services/factory-service";
import { createGenericModel, describeDb, openTestDb, resetDb } from "./harness";

const alice = { ownerId: "alice" };

async function expectDomainError(action: Promise<unknown>, code: DomainErrorCode, rule?: string) {
  const error = await action.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe(code);
  if (rule) expect((error as DomainError).details.rule).toBe(rule);
}

/** The shipped catalog written to PostgreSQL, and the catalog service reading it back. */
describeDb("device catalog against PostgreSQL", () => {
  let db: PrismaClient;
  const catalog = loadCatalog();

  const modelId = async (modelName: string) =>
    (await db.deviceModel.findFirstOrThrow({ where: { modelName }, select: { id: true } })).id;

  const compatibility = async (plcModelName: string) => {
    const rows = await listCompatiblePeripherals(db, await modelId(plcModelName));
    return Object.fromEntries(rows.map((row) => [row.modelName, row])) as Record<string, PeripheralCompatibility>;
  };

  beforeAll(async () => {
    db = openTestDb();
    await resetDb(db);
    await ingestCatalog(db, catalog);
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("is idempotent: a second run changes no counts and no ids", async () => {
    const count = async () => ({
      categories: await db.deviceCategory.count(),
      manufacturers: await db.manufacturer.count(),
      families: await db.deviceFamily.count(),
      models: await db.deviceModel.count(),
      builtInChannels: await db.builtInIoChannel.count(),
      terminals: await db.deviceIoDefinition.count(),
      ports: await db.communicationPort.count(),
      racks: await db.rackProfile.count(),
      modules: await db.moduleModel.count(),
      moduleChannels: await db.moduleChannel.count(),
      compatibility: await db.moduleCompatibility.count(),
    });
    const before = await count();
    expect(before).toMatchObject({
      manufacturers: 4,
      models: 32,
      // 14 + 10 + 2 on the CPU 1214C, 14 + 10 on the TM241CE24T, 8 + 4 + 4 on the generic RTU.
      builtInChannels: 66,
      racks: 2,
      modules: 8,
      // 16 + 16 + 8 + 4 for each of the two modular families.
      moduleChannels: 88,
      compatibility: 8,
    });
    const idsBefore = (await db.deviceModel.findMany({ select: { id: true }, orderBy: { id: "asc" } })).map(
      (m) => m.id,
    );
    const channelBefore = await db.builtInIoChannel.findFirstOrThrow({ where: { terminalLabel: "Ia.0" } });

    const result = await ingestCatalog(db, catalog);
    expect(result).toEqual({ categories: before.categories, manufacturers: 4, models: 32, racks: 2, modules: 8 });
    expect(await count()).toEqual(before);
    expect((await db.deviceModel.findMany({ select: { id: true }, orderBy: { id: "asc" } })).map((m) => m.id)).toEqual(
      idsBefore,
    );
    expect((await db.builtInIoChannel.findFirstOrThrow({ where: { terminalLabel: "Ia.0" } })).id).toBe(
      channelBefore.id,
    );
  });

  it("updates a changed fact in place", async () => {
    const changed = structuredClone(catalog);
    const cpu = changed.models.find((model) => model.modelName === "CPU 1214C DC/DC/DC");
    if (!cpu) throw new Error("model missing");
    cpu.facts = { ...cpu.facts, workMemoryKb: 125 };
    const id = await modelId("CPU 1214C DC/DC/DC");

    await ingestCatalog(db, changed);
    expect((await db.deviceModel.findUniqueOrThrow({ where: { id } })).metadataJson).toMatchObject({
      workMemoryKb: 125,
    });
    await ingestCatalog(db, catalog);
    expect((await db.deviceModel.findUniqueOrThrow({ where: { id } })).metadataJson).toMatchObject({
      workMemoryKb: 100,
    });
  });

  it("stores provenance with every vendor record and none with generic ones", async () => {
    const cpu = await db.deviceModel.findFirstOrThrow({ where: { sku: "6ES7214-1AG40-0XB0" } });
    expect(cpu).toMatchObject({
      modelName: "CPU 1214C DC/DC/DC",
      architectureType: "COMPACT",
      runtimeSupport: "OPENPLC",
      controlCapability: "PROGRAMMABLE",
      verificationStatus: "VERIFIED",
      sourceTitle: "SIMATIC S7-1200 Easy Book",
      sourceRevision: "A5E02486774-AG, 01/2015",
    });
    expect(cpu.sourceUrl).toMatch(/^https:\/\/cache\.industry\.siemens\.com\//);
    expect(cpu.sourceRetrievedAt?.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(cpu.verifiedAt?.toISOString()).toBe("2026-10-05T00:00:00.000Z");

    const unsourced = await db.deviceModel.count({
      where: {
        verificationStatus: "VERIFIED",
        OR: [{ sourceUrl: null }, { sourceRevision: null }, { verifiedAt: null }],
      },
    });
    expect(unsourced).toBe(0);
    expect(await db.moduleModel.count({ where: { OR: [{ sourceUrl: null }, { verifiedAt: null }] } })).toBe(0);

    const generic = await db.deviceModel.findMany({ where: { verificationStatus: "GENERIC" } });
    expect(generic).toHaveLength(28);
    expect(generic.every((model) => !model.sku && !model.sourceUrl && !model.verifiedAt)).toBe(true);
  });

  it("expands channel groups into channels, with labels only where documented", async () => {
    const channels = async (modelName: string, ioType: "DI" | "DO" | "AI") =>
      db.builtInIoChannel.findMany({
        where: { deviceModel: { modelName }, ioType },
        orderBy: { channelIndex: "asc" },
      });
    const inputs = await channels("CPU 1214C DC/DC/DC", "DI");
    expect(inputs).toHaveLength(14);
    expect([inputs[0]?.terminalLabel, inputs[0]?.addressHint]).toEqual(["Ia.0", "%I0.0"]);
    expect([inputs[13]?.terminalLabel, inputs[13]?.addressHint]).toEqual(["Ib.5", "%I1.5"]);
    expect((await channels("CPU 1214C DC/DC/DC", "DO")).map((channel) => channel.addressHint)).toEqual(
      new Array(10).fill(null),
    );
    expect((await channels("CPU 1214C DC/DC/DC", "AI")).map((channel) => channel.signalType)).toEqual([
      "VOLTAGE_0_10V",
      "VOLTAGE_0_10V",
    ]);

    const outputs = await channels("TM241CE24T", "DO");
    expect(outputs.map((channel) => channel.terminalLabel)).toEqual([
      "Q0",
      "Q1",
      "Q2",
      "Q3",
      null,
      null,
      null,
      null,
      null,
      null,
    ]);

    // Terminals of generic models say which simulator signal they carry; faults follow the behaviour model.
    const terminals = await db.deviceIoDefinition.findMany({
      where: { deviceModel: { modelName: "Generic VFD, hardwired control" }, kind: "SIGNAL" },
      orderBy: { terminalLabel: "asc" },
    });
    expect(terminals.map((terminal) => [terminal.terminalLabel, terminal.direction, terminal.simulatorSignal])).toEqual(
      [
        ["FAULT", "OUTPUT", "faulted"],
        ["FREQ", "OUTPUT", "actualFrequency"],
        ["REF", "INPUT", "frequencySetpoint"],
        ["REV", "INPUT", "reverse"],
        ["RUN", "INPUT", "run"],
        ["RUNNING", "OUTPUT", "running"],
        ["RESET", "INPUT", "faultReset"],
      ].sort(),
    );
    // Supply, 0 V and earth terminals are terminals of their own kind; only they take more than one wire.
    const shared = await db.deviceIoDefinition.findMany({
      where: { kind: { not: "SIGNAL" } },
      include: { deviceModel: { select: { modelName: true } } },
      orderBy: [{ deviceModel: { modelName: "asc" } }, { terminalLabel: "asc" }],
    });
    const of = (modelName: string) =>
      shared
        .filter((terminal) => terminal.deviceModel.modelName === modelName)
        .map((terminal) => [terminal.terminalLabel, terminal.kind, terminal.maxConnections])
        .sort();
    expect(of("Generic 24 V DC power supply")).toEqual([
      ["+24V", "POWER", 8],
      ["0V", "COMMON", 8],
      ["PE", "EARTH", 8],
    ]);
    expect(of("Generic VFD, hardwired control")).toEqual([
      ["COM", "COMMON", 4],
      ["PE", "EARTH", 1],
      ["U", "POWER", 1],
      ["V", "POWER", 1],
      ["W", "POWER", 1],
    ]);
    expect(of("Generic three-phase motor")).toEqual([
      ["PE", "EARTH", 1],
      ["U", "POWER", 1],
      ["V", "POWER", 1],
      ["W", "POWER", 1],
    ]);
    expect(of("Generic pressure transmitter, 4–20 mA")).toEqual([
      ["+24V", "POWER", 1],
      ["0V", "COMMON", 1],
    ]);
    expect(await db.deviceIoDefinition.count({ where: { kind: "SIGNAL", maxConnections: { gt: 1 } } })).toBe(0);
    expect(await db.communicationPort.count({ where: { maxConnections: { not: 16 } } })).toBe(0);

    const faults = await db.deviceFaultDefinition.findMany({
      where: { deviceModel: { modelName: "Generic VFD, hardwired control" } },
      orderBy: { code: "asc" },
    });
    expect(faults.map((fault) => [fault.code, fault.severity, fault.resetBehavior])).toEqual([
      ["OVERCURRENT", "CRITICAL", "MANUAL"],
      ["OVERTEMPERATURE", "CRITICAL", "MANUAL"],
    ]);

    const analog = await db.moduleChannel.findFirstOrThrow({ where: { moduleModel: { sku: "6ES7531-7KF00-0AB0" } } });
    expect(analog).toMatchObject({ ioType: "AI", signalType: "CURRENT_4_20MA" });
    expect(analog.acceptedSignalTypes).toEqual(["CURRENT_0_20MA", "CURRENT_PM_20MA", "VOLTAGE_PM_10V", "VOLTAGE_1_5V"]);
  });

  it("lists the catalog as manufacturer, family and model with totals", async () => {
    const overview = await getCatalogOverview(db);
    expect(overview.totals).toEqual({
      models: 32,
      manufacturers: 4,
      verified: 4,
      generic: 28,
      withAsset: 0,
      simulated: 19,
    });
    // Every stored model carries its simulation decision (TASK-1010): the generic hardwired
    // drive runs on its category's profile; a vendor PLC is a program host, not a simulated device.
    const drive = overview.manufacturers
      .flatMap((manufacturer) => manufacturer.families.flatMap((family) => family.models))
      .find((model) => model.modelName === "Generic VFD, hardwired control");
    expect(drive?.coverage).toBe("GENERIC");
    expect((await getCatalogModel(db, await modelId("Generic VFD, hardwired control"))).simulation).toMatchObject({
      coverage: "GENERIC",
      profile: { key: "VFD", version: 1 },
      faults: ["OVERCURRENT", "OVERTEMPERATURE"],
      statement: expect.stringContaining("not vendor firmware"),
    });
    expect((await getCatalogModel(db, await modelId("CPU 1214C DC/DC/DC"))).simulation).toMatchObject({
      coverage: "NOT_SIMULATABLE",
      profile: null,
      reason: expect.stringContaining("OpenPLC"),
    });
    expect(overview.manufacturers.map((manufacturer) => [manufacturer.name, manufacturer.modelCount])).toEqual([
      ["Generic / simulated", 28],
      ["Rockwell Automation", 1],
      ["Schneider Electric", 1],
      ["Siemens", 2],
    ]);
    const siemens = overview.manufacturers.find((manufacturer) => manufacturer.name === "Siemens");
    expect(
      siemens?.families.map((family) => [family.name, family.models.map((model) => model.architectureType)]),
    ).toEqual([
      ["SIMATIC S7-1200", ["COMPACT"]],
      ["SIMATIC S7-1500", ["MODULAR"]],
    ]);
    expect(overview.categories.find((category) => category.code === "PLC")).toMatchObject({ modelCount: 4 });
    // Categories without a model are not offered as a filter.
    expect(overview.categories.some((category) => category.code === "ROBOT_CONTROLLER")).toBe(false);
  });

  it("describes a compact PLC model with its source, built-in I/O and ports", async () => {
    const model = await getCatalogModel(db, await modelId("CPU 1214C DC/DC/DC"));
    expect(model).toMatchObject({
      manufacturer: "Siemens",
      family: "SIMATIC S7-1200",
      categoryCode: "PLC",
      sku: "6ES7214-1AG40-0XB0",
      verificationStatus: "VERIFIED",
      source: { revision: "A5E02486774-AG, 01/2015", retrievedAt: "2026-10-05", verifiedAt: "2026-10-05" },
      electrical: { supplyType: "DC", nominalVoltage: 24, voltageMin: 20.4, voltageMax: 28.8 },
      ports: [{ name: "PROFINET", protocols: ["MODBUS_TCP"], portCount: 1 }],
      facts: { workMemoryKb: 100, signalModulesMax: 8 },
      racks: [],
      modules: [],
    });
    expect(model.builtInChannels.map((group) => [group.count, group.ioType, group.signalType])).toEqual([
      [14, "DI", "DC_24V"],
      [10, "DO", "DC_24V"],
      [2, "AI", "VOLTAGE_0_10V"],
    ]);
  });

  it("describes a modular PLC model with its rack and installable modules", async () => {
    const model = await getCatalogModel(db, await modelId("5069-L306ER"));
    expect(model.builtInChannels).toEqual([]);
    expect(model.racks).toEqual([
      { name: "Local I/O, 8 modules", slotCount: 8, notes: expect.stringContaining("max. 8") },
    ]);
    expect(model.modules.map((module) => [module.modelName, module.moduleType, module.channels[0]?.count])).toEqual([
      ["5069-IB16", "DIGITAL_INPUT", 16],
      ["5069-IF8", "ANALOG_INPUT", 8],
      ["5069-OB16", "DIGITAL_OUTPUT", 16],
      ["5069-OF4", "ANALOG_OUTPUT", 4],
    ]);
    expect(model.modules.every((module) => module.verificationStatus === "VERIFIED")).toBe(true);
    await expectDomainError(getCatalogModel(db, "00000000-0000-7000-8000-000000000000"), "NOT_FOUND");
  });

  it("filters peripherals for a compact PLC by point class, signal type and channel count", async () => {
    const result = await compatibility("CPU 1214C DC/DC/DC");

    expect(result["Generic push button, 24 V DC"]).toMatchObject({ compatible: true, directIo: { compatible: true } });
    expect(result["Generic on/off valve, 24 V DC"]?.directIo?.terminals.map((terminal) => terminal.required)).toEqual([
      "DO",
      "DI",
      "DI",
    ]);
    // The built-in analog inputs take 0–10 V only.
    expect(result["Generic pressure transmitter, 0–10 V"]?.compatible).toBe(true);
    expect(result["Generic pressure transmitter, 4–20 mA"]).toMatchObject({
      compatible: false,
      directIo: { terminals: [{ required: "AI", signalType: "CURRENT_4_20MA", satisfied: false }] },
    });
    // No analog output on this CPU: nothing can drive a speed or position reference.
    expect(result["Generic control valve, 4–20 mA"]?.compatible).toBe(false);
    const drive = result["Generic VFD, hardwired control"];
    expect(drive?.compatible).toBe(false);
    expect(
      drive?.directIo?.terminals.filter((terminal) => !terminal.satisfied).map((terminal) => terminal.terminalLabel),
    ).toEqual(["REF"]);

    // A protocol device needs no channel at all.
    expect(result["Generic VFD, Modbus TCP"]).toMatchObject({
      compatible: true,
      directIo: null,
      protocols: ["MODBUS_TCP"],
    });
    // Equipment that connects to other devices, not to the PLC, is not listed.
    expect(result["Generic centrifugal pump"]).toBeUndefined();
    expect(Object.values(result).some((row) => row.categoryCode === "PLC")).toBe(false);
  });

  it("filters peripherals for a modular PLC by the modules it can take", async () => {
    const siemens = await compatibility("CPU 1511-1 PN");
    expect(siemens["Generic pressure transmitter, 4–20 mA"]?.directIo?.terminals[0]).toMatchObject({
      satisfied: true,
      modules: ["AI 8xU/I/RTD/TC ST"],
    });
    // 0–10 V is carried by the module's ±10 V range.
    expect(siemens["Generic pressure transmitter, 0–10 V"]?.compatible).toBe(true);
    expect(siemens["Generic VFD, hardwired control"]?.compatible).toBe(true);
    expect(
      Object.fromEntries(
        (siemens["Generic control valve, 4–20 mA"]?.directIo?.terminals ?? []).map((terminal) => [
          terminal.terminalLabel,
          terminal.modules,
        ]),
      ),
    ).toEqual({ "POS REF": ["AQ 4xU/I ST"], "POS FB": ["AI 8xU/I/RTD/TC ST"] });

    // The Rockwell source does not state Modbus TCP, so no protocol match is claimed.
    const rockwell = await compatibility("5069-L306ER");
    expect(rockwell["Generic VFD, Modbus TCP"]).toMatchObject({ compatible: false, protocols: [] });
    expect(rockwell["Generic VFD, hardwired control"]?.compatible).toBe(true);

    const onlyCompatible = await listCompatiblePeripherals(db, await modelId("5069-L306ER"), { compatibleOnly: true });
    expect(onlyCompatible.every((row) => row.compatible)).toBe(true);
    expect(onlyCompatible.length).toBeLessThan(Object.keys(rockwell).length);

    await expectDomainError(listCompatiblePeripherals(db, await modelId("Generic fan")), "INCOMPATIBLE", "plc-model");
  });

  it("keeps catalog models and factory instances separate", async () => {
    const factory = await createFactory(db, alice, { name: "Line 1", slug: "line-1", subnetCidr: "172.20.9.0/24" });
    const pumpModel = await modelId("Generic centrifugal pump");
    const create = (deviceModelId: string, name: string) =>
      createDeviceInstance(db, { factoryId: factory.id, deviceModelId, name });

    const first = await create(pumpModel, "P-101");
    const second = await create(pumpModel, "P-102");
    expect(first.id).not.toBe(second.id);
    expect(first).toMatchObject({ deviceModelId: pumpModel, runtimeType: "DEVICE_SIM", simulatorType: "PUMP" });
    await expectDomainError(create(pumpModel, "P-101"), "CONFLICT");

    const plc = await create(await modelId("TM241CE24T"), "PLC-01");
    expect(plc).toMatchObject({ runtimeType: "OPENPLC", simulatorType: "NONE" });
    expect(await db.plcInstanceProfile.count({ where: { deviceInstanceId: plc.id } })).toBe(1);
    expect(await db.deviceModel.count()).toBe(32);
  });

  it("represents controller, drive and remote-I/O chains, and direct wiring without an intermediate device", async () => {
    const factory = await createFactory(db, alice, { name: "Line 2", slug: "line-2", subnetCidr: "172.20.10.0/24" });
    const servoDrive = await createGenericModel(db, "SERVO_DRIVE", "Test servo drive");
    const servoMotor = await createGenericModel(db, "SERVO_MOTOR", "Test servo motor");
    const ids: Record<string, string> = {};
    for (const [key, deviceModelId] of Object.entries({
      plc: await modelId("CPU 1214C DC/DC/DC"),
      remoteIo: await modelId("Generic remote I/O station, Modbus TCP"),
      valve: await modelId("Generic on/off valve, 24 V DC"),
      controller: await modelId("Generic temperature controller"),
      heater: await modelId("Generic heater, contactor-switched"),
      sensor: await modelId("Generic pressure transmitter, 0–10 V"),
      vfd: await modelId("Generic VFD, hardwired control"),
      motor: await modelId("Generic three-phase motor"),
      pump: await modelId("Generic centrifugal pump"),
      servoDrive: servoDrive.id,
      servoMotor: servoMotor.id,
    })) {
      ids[key] = (await createDeviceInstance(db, { factoryId: factory.id, deviceModelId, name: `dev-${key}` })).id;
    }
    const connect = (relationship: string, source: string, target: string) =>
      connectDevices(db, {
        factoryId: factory.id,
        relationship,
        source: { deviceId: ids[source] },
        target: { deviceId: ids[target] },
      });

    // PLC -> VFD -> motor -> pump
    await connect("CONTROLS", "plc", "vfd");
    await connect("DRIVES", "vfd", "motor");
    await connect("MECHANICALLY_DRIVES", "motor", "pump");
    // PLC -> remote I/O -> valve
    await connect("COMMUNICATES_WITH", "plc", "remoteIo");
    await connect("CONTROLS", "remoteIo", "valve");
    // PLC -> temperature controller -> heater
    await connect("CONTROLS", "plc", "controller");
    await connect("CONTROLS", "controller", "heater");
    // Sensor -> PLC, nothing in between
    await connect("FEEDS_BACK_TO", "sensor", "plc");
    // PLC -> servo drive -> servo motor; a VFD cannot take the servo motor's place.
    await connect("CONTROLS", "plc", "servoDrive");
    await expectDomainError(connect("DRIVES", "vfd", "servoMotor"), "INCOMPATIBLE", "drive-type");
    await connect("DRIVES", "servoDrive", "servoMotor");

    expect(await db.deviceConnection.count({ where: { factoryId: factory.id } })).toBe(10);
  });
});
