// @vitest-environment node
import { afterAll, beforeAll, expect, it } from "vitest";
import { loadCatalog } from "@/lib/catalog";
import { ingestCatalog } from "@/lib/catalog/ingest";
import { DomainError } from "@/lib/domain/errors";
import { deviceScheduleCsv, ioScheduleCsv, tagScheduleCsv } from "@/lib/export/csv";
import { PLC_EXPORT_SCHEMA } from "@/lib/export/plc-export";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { createFactory } from "@/lib/services/factory-service";
import { addPeripheral, createPlc, installModule } from "@/lib/services/plc-config-service";
import { assertExportIsClean, buildPlcExport, exportFileStem } from "@/lib/services/plc-export-service";
import { createProgramVersion } from "@/lib/services/plc-runtime-service";
import { createTag } from "@/lib/services/tag-service";
import { linkDevices, placeDevice } from "@/lib/services/topology-service";
import { describeDb, openTestDb, resetDb } from "./harness";

const alice = { ownerId: "alice" };
const bob = { ownerId: "bob" };
const now = () => new Date("2026-10-05T12:00:00.000Z");

/** Things planted in the database that an export must never contain. */
const SECRETS = ["container-9f8e7d6c5b4a", "runtime-secret-value-0123456789abcdef", "/var/run/docker.sock"];

/** The PLC engineering export against PostgreSQL with the shipped catalog. */
describeDb("PLC engineering export against PostgreSQL", () => {
  let db: PrismaClient;
  let compact: { factoryId: string; plcId: string };
  let modular: { factoryId: string; plcId: string };

  const modelId = async (modelName: string) => (await db.deviceModel.findFirstOrThrow({ where: { modelName } })).id;
  const moduleId = async (sku: string) => (await db.moduleModel.findFirstOrThrow({ where: { sku } })).id;

  beforeAll(async () => {
    db = openTestDb();
    await resetDb(db);
    await ingestCatalog(db, loadCatalog());

    // Compact: a pump station with a valve, a transmitter, a protocol drive and a drive chain.
    const factory = await createFactory(db, alice, {
      name: "Pump House",
      slug: "pump-house",
      subnetCidr: "172.24.1.0/24",
    });
    const plc = await createPlc(db, alice, {
      factoryId: factory.id,
      deviceModelId: await modelId("CPU 1214C DC/DC/DC"),
      name: "PLC-01",
      role: "Pump station, inlet",
    });
    compact = { factoryId: factory.id, plcId: plc.id };
    const add = async (modelName: string, name: string) =>
      (await addPeripheral(db, alice, plc.id, { deviceModelId: await modelId(modelName), name })).deviceId;
    await add("Generic on/off valve, 24 V DC", "XV-101");
    await add("Generic pressure transmitter, 0–10 V", "PT-101");
    await add("Generic VFD, Modbus TCP", "VFD-02");
    const motor = await add("Generic three-phase motor", "M-01");
    const pump = await placeDevice(db, alice, factory.id, {
      deviceModelId: await modelId("Generic centrifugal pump"),
      x: 600,
      y: 300,
      name: "P-01",
    });
    await linkDevices(db, alice, factory.id, { fromId: motor, toId: pump.id });
    // A device of the factory that has nothing to do with this PLC.
    await placeDevice(db, alice, factory.id, {
      deviceModelId: await modelId("Generic fan"),
      x: 0,
      y: 900,
      name: "FAN-99",
    });
    await createTag(db, alice, plc.id, {
      name: "Pump01_StartCommand",
      dataType: "BOOL",
      role: "COMMAND",
      logicalAddress: "%QX2.0",
    });
    await createProgramVersion(db, alice, plc.id, { sourceText: "PROGRAM main\nEND_PROGRAM\n" });

    // What a running system would hold next to the configuration.
    await db.deviceInstance.update({
      where: { id: plc.id },
      data: {
        dockerContainerId: SECRETS[0],
        hostName: "plc-01",
        runtimeStatus: "RUNNING",
        configJson: { apiPassword: SECRETS[1], dockerHost: SECRETS[2] },
      },
    });
    await db.plcInstanceProfile.update({
      where: { deviceInstanceId: plc.id },
      data: {
        runtimeImage: "ghcr.io/autonomy-logic/openplc-runtime:v4.2.4",
        runtimeVersion: "v4.2.4",
        apiHostPort: 15990,
      },
    });
    await db.runtimePort.create({
      data: { deviceInstanceId: plc.id, protocol: "MODBUS_TCP", containerPort: 502, hostPort: 15991 },
    });

    // Modular: a rack with two modules and a drive wired to them.
    const bench = await createFactory(db, alice, { name: "Bench", slug: "bench", subnetCidr: "172.24.2.0/24" });
    const cpu = await createPlc(db, alice, {
      factoryId: bench.id,
      deviceModelId: await modelId("CPU 1511-1 PN"),
      name: "PLC-02",
    });
    modular = { factoryId: bench.id, plcId: cpu.id };
    await installModule(db, alice, cpu.id, { moduleModelId: await moduleId("6ES7521-1BH10-0AA0"), slotIndex: 1 });
    await installModule(db, alice, cpu.id, { moduleModelId: await moduleId("6ES7522-1BH10-0AA0"), slotIndex: 4 });
    await addPeripheral(db, alice, cpu.id, {
      deviceModelId: await modelId("Generic on/off valve, 24 V DC"),
      name: "XV-201",
    });
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("exports identity, model with its source, power and communication", async () => {
    const document = await buildPlcExport(db, alice, compact.plcId, { now });
    expect(document).toMatchObject({
      schema: PLC_EXPORT_SCHEMA,
      schemaVersion: 1,
      generatedAt: "2026-10-05T12:00:00.000Z",
      factory: { name: "Pump House", slug: "pump-house", subnetCidr: "172.24.1.0/24" },
      plc: {
        name: "PLC-01",
        role: "Pump station, inlet",
        architecture: "COMPACT",
        runtime: "OpenPLC",
        runtimeVersion: "v4.2.4",
      },
      model: {
        manufacturer: "Siemens",
        family: "SIMATIC S7-1200",
        modelName: "CPU 1214C DC/DC/DC",
        sku: "6ES7214-1AG40-0XB0",
        verificationStatus: "VERIFIED",
        source: { title: "SIMATIC S7-1200 Easy Book", revision: "A5E02486774-AG, 01/2015", verifiedAt: "2026-10-05" },
        facts: { workMemoryKb: 100 },
      },
      electrical: { supplyType: "DC", nominalVoltage: 24, voltageMin: 20.4, voltageMax: 28.8 },
      ports: [{ name: "PROFINET", protocols: ["MODBUS_TCP"] }],
    });
    expect(document.plc.runtimeNote).toMatch(/not vendor firmware/);
    expect(document.notice).toMatch(/not an electrical, mechanical or process certification/);
    expect(document.runtime).toBeUndefined();
  });

  it("exports the I/O structure, occupancy and terminal assignments of a compact PLC", async () => {
    const document = await buildPlcExport(db, alice, compact.plcId, { now });
    expect(document.hardware).toEqual({
      channels: [
        { ioType: "DI", count: 14, occupied: 3 },
        { ioType: "DO", count: 10, occupied: 2 },
        { ioType: "AI", count: 2, occupied: 1 },
      ],
      rack: null,
    });
    expect(document.ioPoints).toHaveLength(26);
    expect(document.ioPoints[0]).toEqual({
      source: "BUILT_IN",
      slot: null,
      module: null,
      ioType: "DI",
      channel: "Ia.0",
      vendorAddress: "%I0.0",
      programAddress: "%MX0.0",
      signalTypes: ["DC_24V"],
      status: "OCCUPIED",
      device: "XV-101",
      deviceTerminal: "ZSC",
      tag: "XV_101_ZSC",
    });
    expect(document.ioPoints.filter((point) => point.status === "FREE")).toHaveLength(20);
  });

  it("exports the tag list with its Modbus register map", async () => {
    const document = await buildPlcExport(db, alice, compact.plcId, { now });
    const tags = Object.fromEntries(document.tags.map((tag) => [tag.name, tag]));
    expect(Object.keys(tags).sort()).toEqual([
      "M_01_K1",
      "M_01_K1_AUX",
      "PT_101_OUT",
      "Pump01_StartCommand",
      "XV_101_Y1",
      "XV_101_ZSC",
      "XV_101_ZSO",
    ]);
    expect(tags.PT_101_OUT).toEqual({
      name: "PT_101_OUT",
      role: "PROCESS_VALUE",
      dataType: "INT16",
      direction: "INTERNAL",
      programAddress: "%MW0",
      modbusArea: "HOLDING_REGISTER",
      modbusAddress: 1024,
      modbusDisplayAddress: "41025",
      wordCount: 1,
      accessMode: "READ_ONLY",
      byteOrder: "BIG_ENDIAN",
      wordOrder: "HIGH_WORD_FIRST",
      scale: 0.1,
      offset: 0,
      unit: null,
      sourceDevice: "PT-101",
      sourceSignal: "value",
      // A wired AI channel: the field (here the simulator) drives it, the program reads it.
      authority: "PROGRAM_INPUT",
    });
    expect(tags.XV_101_Y1?.authority).toBe("PROGRAM_OUTPUT");
    expect(tags.Pump01_StartCommand?.authority).toBe("EXTERNAL_COMMAND");
    // The one tag a gateway may write.
    expect(tags.Pump01_StartCommand).toMatchObject({
      role: "COMMAND",
      accessMode: "READ_WRITE",
      modbusArea: "COIL",
      modbusAddress: 16,
    });
    expect(document.revision.modbusMapping).toBe(document.tags.length);
  });

  it("exports the connected-device schedule, relationships and network configuration", async () => {
    const document = await buildPlcExport(db, alice, compact.plcId, { now });
    expect(document.connectedDevices).toContainEqual({
      plcPoint: "DO Qa.1",
      tag: "M_01_K1",
      device: "M-01 · K1",
      model: "Generic three-phase motor",
      relationship: "CONTROLS",
      signalOrProtocol: "digital",
      address: "%QX0.1",
      unit: null,
    });
    expect(document.connectedDevices).toContainEqual(
      expect.objectContaining({
        plcPoint: "AI 0",
        device: "PT-101 · OUT",
        relationship: "FEEDS_BACK_TO",
        signalOrProtocol: "analog",
        address: "%MW0",
      }),
    );
    expect(document.connectedDevices).toContainEqual(
      expect.objectContaining({
        plcPoint: "—",
        device: "VFD-02",
        relationship: "COMMUNICATES_WITH",
        signalOrProtocol: "Modbus TCP",
        address: null,
      }),
    );
    // Six wired channels and one protocol link.
    expect(document.connectedDevices).toHaveLength(7);

    // The motor's pump is reached through the motor; the unrelated fan is not part of this PLC's export.
    expect(document.relationships).toContainEqual({
      source: "M-01",
      relationship: "MECHANICALLY_DRIVES",
      target: "P-01",
      detail: "",
    });
    expect(document.relationships).toContainEqual({
      source: "PLC-01",
      relationship: "COMMUNICATES_WITH",
      target: "VFD-02",
      detail: "Modbus TCP",
    });
    expect(document.topology.nodes.map((node) => node.name).sort()).toEqual([
      "M-01",
      "P-01",
      "PLC-01",
      "PT-101",
      "VFD-02",
      "XV-101",
    ]);
    expect(JSON.stringify(document)).not.toContain("FAN-99");

    expect(document.network).toEqual({
      serviceName: "plc-01",
      modbusEndpoint: { bindAddress: "127.0.0.1", hostPort: 15991, containerPort: 502 },
      modbusConventions: { addressBase: "zero-based", byteOrder: "BIG_ENDIAN", wordOrder: "HIGH_WORD_FIRST" },
      protocolLinks: [{ device: "VFD-02", protocol: "Modbus TCP" }],
    });
  });

  it("references versions and a configuration revision that changes only with the configuration", async () => {
    const first = await buildPlcExport(db, alice, compact.plcId, { now });
    expect(first.revision).toMatchObject({
      ioMapping: 4,
      program: { version: 1, language: "ST", status: "DRAFT" },
      deployedSnapshot: null,
    });
    expect(first.revision.program?.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(first.revision.configuration).toMatch(/^[0-9a-f]{12}$/);
    expect(exportFileStem(first)).toBe(`PLC-01-${first.revision.configuration}`);

    // Another time, and with the runtime snapshot: the same configuration, the same revision.
    const later = await buildPlcExport(db, alice, compact.plcId, {
      now: () => new Date("2027-01-01T00:00:00Z"),
      includeRuntime: true,
    });
    expect(later.generatedAt).not.toBe(first.generatedAt);
    expect(later.revision.configuration).toBe(first.revision.configuration);
    expect(later.runtime).toEqual({ state: "RUNNING", note: "Last state stored by Z-Factory, not a live reading." });

    // A configuration change gives a new revision.
    await createTag(db, alice, compact.plcId, {
      name: "Recipe_Step",
      dataType: "INT16",
      role: "STATUS",
      logicalAddress: "%MW40",
    });
    const changed = await buildPlcExport(db, alice, compact.plcId, { now });
    expect(changed.revision.configuration).not.toBe(first.revision.configuration);
    await db.tag.deleteMany({ where: { name: "Recipe_Step" } });
  });

  it("exports the rack, modules and slots of a modular PLC", async () => {
    const document = await buildPlcExport(db, alice, modular.plcId, { now });
    expect(document.plc.architecture).toBe("MODULAR");
    expect(document.hardware.rack).toEqual({
      name: "S7-1500 mounting rail",
      slotCount: 31,
      modules: [
        {
          slot: 1,
          modelName: "DI 16x24VDC BA",
          sku: "6ES7521-1BH10-0AA0",
          moduleType: "DIGITAL_INPUT",
          channels: 16,
          occupied: 2,
        },
        {
          slot: 4,
          modelName: "DQ 16x24VDC/0.5A BA",
          sku: "6ES7522-1BH10-0AA0",
          moduleType: "DIGITAL_OUTPUT",
          channels: 16,
          occupied: 1,
        },
      ],
    });
    expect(document.ioPoints).toHaveLength(32);
    expect(document.ioPoints.find((point) => point.tag === "XV_201_Y1")).toMatchObject({
      source: "MODULE",
      slot: 4,
      module: "DQ 16x24VDC/0.5A BA",
      ioType: "DO",
      programAddress: "%QX0.0",
      vendorAddress: null,
    });
    expect(document.network.modbusEndpoint).toBeNull();
    expect(document.revision.program).toBeNull();
  });

  it("writes CSV schedules with one row per channel, tag and connection", async () => {
    const document = await buildPlcExport(db, alice, compact.plcId, { now });
    const lines = (csv: string) => csv.trimEnd().split("\r\n");

    const io = lines(ioScheduleCsv(document));
    expect(io[0]).toBe(
      "Source,Slot,Module,Type,Channel,Vendor address,Program address,Signal,Status,Device,Terminal,Tag",
    );
    expect(io).toHaveLength(27);
    expect(io[1]).toBe("BUILT_IN,,,DI,Ia.0,%I0.0,%MX0.0,DC_24V,OCCUPIED,XV-101,ZSC,XV_101_ZSC");

    const tags = lines(tagScheduleCsv(document));
    expect(tags).toHaveLength(document.tags.length + 1);
    expect(tags).toContain(
      "PT_101_OUT,PROCESS_VALUE,INT16,INTERNAL,%MW0,HOLDING_REGISTER,1024,41025,1,READ_ONLY,BIG_ENDIAN,HIGH_WORD_FIRST,0.1,0,,PT-101,value,PROGRAM_INPUT",
    );

    const devices = lines(deviceScheduleCsv(document));
    expect(devices[0]).toBe("PLC Point,Tag,Device Instance,Model,Relationship,Signal/Protocol,Address,Unit");
    expect(devices).toHaveLength(8);
    // A model name with a comma is quoted.
    expect(devices).toContain('DO Qa.0,XV_101_Y1,XV-101 · Y1,"Generic on/off valve, 24 V DC",CONTROLS,digital,%QX0.0,');
  });

  it("never exports container ids, credentials, the Docker endpoint or the management port", async () => {
    const document = await buildPlcExport(db, alice, compact.plcId, { now, includeRuntime: true });
    const everything = [
      JSON.stringify(document),
      ioScheduleCsv(document),
      tagScheduleCsv(document),
      deviceScheduleCsv(document),
    ].join("\n");
    for (const secret of SECRETS) expect(everything).not.toContain(secret);
    expect(everything).not.toMatch(/docker/i);
    expect(everything).not.toContain("15990");
    expect(everything).not.toMatch(/password|secret|token|credential/i);
    expect(() => assertExportIsClean(document)).not.toThrow();
  });

  it("stops an export that would carry sensitive data, without repeating it in the error", async () => {
    const document = await buildPlcExport(db, alice, compact.plcId, { now });
    const leaking = { ...document, plc: { ...document.plc, role: "see unix:///var/run/docker.sock" } };
    try {
      assertExportIsClean(leaking);
      throw new Error("expected a DomainError");
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).details).toEqual({
        rule: "export-redaction",
        findings: ["$.plc.role: the Docker socket"],
      });
      expect((error as DomainError).message).not.toContain("docker.sock");
    }

    // A role typed by a user that looks like a Docker endpoint stops the real export too.
    await db.deviceInstance.update({ where: { id: modular.plcId }, data: { role: "tcp://10.0.0.5:2375" } });
    await expect(buildPlcExport(db, alice, modular.plcId, { now })).rejects.toMatchObject({
      details: { rule: "export-redaction" },
    });
    await db.deviceInstance.update({ where: { id: modular.plcId }, data: { role: null } });
  });

  it("is available to the owner only", async () => {
    await expect(buildPlcExport(db, bob, compact.plcId, { now })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(buildPlcExport(db, alice, "00000000-0000-7000-8000-000000000000", { now })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
