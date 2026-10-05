// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { withDomainErrors } from "@/lib/db/errors";
import { DomainError, type DomainErrorCode } from "@/lib/domain/errors";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { loadModuleTypes } from "@/lib/process-modules";
import { ingestModuleTypes } from "@/lib/process-modules/ingest";
import type { ModuleTypeInput } from "@/lib/process-modules/schema";
import { createDeviceInstance } from "@/lib/services/device-service";
import { createFactory, deleteFactory } from "@/lib/services/factory-service";
import {
  addModuleInterlock,
  assignModuleDevice,
  createModule,
  defineModuleType,
  deleteModule,
  getModule,
  getModuleType,
  listModules,
  listModuleTypes,
  removeModuleInterlock,
  unassignModuleDevice,
  updateModule,
  updateModuleInterlock,
} from "@/lib/services/process-module-service";
import { removeDevice } from "@/lib/services/topology-service";
import { createGenericModel, describeDb, openTestDb, resetDb } from "./harness";

/**
 * Process modules against PostgreSQL: type versions as reference data, module instances
 * of a factory, devices in typed roles, interlock metadata, and the rules that keep a
 * module inside its factory and its owner's reach.
 */
const alice = { ownerId: "alice" };
const bob = { ownerId: "bob" };

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

/** A type with a role that takes two devices and settings without defaults. */
const mixingCell: ModuleTypeInput = {
  code: "MIXING_CELL",
  name: "Mixing cell",
  configFields: [
    { key: "batchSize", label: "Batch size", type: "number", unit: "kg", min: 1, max: 5000 },
    { key: "mode", label: "Mode", type: "choice", options: ["BATCH", "CONTINUOUS"], defaultValue: "BATCH" },
  ],
  roles: [
    { key: "MIXER", name: "Mixer", deviceCategoryCodes: ["MIXER"] },
    { key: "DOSING_VALVE", name: "Dosing valve", deviceCategoryCodes: ["VALVE"], maxDevices: 2 },
    { key: "ANYTHING", name: "Auxiliary device", required: false, maxDevices: 8 },
  ],
  signals: [
    {
      key: "MIXER_RUN_CMD",
      name: "Mixer run",
      direction: "OUTPUT",
      dataType: "BOOL",
      role: "COMMAND",
      roleKey: "MIXER",
    },
    { key: "MIXER_RUNNING", name: "Mixer running", direction: "INPUT", dataType: "BOOL", role: "FEEDBACK" },
  ],
};

describeDb("process modules", () => {
  let db: PrismaClient;
  let factoryId: string;
  let otherFactoryId: string;
  let pumpHouseId: string;
  let tankId: string;
  const models: Record<string, string> = {};

  const newFactory = async (owner: { ownerId: string }, name: string, subnet: number) =>
    (await createFactory(db, owner, { name, slug: name.toLowerCase(), subnetCidr: `172.21.${subnet}.0/24` })).id;

  const device = async (category: string, name: string, inFactory = factoryId) =>
    (await createDeviceInstance(db, { factoryId: inFactory, deviceModelId: models[category], name })).id;

  const pumpHouse = (name: string, extra: Record<string, unknown> = {}) =>
    createModule(db, alice, { factoryId, typeId: pumpHouseId, name, ...extra });

  beforeAll(() => {
    db = openTestDb();
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(db);
    await ingestModuleTypes(db, loadModuleTypes());
    const types = await listModuleTypes(db);
    pumpHouseId = types.find((type) => type.code === "PUMP_HOUSE")?.id ?? "";
    tankId = types.find((type) => type.code === "TANK")?.id ?? "";
    for (const category of ["PUMP", "VFD", "SENSOR", "VALVE", "MIXER", "SWITCH"]) {
      models[category] = (await createGenericModel(db, category, `Generic ${category}`)).id;
    }
    factoryId = await newFactory(alice, "Dairy", 1);
    otherFactoryId = await newFactory(alice, "Bakery", 2);
  });

  // ───────────────────────────── types ─────────────────────────────

  it("stores the shipped types with their roles and signals, in the order they were written", async () => {
    const types = await listModuleTypes(db);
    expect(types.map((type) => [type.code, type.version, type.latest])).toEqual([
      ["PUMP_HOUSE", 1, true],
      ["TANK", 1, true],
    ]);

    const type = await getModuleType(db, pumpHouseId);
    const [shipped] = loadModuleTypes();
    expect(type.roles).toEqual(shipped?.roles);
    expect(type.signals).toEqual(shipped?.signals);
    expect(type.configFields).toEqual(shipped?.configFields);
    expect(type.signalCounts.OUTPUT).toEqual({ required: 2, optional: 3 });
    expect(type.signalCounts.ALARM).toEqual({ required: 0, optional: 2 });
  });

  it("seeds idempotently and refuses to change a stored version", async () => {
    expect(await ingestModuleTypes(db, loadModuleTypes())).toEqual({ created: 0, unchanged: 2 });

    const [first, ...rest] = loadModuleTypes();
    if (!first) throw new Error("no shipped type");
    const changed = { ...first, signals: first.signals.slice(1) };
    await domainError(ingestModuleTypes(db, [changed, ...rest]), "CONFLICT", "module-type-version");
    expect((await getModuleType(db, pumpHouseId)).signals).toHaveLength(first.signals.length);

    // The same change as a new version is stored next to the old one.
    expect(await ingestModuleTypes(db, [{ ...changed, version: 2 }])).toEqual({ created: 1, unchanged: 0 });
    const versions = (await listModuleTypes(db)).filter((type) => type.code === "PUMP_HOUSE");
    expect(versions.map((type) => [type.version, type.latest])).toEqual([
      [2, true],
      [1, false],
    ]);
    expect((await getModuleType(db, pumpHouseId)).latest).toBe(false);
  });

  it("defines a new type, and a version only once", async () => {
    const type = await defineModuleType(db, mixingCell);
    expect(type).toMatchObject({ code: "MIXING_CELL", version: 1, latest: true, profiles: [], roleCount: 3 });
    expect(type.signals.map((signal) => [signal.key, signal.roleKey])).toEqual([
      ["MIXER_RUN_CMD", "MIXER"],
      ["MIXER_RUNNING", null],
    ]);

    await domainError(defineModuleType(db, mixingCell), "CONFLICT");
    const broken = { ...mixingCell, version: 2, signals: [{ ...mixingCell.signals[0], role: "STATUS" }] };
    await domainError(defineModuleType(db, broken), "VALIDATION");
    expect((await listModuleTypes(db)).filter((item) => item.code === "MIXING_CELL")).toHaveLength(1);
    await domainError(getModuleType(db, "not-an-id"), "NOT_FOUND");
  });

  it("keeps the rules of a signal in the database too", async () => {
    const signal = { processModuleTypeId: pumpHouseId, name: "x", dataType: "BOOL" } as const;
    const insert = (data: Record<string, unknown>) =>
      withDomainErrors(() => db.moduleSignalDefinition.create({ data: { ...signal, ...data } as never }));

    await domainError(insert({ key: "A", direction: "OUTPUT", role: "FEEDBACK" }), "INVARIANT");
    await domainError(insert({ key: "B", direction: "INPUT", role: "COMMAND" }), "INVARIANT");
    await domainError(
      insert({ key: "C", direction: "INPUT", role: "PROCESS_VALUE", dataType: "FLOAT32", rangeMin: 5, rangeMax: 1 }),
      "VALIDATION",
    );
    await domainError(insert({ key: "DUTY_RUNNING", direction: "INPUT", role: "FEEDBACK" }), "CONFLICT");
    await domainError(
      withDomainErrors(() => db.processModuleType.create({ data: { code: "pump house", name: "x" } })),
      "VALIDATION",
    );
  });

  // ───────────────────────────── instances ─────────────────────────────

  it("creates several uniquely named modules in a factory", async () => {
    const first = await pumpHouse("PUMP-HOUSE-01", { location: "North well" });
    await pumpHouse("PUMP-HOUSE-02", { profile: "DUTY_STANDBY" });
    await createModule(db, alice, { factoryId, typeId: tankId, name: "TANK-01" });

    expect(first).toMatchObject({
      name: "PUMP-HOUSE-01",
      location: "North well",
      status: "STOPPED",
      profile: "SINGLE_PUMP",
      type: { code: "PUMP_HOUSE", version: 1 },
      config: { ratedFlow: 50, ratedPressure: 6 },
      deviceCount: 0,
      complete: false,
    });
    expect((await listModules(db, alice, factoryId)).map((item) => [item.name, item.profile])).toEqual([
      ["PUMP-HOUSE-01", "SINGLE_PUMP"],
      ["PUMP-HOUSE-02", "DUTY_STANDBY"],
      ["TANK-01", "LEVEL"],
    ]);

    await domainError(pumpHouse("PUMP-HOUSE-01"), "CONFLICT");
    // The name is unique within a factory, not across factories.
    await createModule(db, alice, { factoryId: otherFactoryId, typeId: pumpHouseId, name: "PUMP-HOUSE-01" });
    expect(await listModules(db, alice, otherFactoryId)).toHaveLength(1);
  });

  it("gives a module the roles and the I/O contract of its profile", async () => {
    const single = await pumpHouse("PH-1");
    const standby = await pumpHouse("PH-2", { profile: "DUTY_STANDBY" });

    expect(single.roles.map((role) => role.key)).not.toContain("STANDBY_PUMP");
    expect(standby.roles.map((role) => role.key)).toContain("STANDBY_PUMP");
    expect(single.signalCounts).toEqual({
      INPUT: { required: 2, optional: 3 },
      OUTPUT: { required: 1, optional: 2 },
      INTERNAL: { required: 0, optional: 1 },
      ALARM: { required: 0, optional: 2 },
    });
    expect(standby.signalCounts.INPUT).toEqual({ required: 3, optional: 4 });
    expect(standby.signalCounts.OUTPUT).toEqual({ required: 2, optional: 3 });
    expect(single.signals.find((signal) => signal.key === "DISCHARGE_PRESSURE")).toMatchObject({
      direction: "INPUT",
      dataType: "FLOAT32",
      role: "PROCESS_VALUE",
      unit: "bar",
      required: true,
      roleKey: "DISCHARGE_PRESSURE",
    });
  });

  it("refuses a module that does not fit its type or its factory", async () => {
    await domainError(pumpHouse("PH-1", { profile: "TRIPLEX" }), "VALIDATION", "module-profile");
    await domainError(pumpHouse("PH-1", { config: { heaterPower: 12 } }), "VALIDATION", "module-config");
    await domainError(pumpHouse("PH-1", { config: { ratedFlow: 0 } }), "VALIDATION", "module-config");
    await domainError(pumpHouse("pump house"), "VALIDATION");
    await domainError(createModule(db, alice, { factoryId, typeId: factoryId, name: "PH-1" }), "NOT_FOUND");
    await domainError(createModule(db, bob, { factoryId, typeId: pumpHouseId, name: "PH-1" }), "NOT_FOUND");
    expect(await listModules(db, alice, factoryId)).toEqual([]);

    const cell = await defineModuleType(db, mixingCell);
    await domainError(
      createModule(db, alice, { factoryId, typeId: cell.id, name: "MIX-1" }),
      "VALIDATION",
      "module-config",
    );
    await domainError(
      createModule(db, alice, { factoryId, typeId: cell.id, name: "MIX-1", profile: "BIG", config: { batchSize: 5 } }),
      "VALIDATION",
      "module-profile",
    );
    const unit = await createModule(db, alice, {
      factoryId,
      typeId: cell.id,
      name: "MIX-1",
      config: { batchSize: 5 },
    });
    expect(unit).toMatchObject({ profile: null, config: { batchSize: 5, mode: "BATCH" } });
  });

  // ───────────────────────────── device roles ─────────────────────────────

  it("assigns factory devices to typed roles until the module is complete", async () => {
    const unit = await pumpHouse("PH-1");
    expect(unit.issues.map((issue) => [issue.rule, issue.subject])).toEqual([
      ["module-role-empty", "DUTY_PUMP"],
      ["module-role-empty", "DISCHARGE_PRESSURE"],
    ]);

    const pumpId = await device("PUMP", "P-101");
    const sensorId = await device("SENSOR", "PT-101");
    const before = await db.deviceInstance.findUniqueOrThrow({ where: { id: pumpId } });

    await assignModuleDevice(db, alice, unit.id, { roleKey: "DUTY_PUMP", deviceId: pumpId });
    const complete = await assignModuleDevice(db, alice, unit.id, {
      roleKey: "DISCHARGE_PRESSURE",
      deviceId: sensorId,
    });

    expect(complete).toMatchObject({ deviceCount: 2, complete: true, issues: [] });
    expect(complete.roles.find((role) => role.key === "DUTY_PUMP")?.devices).toEqual([
      {
        assignmentId: expect.any(String),
        deviceId: pumpId,
        name: "P-101",
        categoryCode: "PUMP",
        categoryName: "Pump",
        manufacturer: "Generic / simulated",
        modelName: "Generic PUMP",
      },
    ]);
    // The role adds process meaning; the device is what it was.
    expect(await db.deviceInstance.findUniqueOrThrow({ where: { id: pumpId } })).toEqual(before);
    // A module reserves nothing on a PLC.
    expect(await db.tag.count()).toBe(0);
    expect(await db.plcIoPoint.count()).toBe(0);
  });

  it("rejects a device of another factory", async () => {
    const unit = await pumpHouse("PH-1");
    const foreignPump = await device("PUMP", "P-901", otherFactoryId);

    const error = await domainError(
      assignModuleDevice(db, alice, unit.id, { roleKey: "DUTY_PUMP", deviceId: foreignPump }),
      "INVARIANT",
      "module-device-factory",
    );
    expect(error.message).toBe("P-901 belongs to another factory.");

    // Another owner's device does not exist for this owner at all.
    const bobFactory = await newFactory(bob, "Brewery", 3);
    const bobPump = await device("PUMP", "P-501", bobFactory);
    await domainError(assignModuleDevice(db, alice, unit.id, { roleKey: "DUTY_PUMP", deviceId: bobPump }), "NOT_FOUND");
    expect((await getModule(db, alice, unit.id)).deviceCount).toBe(0);
    expect(await db.moduleDevice.count()).toBe(0);
  });

  it("rejects a device its role has no place for", async () => {
    const unit = await pumpHouse("PH-1");
    const pumpId = await device("PUMP", "P-101");
    const secondPump = await device("PUMP", "P-102");
    const valveId = await device("VALVE", "XV-101");
    const assign = (roleKey: string, deviceId: string) => assignModuleDevice(db, alice, unit.id, { roleKey, deviceId });

    const wrong = await domainError(assign("DUTY_PUMP", valveId), "INCOMPATIBLE", "module-role-category");
    expect(wrong.message).toBe("XV-101 is a Valve; Duty pump takes PUMP.");
    await domainError(assign("STANDBY_PUMP", secondPump), "INCOMPATIBLE", "module-role-profile");
    await domainError(assign("BOOSTER_PUMP", pumpId), "NOT_FOUND");
    await domainError(assign("DUTY_PUMP", "not-an-id"), "VALIDATION");

    await assign("DUTY_PUMP", pumpId);
    const full = await domainError(assign("DUTY_PUMP", secondPump), "CONFLICT", "module-role-full");
    expect(full.message).toBe("Duty pump already has its device.");
    expect((await getModule(db, alice, unit.id)).deviceCount).toBe(1);
  });

  it("fills a role up to the number of devices it takes, each device once", async () => {
    const cell = await defineModuleType(db, mixingCell);
    const unit = await createModule(db, alice, {
      factoryId,
      typeId: cell.id,
      name: "MIX-1",
      config: { batchSize: 5 },
    });
    const valves = [await device("VALVE", "XV-1"), await device("VALVE", "XV-2"), await device("VALVE", "XV-3")];
    const assign = (roleKey: string, deviceId: string) => assignModuleDevice(db, alice, unit.id, { roleKey, deviceId });

    await assign("DOSING_VALVE", valves[0] ?? "");
    const twice = await domainError(assign("DOSING_VALVE", valves[0] ?? ""), "CONFLICT");
    expect(twice.message).toBe("This device already has this role in the module.");
    await assign("DOSING_VALVE", valves[1] ?? "");
    const full = await domainError(assign("DOSING_VALVE", valves[2] ?? ""), "CONFLICT", "module-role-full");
    expect(full.message).toBe("Dosing valve already has 2 devices.");

    // A role that names no category takes any device, and a device may have a second role.
    const detail = await assign("ANYTHING", valves[0] ?? "");
    expect(detail.roles.map((role) => [role.key, role.devices.map((item) => item.name)])).toEqual([
      ["MIXER", []],
      ["DOSING_VALVE", ["XV-1", "XV-2"]],
      ["ANYTHING", ["XV-1"]],
    ]);
  });

  it("gives a role's last place to one of several assignments made at the same time", async () => {
    const unit = await pumpHouse("PH-1");
    const pumps = await Promise.all(["P-1", "P-2", "P-3", "P-4"].map((name) => device("PUMP", name)));
    // Open a connection per request first: otherwise the requests queue behind the pool and never overlap.
    await Promise.all(pumps.map(() => db.$executeRaw`SELECT pg_sleep(0.05)`));

    const results = await Promise.allSettled(
      pumps.map((deviceId) => assignModuleDevice(db, alice, unit.id, { roleKey: "DUTY_PUMP", deviceId })),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") expect((result.reason as DomainError).details.rule).toBe("module-role-full");
    }
    expect(await db.moduleDevice.count()).toBe(1);
  });

  it("lets a device serve two modules and leaves it in the factory when a module goes", async () => {
    const house = await pumpHouse("PH-1");
    const tank = await createModule(db, alice, { factoryId, typeId: tankId, name: "TANK-01" });
    const sensorId = await device("SENSOR", "LT-101");

    await assignModuleDevice(db, alice, house.id, { roleKey: "DISCHARGE_PRESSURE", deviceId: sensorId });
    await assignModuleDevice(db, alice, tank.id, { roleKey: "LEVEL_SENSOR", deviceId: sensorId });
    expect(await db.moduleDevice.count()).toBe(2);

    await deleteModule(db, alice, house.id);
    expect(await db.moduleDevice.count()).toBe(1);
    expect(await db.deviceInstance.count({ where: { id: sensorId } })).toBe(1);
    await domainError(getModule(db, alice, house.id), "NOT_FOUND");
  });

  it("takes a device out of its role, and shows the role empty when the device is deleted", async () => {
    const unit = await pumpHouse("PH-1");
    const pumpId = await device("PUMP", "P-101");
    const sensorId = await device("SENSOR", "PT-101");
    await assignModuleDevice(db, alice, unit.id, { roleKey: "DUTY_PUMP", deviceId: pumpId });
    const assigned = await assignModuleDevice(db, alice, unit.id, {
      roleKey: "DISCHARGE_PRESSURE",
      deviceId: sensorId,
    });
    const assignmentId = assigned.roles.find((role) => role.key === "DUTY_PUMP")?.devices[0]?.assignmentId ?? "";

    const without = await unassignModuleDevice(db, alice, unit.id, assignmentId);
    expect(without.issues.map((issue) => issue.subject)).toEqual(["DUTY_PUMP"]);
    expect(await db.deviceInstance.count({ where: { id: pumpId } })).toBe(1);
    await domainError(unassignModuleDevice(db, alice, unit.id, assignmentId), "NOT_FOUND");

    await removeDevice(db, alice, sensorId);
    const after = await getModule(db, alice, unit.id);
    expect(after.deviceCount).toBe(0);
    expect(after.issues.map((issue) => issue.subject)).toEqual(["DUTY_PUMP", "DISCHARGE_PRESSURE"]);
  });

  // ───────────────────────────── changes ─────────────────────────────

  it("renames a module, moves it and replaces its settings", async () => {
    const unit = await pumpHouse("PH-1", { location: "North well", config: { ratedFlow: 80 } });
    await pumpHouse("PH-2");

    const renamed = await updateModule(db, alice, unit.id, { name: "PH-NORTH", location: null });
    expect(renamed).toMatchObject({ name: "PH-NORTH", location: null, config: { ratedFlow: 80, ratedPressure: 6 } });

    const configured = await updateModule(db, alice, unit.id, { config: { ratedPressure: 10 } });
    expect(configured.config).toEqual({ ratedFlow: 50, ratedPressure: 10 });

    await domainError(updateModule(db, alice, unit.id, { name: "PH-2" }), "CONFLICT");
    await domainError(updateModule(db, alice, unit.id, { config: { ratedFlow: -1 } }), "VALIDATION", "module-config");
    await domainError(updateModule(db, alice, unit.id, { status: "RUNNING" }), "VALIDATION");
    expect((await getModule(db, alice, unit.id)).name).toBe("PH-NORTH");
  });

  it("changes the profile only when nothing would be left without a place", async () => {
    const unit = await pumpHouse("PH-1", { profile: "DUTY_STANDBY" });
    const standbyPump = await device("PUMP", "P-102");
    const assigned = await assignModuleDevice(db, alice, unit.id, { roleKey: "STANDBY_PUMP", deviceId: standbyPump });
    const assignmentId = assigned.roles.find((role) => role.key === "STANDBY_PUMP")?.devices[0]?.assignmentId ?? "";

    const stranded = await domainError(
      updateModule(db, alice, unit.id, { profile: "SINGLE_PUMP" }),
      "CONFLICT",
      "module-profile-in-use",
    );
    expect(stranded.message).toContain("P-102 is assigned to STANDBY_PUMP");

    await unassignModuleDevice(db, alice, unit.id, assignmentId);
    await addModuleInterlock(db, alice, unit.id, {
      code: "STANDBY_FAULT_STOP",
      name: "Standby pump fault",
      expression: { when: [{ signal: "STANDBY_FAULT", operator: "IS_TRUE" }], blocks: ["STANDBY_RUN_CMD"] },
    });
    const locked = await domainError(
      updateModule(db, alice, unit.id, { profile: "SINGLE_PUMP" }),
      "CONFLICT",
      "module-profile-in-use",
    );
    expect(locked.details.interlock).toBe("STANDBY_FAULT_STOP");
    expect((await getModule(db, alice, unit.id)).profile).toBe("DUTY_STANDBY");

    const detail = await getModule(db, alice, unit.id);
    await removeModuleInterlock(db, alice, unit.id, detail.interlocks[0]?.id ?? "");
    const single = await updateModule(db, alice, unit.id, { profile: "SINGLE_PUMP" });
    expect(single.profile).toBe("SINGLE_PUMP");
    expect(single.signals.some((signal) => signal.key.startsWith("STANDBY_"))).toBe(false);
  });

  // ───────────────────────────── interlocks ─────────────────────────────

  it("records interlocks over the module's own signals", async () => {
    const unit = await pumpHouse("PH-1");
    const interlock = {
      code: "HIGH_PRESSURE_STOP",
      name: "High discharge pressure",
      description: "Stops the duty pump above the pressure limit.",
      severity: "CRITICAL",
      expression: {
        when: [
          { signal: "DISCHARGE_PRESSURE", operator: "GT", value: 9.5 },
          { signal: "DUTY_RUNNING", operator: "IS_TRUE" },
        ],
        blocks: ["DUTY_RUN_CMD"],
      },
    };

    const added = await addModuleInterlock(db, alice, unit.id, interlock);
    expect(added.interlocks).toEqual([{ id: expect.any(String), enabled: true, ...interlock }]);
    await domainError(addModuleInterlock(db, alice, unit.id, interlock), "CONFLICT");

    const id = added.interlocks[0]?.id ?? "";
    const changed = await updateModuleInterlock(db, alice, unit.id, id, { enabled: false, severity: "WARNING" });
    expect(changed.interlocks[0]).toMatchObject({
      code: "HIGH_PRESSURE_STOP",
      name: "High discharge pressure",
      enabled: false,
      severity: "WARNING",
      expression: interlock.expression,
    });
    await domainError(updateModuleInterlock(db, alice, unit.id, id, { code: "OTHER" }), "VALIDATION");

    expect((await removeModuleInterlock(db, alice, unit.id, id)).interlocks).toEqual([]);
    await domainError(removeModuleInterlock(db, alice, unit.id, id), "NOT_FOUND");
  });

  it("refuses an interlock that does not fit the module", async () => {
    const unit = await pumpHouse("PH-1");
    const add = (expression: unknown, code = "LOCK") =>
      addModuleInterlock(db, alice, unit.id, { code, name: "Lock", expression });
    const running = { signal: "DUTY_RUNNING", operator: "IS_TRUE" };

    // A signal of another profile, a signal of no profile, a misread signal, a blocked input.
    await domainError(
      add({ when: [{ signal: "STANDBY_FAULT", operator: "IS_TRUE" }], blocks: ["DUTY_RUN_CMD"] }),
      "VALIDATION",
      "module-interlock",
    );
    await domainError(add({ when: [running], blocks: ["HEATER_ENABLE"] }), "VALIDATION", "module-interlock");
    await domainError(
      add({ when: [{ signal: "DISCHARGE_PRESSURE", operator: "IS_TRUE" }], blocks: ["DUTY_RUN_CMD"] }),
      "VALIDATION",
      "module-interlock",
    );
    await domainError(add({ when: [running], blocks: ["DUTY_FAULT"] }), "VALIDATION", "module-interlock");
    // Shape: no condition, no blocked output, a code that is no key.
    await domainError(add({ when: [], blocks: ["DUTY_RUN_CMD"] }), "VALIDATION");
    await domainError(add({ when: [running], blocks: [] }), "VALIDATION");
    await domainError(add({ when: [running], blocks: ["DUTY_RUN_CMD"] }, "high pressure"), "VALIDATION");
    expect(await db.moduleInterlock.count()).toBe(0);

    const added = await add({ when: [running], blocks: ["DUTY_RUN_CMD"] });
    await domainError(
      updateModuleInterlock(db, alice, unit.id, added.interlocks[0]?.id ?? "", {
        expression: { when: [running], blocks: ["FLOW"] },
      }),
      "VALIDATION",
      "module-interlock",
    );
    expect((await getModule(db, alice, unit.id)).interlocks[0]?.expression.blocks).toEqual(["DUTY_RUN_CMD"]);
  });

  // ───────────────────────────── ownership ─────────────────────────────

  it("keeps a module out of another owner's reach", async () => {
    const unit = await pumpHouse("PH-1");
    const pumpId = await device("PUMP", "P-101");

    await domainError(listModules(db, bob, factoryId), "NOT_FOUND");
    await domainError(getModule(db, bob, unit.id), "NOT_FOUND");
    await domainError(updateModule(db, bob, unit.id, { name: "MINE" }), "NOT_FOUND");
    await domainError(assignModuleDevice(db, bob, unit.id, { roleKey: "DUTY_PUMP", deviceId: pumpId }), "NOT_FOUND");
    await domainError(
      addModuleInterlock(db, bob, unit.id, {
        code: "LOCK",
        name: "Lock",
        expression: { when: [{ signal: "DUTY_RUNNING", operator: "IS_TRUE" }], blocks: ["DUTY_RUN_CMD"] },
      }),
      "NOT_FOUND",
    );
    await domainError(deleteModule(db, bob, unit.id), "NOT_FOUND");
    expect((await getModule(db, alice, unit.id)).name).toBe("PH-1");
  });

  it("removes a factory's modules with the factory and keeps the types", async () => {
    const unit = await pumpHouse("PH-1");
    await assignModuleDevice(db, alice, unit.id, { roleKey: "DUTY_PUMP", deviceId: await device("PUMP", "P-101") });
    await createModule(db, alice, { factoryId: otherFactoryId, typeId: pumpHouseId, name: "PH-1" });

    await deleteFactory(db, alice, factoryId);

    expect(await db.processModuleInstance.count()).toBe(1);
    expect(await db.moduleDevice.count()).toBe(0);
    expect(await listModuleTypes(db)).toHaveLength(2);
    // A type that modules were created from cannot be deleted from under them.
    await domainError(
      withDomainErrors(() => db.processModuleType.delete({ where: { id: pumpHouseId } })),
      "CONFLICT",
    );
  });
});
