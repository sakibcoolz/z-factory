// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { DomainError, type DomainErrorCode } from "@/lib/domain/errors";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { createDeviceInstance } from "@/lib/services/device-service";
import { createFactory } from "@/lib/services/factory-service";
import { createTag, deleteTag, getModbusMap } from "@/lib/services/tag-service";
import { createGenericModel, describeDb, openTestDb, resetDb } from "./harness";

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

describeDb("tag registry and Modbus map against PostgreSQL", () => {
  let db: PrismaClient;
  let plcId: string;
  let vfdId: string;
  let foreignDeviceId: string;

  const tag = (overrides: Record<string, unknown> = {}) => ({
    name: "VFD01_SpeedSetpoint",
    dataType: "INT16",
    role: "SETPOINT",
    logicalAddress: "%QW0",
    ...overrides,
  });
  const version = async () => (await getModbusMap(db, alice, plcId)).version;

  beforeAll(() => {
    db = openTestDb();
  });
  beforeEach(async () => {
    await resetDb(db);
    const factory = await createFactory(db, alice, {
      name: "Pump House",
      slug: "pump-house",
      subnetCidr: "172.20.1.0/24",
    });
    const other = await createFactory(db, bob, { name: "Other", slug: "other", subnetCidr: "172.20.2.0/24" });
    const plcModel = await createGenericModel(db, "PLC", "Generic compact PLC", { architectureType: "COMPACT" });
    const vfdModel = await createGenericModel(db, "VFD", "Generic VFD");
    plcId = (await createDeviceInstance(db, { factoryId: factory.id, deviceModelId: plcModel.id, name: "PLC-01" })).id;
    vfdId = (await createDeviceInstance(db, { factoryId: factory.id, deviceModelId: vfdModel.id, name: "VFD-01" })).id;
    foreignDeviceId = (
      await createDeviceInstance(db, { factoryId: other.id, deviceModelId: vfdModel.id, name: "VFD-01" })
    ).id;
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("derives the Modbus mapping and access mode from the located address and the role", async () => {
    const setpoint = await createTag(db, alice, plcId, tag({ scale: 0.1, unit: "Hz", sourceDeviceInstanceId: vfdId }));
    expect(setpoint).toMatchObject({
      direction: "OUTPUT",
      area: "HOLDING_REGISTER",
      address: 0,
      wordCount: 1,
      displayAddress: "40001",
      accessMode: "READ_WRITE",
      byteOrder: "BIG_ENDIAN",
      wordOrder: "HIGH_WORD_FIRST",
      scale: 0.1,
      unit: "Hz",
      sourceDeviceInstanceId: vfdId,
    });

    const feedback = await createTag(
      db,
      alice,
      plcId,
      tag({ name: "VFD01_ActualFrequency", dataType: "FLOAT32", role: "FEEDBACK", logicalAddress: "%md4" }),
    );
    // A feedback value sits in a writable Modbus area, yet the tag itself is read-only.
    expect(feedback).toMatchObject({
      logicalAddress: "%MD4",
      direction: "INTERNAL",
      area: "HOLDING_REGISTER",
      address: 2056,
      wordCount: 2,
      accessMode: "READ_ONLY",
    });

    const input = await createTag(
      db,
      alice,
      plcId,
      tag({ name: "PT101_Pressure", dataType: "UINT16", role: "PROCESS_VALUE", logicalAddress: "%IW0" }),
    );
    expect(input).toMatchObject({ direction: "INPUT", area: "INPUT_REGISTER", address: 0, accessMode: "READ_ONLY" });
  });

  it("keeps command and setpoint tags apart from read-only ones", async () => {
    await createTag(
      db,
      alice,
      plcId,
      tag({ name: "Pump01_StartCommand", dataType: "BOOL", role: "COMMAND", logicalAddress: "%QX0.0" }),
    );
    await createTag(
      db,
      alice,
      plcId,
      tag({ name: "Pump01_Fault", dataType: "BOOL", role: "ALARM", logicalAddress: "%QX0.1" }),
    );
    await createTag(
      db,
      alice,
      plcId,
      tag({ name: "LS101_Level", dataType: "BOOL", role: "STATUS", logicalAddress: "%IX0.0" }),
    );

    const rows = (await getModbusMap(db, alice, plcId)).rows;
    expect(rows.map((row) => [row.name, row.role, row.accessMode])).toEqual([
      ["Pump01_StartCommand", "COMMAND", "READ_WRITE"],
      ["Pump01_Fault", "ALARM", "READ_ONLY"],
      ["LS101_Level", "STATUS", "READ_ONLY"],
    ]);

    // A command or setpoint on an input address can never be written: refused outright.
    await expectDomainError(
      createTag(
        db,
        alice,
        plcId,
        tag({ name: "Bad_Command", dataType: "BOOL", role: "COMMAND", logicalAddress: "%IX0.1" }),
      ),
      "INCOMPATIBLE",
      "role-area",
    );
    await expectDomainError(
      createTag(db, alice, plcId, tag({ name: "Bad_Setpoint", role: "SETPOINT", logicalAddress: "%IW1" })),
      "INCOMPATIBLE",
      "role-area",
    );
  });

  it("validates names, addresses, data types and unknown fields", async () => {
    await expectDomainError(createTag(db, alice, plcId, tag({ name: "1Bad Name" })), "VALIDATION");
    await expectDomainError(
      createTag(db, alice, plcId, tag({ logicalAddress: "40001" })),
      "VALIDATION",
      "located-syntax",
    );
    await expectDomainError(
      createTag(db, alice, plcId, tag({ logicalAddress: "%QW5000" })),
      "VALIDATION",
      "located-range",
    );
    await expectDomainError(
      createTag(db, alice, plcId, tag({ dataType: "FLOAT32" })),
      "INCOMPATIBLE",
      "data-type-size",
    );
    await expectDomainError(createTag(db, alice, plcId, tag({ scale: 0 })), "VALIDATION");
    // The mapping is derived; a caller cannot dictate an address or access mode.
    await expectDomainError(createTag(db, alice, plcId, tag({ protocolAddress: 7 })), "VALIDATION");
    await expectDomainError(
      createTag(db, alice, plcId, tag({ accessMode: "READ_WRITE", role: "FEEDBACK" })),
      "VALIDATION",
    );
    expect((await getModbusMap(db, alice, plcId)).rows).toEqual([]);
  });

  it("rejects address collisions, including overlapping multi-word ranges", async () => {
    await createTag(db, alice, plcId, tag());
    await createTag(
      db,
      alice,
      plcId,
      tag({ name: "Pressure", dataType: "FLOAT32", role: "PROCESS_VALUE", logicalAddress: "%MD0" }),
    );

    await expectDomainError(createTag(db, alice, plcId, tag()), "CONFLICT");
    await expectDomainError(createTag(db, alice, plcId, tag({ name: "Same_Address" })), "CONFLICT", "address-overlap");
    await expectDomainError(
      createTag(
        db,
        alice,
        plcId,
        tag({ name: "Same_Double", dataType: "INT32", role: "FEEDBACK", logicalAddress: "%MD0" }),
      ),
      "CONFLICT",
      "address-overlap",
    );
    // The next double word and a different area at the same number do not collide.
    await createTag(
      db,
      alice,
      plcId,
      tag({ name: "Next_Double", dataType: "INT32", role: "FEEDBACK", logicalAddress: "%MD1" }),
    );
    await createTag(
      db,
      alice,
      plcId,
      tag({ name: "Input_Zero", dataType: "UINT16", role: "FEEDBACK", logicalAddress: "%IW0" }),
    );
    expect((await getModbusMap(db, alice, plcId)).rows).toHaveLength(4);
  });

  it("bumps the Modbus mapping version on every change", async () => {
    expect(await version()).toBe(0);
    await createTag(db, alice, plcId, tag());
    expect(await version()).toBe(1);
    await expectDomainError(createTag(db, alice, plcId, tag()), "CONFLICT");
    expect(await version()).toBe(1);
    await deleteTag(db, alice, plcId, "VFD01_SpeedSetpoint");
    expect(await version()).toBe(2);
    await expectDomainError(deleteTag(db, alice, plcId, "VFD01_SpeedSetpoint"), "NOT_FOUND");
    expect(await version()).toBe(2);
  });

  it("exposes the map with explicit conventions for the inspector and the export", async () => {
    await createTag(db, alice, plcId, tag({ scale: 0.1, unit: "Hz" }));
    const map = await getModbusMap(db, alice, plcId);

    expect(map).toMatchObject({
      plcId,
      version: 1,
      conventions: { addressBase: "zero-based", byteOrder: "BIG_ENDIAN", wordOrder: "HIGH_WORD_FIRST" },
      endpoint: null,
    });
    expect(map.rows[0]).toEqual({
      name: "VFD01_SpeedSetpoint",
      role: "SETPOINT",
      dataType: "INT16",
      direction: "OUTPUT",
      logicalAddress: "%QW0",
      area: "HOLDING_REGISTER",
      address: 0,
      wordCount: 1,
      displayAddress: "40001",
      accessMode: "READ_WRITE",
      byteOrder: "BIG_ENDIAN",
      wordOrder: "HIGH_WORD_FIRST",
      scale: 0.1,
      offset: 0,
      unit: "Hz",
      sourceDeviceInstanceId: null,
      sourceSignal: null,
      authority: "EXTERNAL_COMMAND",
    });
  });

  it("scopes tags to the owner's PLCs and to devices of the same factory", async () => {
    await expectDomainError(createTag(db, bob, plcId, tag()), "NOT_FOUND");
    await expectDomainError(getModbusMap(db, bob, plcId), "NOT_FOUND");
    await expectDomainError(createTag(db, alice, vfdId, tag()), "INCOMPATIBLE", "openplc-plc-only");
    await expectDomainError(createTag(db, alice, plcId, tag({ sourceDeviceInstanceId: foreignDeviceId })), "NOT_FOUND");
  });
});
