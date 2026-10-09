// @vitest-environment node
import { afterAll, beforeAll, expect, it } from "vitest";
import { loadCatalog } from "@/lib/catalog";
import { ingestCatalog } from "@/lib/catalog/ingest";
import { DomainError, type DomainErrorCode } from "@/lib/domain/errors";
import type { PlcConfigurationView } from "@/lib/domain/plc-config-view";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { createFactory } from "@/lib/services/factory-service";
import {
  addPeripheral,
  createPlc,
  deletePlc,
  getPlcConfiguration,
  installModule,
  listFactoryDevices,
  listFactoryPlcSummaries,
  listInstallableModules,
  listPlcModels,
  removeModule,
} from "@/lib/services/plc-config-service";
import { planSimulation } from "@/lib/services/simulation-service";
import { createTag, getModbusMap } from "@/lib/services/tag-service";
import { removeDevice } from "@/lib/services/topology-service";
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

/** PLC configuration against PostgreSQL with the shipped catalog: the compact and the modular path. */
describeDb("PLC configuration against PostgreSQL", () => {
  let db: PrismaClient;
  let factories = 0;

  const modelId = async (modelName: string) =>
    (await db.deviceModel.findFirstOrThrow({ where: { modelName }, select: { id: true } })).id;
  const moduleId = async (sku: string) =>
    (await db.moduleModel.findFirstOrThrow({ where: { sku }, select: { id: true } })).id;

  async function newFactory() {
    factories += 1;
    return (
      await createFactory(db, alice, {
        name: `Line ${factories}`,
        slug: `line-${factories}`,
        subnetCidr: `172.21.${factories}.0/24`,
      })
    ).id;
  }
  async function newPlc(modelName: string, name = "PLC-01") {
    const factoryId = await newFactory();
    const { id } = await createPlc(db, alice, {
      factoryId,
      deviceModelId: await modelId(modelName),
      name,
      role: "Pump station",
    });
    return { factoryId, plcId: id };
  }
  const add = async (plcId: string, modelName: string, name: string, assignments?: Record<string, string>) =>
    addPeripheral(db, alice, plcId, { deviceModelId: await modelId(modelName), name, assignments });
  const config = (plcId: string) => getPlcConfiguration(db, alice, plcId);
  const bank = (view: PlcConfigurationView, key: string) => view.banks.find((candidate) => candidate.key === key);
  const deviceCount = (factoryId: string) => db.deviceInstance.count({ where: { factoryId } });

  beforeAll(async () => {
    db = openTestDb();
    await resetDb(db);
    await ingestCatalog(db, loadCatalog());
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("offers PLC models by architecture for the create form", async () => {
    expect((await listPlcModels(db, "COMPACT")).map((model) => [model.modelName, model.io])).toEqual([
      ["Generic RTU, IEC 61131-3", "8 DI · 4 DO · 4 AI"],
      ["TM241CE24T", "14 DI · 10 DO"],
      ["CPU 1214C DC/DC/DC", "14 DI · 10 DO · 2 AI"],
    ]);
    expect((await listPlcModels(db, "MODULAR")).map((model) => [model.modelName, model.io])).toEqual([
      ["5069-L306ER", "4 installable modules"],
      ["CPU 1511-1 PN", "4 installable modules"],
    ]);
  });

  it("creates a compact PLC with a name, a separate role and its built-in I/O points", async () => {
    const { factoryId, plcId } = await newPlc("CPU 1214C DC/DC/DC", "S7-1200-01");
    const view = await config(plcId);

    expect(view.plc).toMatchObject({
      name: "S7-1200-01",
      role: "Pump station",
      architectureType: "COMPACT",
      runtimeStatus: "STOPPED",
    });
    expect(view.model).toMatchObject({
      manufacturer: "Siemens",
      sku: "6ES7214-1AG40-0XB0",
      verificationStatus: "VERIFIED",
    });
    expect(view.electrical).toMatchObject({ nominalVoltage: 24, voltageMin: 20.4 });
    expect(view.rack).toBeNull();
    expect(view.occupancy).toEqual({ total: 26, occupied: 0 });
    expect(view.banks.map((candidate) => [candidate.key, candidate.label, candidate.points.length])).toEqual([
      ["builtin-DI", "Digital inputs", 14],
      ["builtin-DO", "Digital outputs", 10],
      ["builtin-AI", "Analog inputs", 2],
    ]);
    // Vendor terminal and address where documented; the runtime address the program uses.
    expect(bank(view, "builtin-DI")?.points[13]).toMatchObject({
      label: "Ib.5",
      vendorAddress: "%I1.5",
      logicalAddress: "%MX1.5",
      status: "FREE",
      signalTypes: ["DC_24V"],
    });
    expect(bank(view, "builtin-DO")?.points[9]).toMatchObject({
      label: "Qb.1",
      vendorAddress: null,
      logicalAddress: "%QX1.1",
    });
    expect(bank(view, "builtin-AI")?.points.map((point) => point.logicalAddress)).toEqual(["%MW0", "%MW1"]);

    expect(await listFactoryDevices(db, alice, factoryId)).toMatchObject([
      { name: "S7-1200-01", categoryCode: "PLC", architectureType: "COMPACT", modelName: "CPU 1214C DC/DC/DC" },
    ]);
    expect(await db.runtimeEvent.count({ where: { deviceId: plcId, type: "DEVICE_CREATED" } })).toBe(1);
  });

  it("refuses duplicate names, non-PLC models, foreign factories and modules on a compact PLC", async () => {
    const { factoryId, plcId } = await newPlc("CPU 1214C DC/DC/DC");
    const plcModel = await modelId("CPU 1214C DC/DC/DC");

    await expectDomainError(createPlc(db, alice, { factoryId, deviceModelId: plcModel, name: "PLC-01" }), "CONFLICT");
    await expectDomainError(
      createPlc(db, alice, { factoryId, deviceModelId: plcModel, name: "has space" }),
      "VALIDATION",
    );
    await expectDomainError(
      createPlc(db, alice, { factoryId, deviceModelId: await modelId("Generic fan"), name: "PLC-02" }),
      "INCOMPATIBLE",
      "plc-model",
    );
    await expectDomainError(createPlc(db, bob, { factoryId, deviceModelId: plcModel, name: "PLC-02" }), "NOT_FOUND");
    await expectDomainError(getPlcConfiguration(db, bob, plcId), "NOT_FOUND");
    await expectDomainError(
      installModule(db, alice, plcId, { moduleModelId: await moduleId("6ES7521-1BH10-0AA0"), slotIndex: 1 }),
      "INCOMPATIBLE",
      "modular-only",
    );
    expect(await deviceCount(factoryId)).toBe(1);
  });

  it("wires a peripheral to free compatible channels and gives each a tag and Modbus address", async () => {
    const { factoryId, plcId } = await newPlc("CPU 1214C DC/DC/DC");
    const { deviceId } = await add(plcId, "Generic on/off valve, 24 V DC", "XV-101");

    const view = await config(plcId);
    expect(view.occupancy).toEqual({ total: 26, occupied: 3 });
    expect(view.plc.ioMappingVersion).toBe(1);
    expect(view.peripherals).toEqual([
      {
        deviceId,
        name: "XV-101",
        role: null,
        modelName: "Generic on/off valve, 24 V DC",
        categoryName: "Valve",
        connection: "DIRECT_IO",
        protocols: [],
        wires: [
          { terminalLabel: "Y1", ioType: "DO", pointLabel: "Qa.0", logicalAddress: "%QX0.0", tagName: "XV_101_Y1" },
          { terminalLabel: "ZSC", ioType: "DI", pointLabel: "Ia.0", logicalAddress: "%MX0.0", tagName: "XV_101_ZSC" },
          { terminalLabel: "ZSO", ioType: "DI", pointLabel: "Ia.1", logicalAddress: "%MX0.1", tagName: "XV_101_ZSO" },
        ],
      },
    ]);
    expect(bank(view, "builtin-DO")?.points[0]).toMatchObject({
      status: "OCCUPIED",
      device: { id: deviceId, name: "XV-101", terminalLabel: "Y1" },
      tagName: "XV_101_Y1",
    });

    const map = await getModbusMap(db, alice, plcId);
    expect(
      map.rows.map((row) => [row.name, row.role, row.accessMode, row.area, row.address, row.sourceSignal]),
    ).toEqual([
      ["XV_101_Y1", "STATUS", "READ_ONLY", "COIL", 0, "open"],
      ["XV_101_ZSC", "STATUS", "READ_ONLY", "COIL", 8192, "closed"],
      ["XV_101_ZSO", "STATUS", "READ_ONLY", "COIL", 8193, "opened"],
    ]);

    // The device simulator finds the device and its wiring without further configuration.
    const plan = await planSimulation(db, alice, factoryId);
    expect(plan.devices).toMatchObject([{ name: "XV-101", type: "VALVE" }]);
    expect(plan.bindings.map((binding) => [binding.signal, binding.direction, binding.area, binding.address])).toEqual([
      ["open", "IN", "COIL", 0],
      ["closed", "OUT", "COIL", 8192],
      ["opened", "OUT", "COIL", 8193],
    ]);
  });

  it("summarizes a factory's PLCs for the overview's LLM Context: program, versions, occupancy (TASK-1002)", async () => {
    const { factoryId, plcId } = await newPlc("CPU 1214C DC/DC/DC");
    await add(plcId, "Generic on/off valve, 24 V DC", "XV-101");

    expect(await listFactoryPlcSummaries(db, alice, factoryId)).toEqual([
      {
        id: plcId,
        name: "PLC-01",
        architectureType: "COMPACT",
        runtimeStatus: "STOPPED",
        programSelected: false,
        ioMappingVersion: 1,
        occupancy: { total: 26, occupied: 3 },
      },
    ]);
    // A peripheral is not a PLC; another owner's factory is not found.
    expect((await listFactoryPlcSummaries(db, alice, factoryId)).map((plc) => plc.name)).not.toContain("XV-101");
    await expectDomainError(listFactoryPlcSummaries(db, bob, factoryId), "NOT_FOUND");
  });

  it("honours a chosen channel and never assigns an occupied or incompatible one", async () => {
    const { factoryId, plcId } = await newPlc("CPU 1214C DC/DC/DC");
    // The terminal of the catalog model and the channel it is to land on, both by id.
    const terminal = await db.deviceIoDefinition.findFirstOrThrow({
      where: { deviceModelId: await modelId("Generic push button, 24 V DC"), terminalLabel: "OUT" },
    });
    const inputs = bank(await config(plcId), "builtin-DI")?.points ?? [];
    expect(inputs).toHaveLength(14);
    const last = { ...inputs[13], pointId: inputs[13]?.id ?? "" };
    expect(last).toMatchObject({ label: "Ib.5", logicalAddress: "%MX1.5", status: "FREE" });
    await add(plcId, "Generic push button, 24 V DC", "HS-01", { [terminal.id]: last.pointId });
    expect((await config(plcId)).peripherals[0]?.wires).toMatchObject([{ pointLabel: "Ib.5", tagName: "HS_01_OUT" }]);

    // The same channel a second time: refused, and no half-created device is left behind.
    await expectDomainError(
      add(plcId, "Generic push button, 24 V DC", "HS-02", { [terminal.id]: last.pointId }),
      "OCCUPIED_ENDPOINT",
      "io-point-free",
    );
    // A switch contact cannot land on an output channel.
    const output = bank(await config(plcId), "builtin-DO")?.points[0];
    await expectDomainError(
      add(plcId, "Generic push button, 24 V DC", "HS-02", { [terminal.id]: output?.id ?? "" }),
      "INCOMPATIBLE",
      "io-point-type",
    );
    await expectDomainError(add(plcId, "Generic push button, 24 V DC", "HS-01"), "CONFLICT");
    expect(await deviceCount(factoryId)).toBe(2);

    // The chosen channel is the only one that is occupied: the refused devices left nothing behind.
    const after = bank(await config(plcId), "builtin-DI")?.points ?? [];
    expect(after.filter((point) => point.status === "OCCUPIED").map((point) => point.label)).toEqual(["Ib.5"]);
  });

  it("stops when the channels of a class are used up", async () => {
    const { factoryId, plcId } = await newPlc("CPU 1214C DC/DC/DC");
    await add(plcId, "Generic pressure transmitter, 0–10 V", "PT-101");
    await add(plcId, "Generic pressure transmitter, 0–10 V", "PT-102");
    await expectDomainError(
      add(plcId, "Generic pressure transmitter, 0–10 V", "PT-103"),
      "INCOMPATIBLE",
      "no-free-channel",
    );
    expect(await deviceCount(factoryId)).toBe(3);

    const tag = await db.tag.findFirstOrThrow({ where: { name: "PT_101_OUT" } });
    expect(tag).toMatchObject({
      dataType: "INT16",
      role: "PROCESS_VALUE",
      logicalAddress: "%MW0",
      scale: 0.1,
      sourceSignal: "value",
    });
  });

  it("links a protocol device over a shared protocol and refuses a device with no way to connect", async () => {
    const { factoryId, plcId } = await newPlc("CPU 1214C DC/DC/DC");
    const { deviceId } = await add(plcId, "Generic VFD, Modbus TCP", "VFD-01");
    const view = await config(plcId);
    expect(view.peripherals).toMatchObject([
      { deviceId, connection: "PROTOCOL", protocols: ["MODBUS_TCP"], wires: [] },
    ]);
    expect(view.occupancy.occupied).toBe(0);

    await expectDomainError(add(plcId, "Generic centrifugal pump", "P-101"), "INCOMPATIBLE", "no-plc-connection");
    await expectDomainError(add(plcId, "CPU 1214C DC/DC/DC", "PLC-02"), "NOT_FOUND");
    expect(await deviceCount(factoryId)).toBe(2);
  });

  it("removes a peripheral and frees its channels and tags", async () => {
    const { factoryId, plcId } = await newPlc("CPU 1214C DC/DC/DC");
    const { deviceId } = await add(plcId, "Generic on/off valve, 24 V DC", "XV-101");
    await removeDevice(db, alice, deviceId);

    const view = await config(plcId);
    expect(view.occupancy.occupied).toBe(0);
    expect(view.peripherals).toEqual([]);
    expect(await db.tag.count({ where: { plcInstanceId: plcId } })).toBe(0);
    expect(await deviceCount(factoryId)).toBe(1);
    await expectDomainError(removeDevice(db, alice, deviceId), "NOT_FOUND");

    // The freed channels are used again.
    await add(plcId, "Generic on/off valve, 24 V DC", "XV-102");
    expect((await config(plcId)).peripherals[0]?.wires[0]).toMatchObject({ pointLabel: "Qa.0", tagName: "XV_102_Y1" });
  });

  it("keeps hand-made tags off I/O point addresses and deletes a PLC only without a runtime", async () => {
    const { factoryId, plcId } = await newPlc("CPU 1214C DC/DC/DC");
    const tag = { name: "Manual", dataType: "BOOL", role: "STATUS" };
    await expectDomainError(
      createTag(db, alice, plcId, { ...tag, logicalAddress: "%MX0.0" }),
      "CONFLICT",
      "io-point-address",
    );
    await expectDomainError(
      createTag(db, alice, plcId, { ...tag, logicalAddress: "%QX1.1" }),
      "CONFLICT",
      "io-point-address",
    );
    await createTag(db, alice, plcId, { ...tag, logicalAddress: "%MX2.0" });

    await db.deviceInstance.update({ where: { id: plcId }, data: { dockerContainerId: "abc" } });
    await expectDomainError(deletePlc(db, alice, plcId), "CONFLICT", "runtime-exists");
    await db.deviceInstance.update({ where: { id: plcId }, data: { dockerContainerId: null } });
    await expectDomainError(deletePlc(db, bob, plcId), "NOT_FOUND");
    await deletePlc(db, alice, plcId);
    expect(await deviceCount(factoryId)).toBe(0);
    expect(await db.plcIoPoint.count({ where: { plcInstanceId: plcId } })).toBe(0);
  });

  it("creates a modular PLC with an empty rack and installs only compatible modules in free slots", async () => {
    const { plcId } = await newPlc("CPU 1511-1 PN", "S7-1500-01");
    let view = await config(plcId);
    expect(view.plc.architectureType).toBe("MODULAR");
    expect(view.rack).toMatchObject({ name: "S7-1500 mounting rail", slotCount: 31 });
    expect(view.rack?.slots.every((slot) => slot.module === null)).toBe(true);
    expect(view.banks).toEqual([]);
    expect(view.occupancy).toEqual({ total: 0, occupied: 0 });

    expect(
      (await listInstallableModules(db, alice, plcId)).map((module) => [module.modelName, module.channels[0]?.count]),
    ).toEqual([
      ["AI 8xU/I/RTD/TC ST", 8],
      ["AQ 4xU/I ST", 4],
      ["DI 16x24VDC BA", 16],
      ["DQ 16x24VDC/0.5A BA", 16],
    ]);

    const di = await moduleId("6ES7521-1BH10-0AA0");
    await installModule(db, alice, plcId, { moduleModelId: di, slotIndex: 1 });
    await expectDomainError(
      installModule(db, alice, plcId, { moduleModelId: di, slotIndex: 1 }),
      "OCCUPIED_ENDPOINT",
      "slot-occupied",
    );
    await expectDomainError(
      installModule(db, alice, plcId, { moduleModelId: di, slotIndex: 32 }),
      "VALIDATION",
      "slot-range",
    );
    await expectDomainError(installModule(db, alice, plcId, { moduleModelId: di, slotIndex: 0 }), "VALIDATION");
    // A module of another family is not in this CPU's compatibility list.
    await expectDomainError(
      installModule(db, alice, plcId, { moduleModelId: await moduleId("5069-IB16"), slotIndex: 2 }),
      "INCOMPATIBLE",
      "module-compatibility",
    );
    await expectDomainError(installModule(db, bob, plcId, { moduleModelId: di, slotIndex: 2 }), "NOT_FOUND");

    view = await config(plcId);
    expect(view.rack?.slots[0]).toEqual({
      slotIndex: 1,
      module: {
        id: expect.any(String),
        modelName: "DI 16x24VDC BA",
        sku: "6ES7521-1BH10-0AA0",
        moduleType: "DIGITAL_INPUT",
        pointCount: 16,
        occupiedCount: 0,
      },
    });
    expect(view.banks.map((candidate) => [candidate.key, candidate.label])).toEqual([
      ["slot1-DI", "Slot 1 · DI 16x24VDC BA"],
    ]);
    expect(view.banks[0]?.points.map((point) => point.logicalAddress).slice(0, 9)).toEqual([
      "%MX0.0",
      "%MX0.1",
      "%MX0.2",
      "%MX0.3",
      "%MX0.4",
      "%MX0.5",
      "%MX0.6",
      "%MX0.7",
      "%MX1.0",
    ]);
    expect(view.plc.ioMappingVersion).toBe(1);
  });

  it("enforces the slot limit of the rack", async () => {
    const { plcId } = await newPlc("5069-L306ER", "L306-01");
    const input = await moduleId("5069-IB16");
    expect((await config(plcId)).rack).toMatchObject({ slotCount: 8 });
    for (let slot = 1; slot <= 8; slot += 1)
      await installModule(db, alice, plcId, { moduleModelId: input, slotIndex: slot });
    await expectDomainError(
      installModule(db, alice, plcId, { moduleModelId: input, slotIndex: 9 }),
      "VALIDATION",
      "slot-range",
    );
    const view = await config(plcId);
    expect(view.rack?.slots.filter((slot) => slot.module).length).toBe(8);
    expect(view.occupancy.total).toBe(128);
    // Each module starts on its own byte: slot 8 holds inputs 112 to 127.
    expect(bank(view, "slot8-DI")?.points[0]?.logicalAddress).toBe("%MX14.0");
  });

  it("keeps addresses stable when modules come and go, and clear of hand-made tags", async () => {
    const { plcId } = await newPlc("CPU 1511-1 PN");
    const di = await moduleId("6ES7521-1BH10-0AA0");
    const ai = await moduleId("6ES7531-7KF00-0AB0");
    const first = await installModule(db, alice, plcId, { moduleModelId: di, slotIndex: 1 });
    await installModule(db, alice, plcId, { moduleModelId: di, slotIndex: 2 });
    await installModule(db, alice, plcId, { moduleModelId: ai, slotIndex: 3 });
    const before = bank(await config(plcId), "slot2-DI")?.points.map((point) => point.logicalAddress);
    expect(before?.[0]).toBe("%MX2.0");

    await removeModule(db, alice, plcId, first.id);
    await installModule(db, alice, plcId, { moduleModelId: di, slotIndex: 5 });
    let view = await config(plcId);
    expect(bank(view, "slot2-DI")?.points.map((point) => point.logicalAddress)).toEqual(before);
    expect(bank(view, "slot5-DI")?.points[0]?.logicalAddress).toBe("%MX4.0");
    expect(bank(view, "slot3-AI")?.points.map((point) => point.logicalAddress)).toEqual(
      Array.from({ length: 8 }, (_, index) => `%MW${index}`),
    );

    // A tag the user placed at %MW10 is not overwritten by the next analog module.
    await createTag(db, alice, plcId, {
      name: "Recipe_Step",
      dataType: "INT16",
      role: "STATUS",
      logicalAddress: "%MW10",
    });
    await installModule(db, alice, plcId, { moduleModelId: ai, slotIndex: 4 });
    view = await config(plcId);
    expect(bank(view, "slot4-AI")?.points[0]?.logicalAddress).toBe("%MW11");
    await expectDomainError(removeModule(db, alice, plcId, first.id), "NOT_FOUND");
  });

  it("wires peripherals to module channels and protects a module that is in use", async () => {
    const { factoryId, plcId } = await newPlc("CPU 1511-1 PN");
    const install = async (sku: string, slotIndex: number) =>
      (await installModule(db, alice, plcId, { moduleModelId: await moduleId(sku), slotIndex })).id;
    const analogIn = await install("6ES7531-7KF00-0AB0", 3);

    // Without a digital or analog output module the hardwired drive has no place.
    await expectDomainError(add(plcId, "Generic VFD, hardwired control", "VFD-01"), "INCOMPATIBLE", "no-free-channel");
    expect(await deviceCount(factoryId)).toBe(1);

    await install("6ES7521-1BH10-0AA0", 1);
    await install("6ES7522-1BH10-0AA0", 2);
    await install("6ES7532-5HD00-0AB0", 4);
    const transmitter = await add(plcId, "Generic pressure transmitter, 4–20 mA", "PT-101");
    await add(plcId, "Generic VFD, hardwired control", "VFD-01");

    const view = await config(plcId);
    const wires = Object.fromEntries(
      (view.peripherals.find((peripheral) => peripheral.name === "VFD-01")?.wires ?? []).map((wire) => [
        wire.terminalLabel,
        wire,
      ]),
    );
    // Terminals take channels in label order: RESET, REV, RUN on the first three outputs.
    expect(wires.RUN).toMatchObject({ ioType: "DO", logicalAddress: "%QX0.2", tagName: "VFD_01_RUN" });
    expect(wires.REF).toMatchObject({ ioType: "AO", logicalAddress: "%QW0" });
    expect(wires.RUNNING).toMatchObject({ ioType: "DI", logicalAddress: "%MX0.1" });
    // PT-101 took the first analog input; the drive's frequency feedback got the next one.
    expect(wires.FREQ).toMatchObject({ ioType: "AI", logicalAddress: "%MW1" });
    expect(view.rack?.slots[2]?.module).toMatchObject({ modelName: "AI 8xU/I/RTD/TC ST", occupiedCount: 2 });

    const tags = Object.fromEntries(
      (await db.tag.findMany({ where: { plcInstanceId: plcId } })).map((tag) => [tag.name, tag]),
    );
    expect(tags.VFD_01_REF).toMatchObject({
      dataType: "INT16",
      role: "STATUS",
      scale: 0.01,
      unit: "Hz",
      sourceSignal: "frequencySetpoint",
    });
    expect(tags.VFD_01_FREQ).toMatchObject({ role: "FEEDBACK", scale: 0.01, sourceSignal: "actualFrequency" });
    expect(tags.PT_101_OUT).toMatchObject({ role: "PROCESS_VALUE", logicalAddress: "%MW0" });

    await expectDomainError(removeModule(db, alice, plcId, analogIn), "CONFLICT", "module-in-use");
    await removeDevice(db, alice, transmitter.deviceId);
    await expectDomainError(removeModule(db, alice, plcId, analogIn), "CONFLICT", "module-in-use");
  });

  it("persists the configuration: a fresh read returns the same view", async () => {
    const { plcId } = await newPlc("TM241CE24T", "M241-01");
    await add(plcId, "Generic three-phase motor", "M-01");
    await add(plcId, "Generic limit switch, 24 V DC", "ZS-01");
    const first = await config(plcId);
    expect(first.banks.map((candidate) => candidate.points.length)).toEqual([14, 10]);
    // Labels the source documents (Q0…Q3), channel numbers for the rest.
    expect(bank(first, "builtin-DO")?.points.map((point) => point.label)).toEqual([
      "Q0",
      "Q1",
      "Q2",
      "Q3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
    ]);
    expect(first.occupancy).toEqual({ total: 24, occupied: 3 });

    const reopened = openTestDb();
    try {
      expect(await getPlcConfiguration(reopened, alice, plcId)).toEqual(first);
    } finally {
      await reopened.$disconnect();
    }
  });
});
