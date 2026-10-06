// @vitest-environment node
import { afterAll, beforeAll, expect, it } from "vitest";
import type { DomainError } from "@/lib/domain/errors";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { loadModuleTypes } from "@/lib/process-modules";
import { ingestModuleTypes } from "@/lib/process-modules/ingest";
import { createDeviceInstance } from "@/lib/services/device-service";
import { createFactory } from "@/lib/services/factory-service";
import {
  bindModuleSignal,
  exportModuleIo,
  getFactoryIoSummary,
  getModuleIoRegistry,
  importModuleIo,
  listBindableTags,
  listFactoryModuleMappings,
  rebindModuleSignal,
  releaseModuleSignal,
} from "@/lib/services/module-io-service";
import { buildPlcExport } from "@/lib/services/plc-export-service";
import { planProcessBridge } from "@/lib/services/process-bridge-service";
import {
  assignModuleDevice,
  createModule,
  getModule,
  listModuleTypes,
  updateModule,
} from "@/lib/services/process-module-service";
import { createTag, deleteTag } from "@/lib/services/tag-service";
import { createGenericModel, describeDb, openTestDb, resetDb } from "./harness";

/**
 * The module PLC I/O registry (TASK-605): binding the signals of a process module to tags
 * of its PLCs, what the registry reports, and how the bridge and the PLC export read it.
 * Needs TEST_DATABASE_URL.
 */
const alice = { ownerId: "alice" };
const bob = { ownerId: "bob" };

const fail = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error as DomainError,
  );

describeDb("module PLC I/O registry", () => {
  let db: PrismaClient;
  let factoryId: string;
  let plcId: string;
  let plc2Id: string;
  let moduleId: string;
  let typeId: string;
  const tags = new Map<string, string>();
  const tagId = (name: string) => {
    const id = tags.get(name);
    if (!id) throw new Error(`no tag ${name}`);
    return id;
  };
  const bind = (signalKey: string, tag: string, id = moduleId) =>
    bindModuleSignal(db, alice, id, { signalKey, tagId: tagId(tag) });
  const row = async (signalKey: string, id = moduleId) =>
    (await getModuleIoRegistry(db, alice, id)).rows.find((candidate) => candidate.signal.key === signalKey);

  beforeAll(async () => {
    db = openTestDb();
    await resetDb(db);
    await ingestModuleTypes(db, loadModuleTypes());
    const factory = await createFactory(db, alice, { name: "Registry", slug: "registry", subnetCidr: "10.241.1.0/24" });
    factoryId = factory.id;
    const plcModel = await createGenericModel(db, "PLC", "Generic PLC", { architectureType: "COMPACT" });
    plcId = (await createDeviceInstance(db, { factoryId, deviceModelId: plcModel.id, name: "PLC-01" })).id;
    plc2Id = (await createDeviceInstance(db, { factoryId, deviceModelId: plcModel.id, name: "PLC-02" })).id;

    const percent = { dataType: "INT16", scale: 0.01, unit: "%" };
    const definitions: Array<[plc: string, tag: Record<string, unknown>]> = [
      [plcId, { name: "Start_Cmd", dataType: "BOOL", role: "COMMAND", logicalAddress: "%QX101.0" }],
      [plcId, { name: "PH_Run_Cmd", dataType: "BOOL", role: "STATUS", logicalAddress: "%QX100.0" }],
      [plcId, { name: "PH_Run_Cmd_2", dataType: "BOOL", role: "STATUS", logicalAddress: "%QX100.1" }],
      [plcId, { name: "PH_Speed_SP", ...percent, role: "PROCESS_VALUE", logicalAddress: "%QW100" }],
      [plcId, { name: "PH_Running", dataType: "BOOL", role: "STATUS", logicalAddress: "%MX10.0" }],
      [
        plcId,
        { name: "PH_Pressure", dataType: "FLOAT32", role: "PROCESS_VALUE", logicalAddress: "%MD10", unit: "bar" },
      ],
      [plcId, { name: "PH_Low_Pressure", dataType: "BOOL", role: "ALARM", logicalAddress: "%MX10.1" }],
      [plcId, { name: "Spare_Bit", dataType: "BOOL", role: "STATUS", logicalAddress: "%MX10.2" }],
      [plcId, { name: "Input_Bit", dataType: "BOOL", role: "STATUS", logicalAddress: "%IX0.0" }],
      [plc2Id, { name: "PH_Valve_Cmd", dataType: "BOOL", role: "STATUS", logicalAddress: "%QX0.0" }],
    ];
    for (const [plc, definition] of definitions) await createTag(db, alice, plc, definition);
    for (const tag of await db.tag.findMany({
      where: { plc: { deviceInstance: { factoryId } } },
      select: { id: true, name: true },
    })) {
      tags.set(tag.name, tag.id);
    }

    typeId = (await listModuleTypes(db)).find((type) => type.code === "PUMP_HOUSE")?.id ?? "";
    moduleId = (await createModule(db, alice, { factoryId, typeId, name: "PH-01" })).id;
    for (const [category, name, roleKey] of [
      ["PUMP", "P-01", "DUTY_PUMP"],
      ["SENSOR", "PT-01", "DISCHARGE_PRESSURE"],
    ] as const) {
      const model = await createGenericModel(db, category, `Generic ${category}`);
      const device = await createDeviceInstance(db, { factoryId, deviceModelId: model.id, name });
      await assignModuleDevice(db, alice, moduleId, { roleKey, deviceId: device.id });
    }
  }, 60_000);

  afterAll(async () => {
    await db.$disconnect();
  });

  it("lists every consumed signal of the profile unbound, and what blocks the module", async () => {
    const registry = await getModuleIoRegistry(db, alice, moduleId);
    expect(registry).toMatchObject({
      name: "PH-01",
      profile: "SINGLE_PUMP",
      type: { code: "PUMP_HOUSE", version: 1, simulatorModelType: "PUMP_HOUSE" },
      readyToRun: false,
    });
    expect(registry.rows.map((entry) => [entry.signal.key, entry.state, entry.blocking])).toEqual([
      ["DUTY_RUN_CMD", "UNBOUND", true],
      ["DUTY_SPEED_SETPOINT", "UNBOUND", false],
      ["DUTY_RUNNING", "UNBOUND", true],
      ["DUTY_FAULT", "UNBOUND", false],
      ["DISCHARGE_PRESSURE", "UNBOUND", true],
      ["SUCTION_LEVEL_LOW", "UNBOUND", false],
      ["DISCHARGE_VALVE_CMD", "UNBOUND", false],
      ["DISCHARGE_VALVE_OPEN", "UNBOUND", false],
      ["LOW_PRESSURE", "UNBOUND", false],
      ["PUMP_FAILED", "UNBOUND", false],
    ]);
    expect(registry.internal.map((signal) => signal.key)).toEqual(["FLOW"]);
    expect(registry.counts).toEqual({
      INPUT: { total: 5, bound: 0, invalid: 0, requiredUnbound: 2 },
      OUTPUT: { total: 3, bound: 0, invalid: 0, requiredUnbound: 1 },
      ALARM: { total: 2, bound: 0, invalid: 0, requiredUnbound: 0 },
    });
    expect(registry.plcs).toEqual([]);
    const detail = await getModule(db, alice, moduleId);
    expect(detail.bindings).toEqual({ bound: 0, invalid: 0, requiredUnbound: 3 });
    expect(detail.readyToRun).toBe(false);
  });

  it("offers the factory's tags as candidates, free compatible ones without a refusal", async () => {
    const candidates = await listBindableTags(db, alice, moduleId, "DUTY_RUN_CMD");
    const byName = new Map(candidates.map((candidate) => [candidate.tagName, candidate]));
    expect(byName.get("PH_Run_Cmd")).toMatchObject({ plcName: "PLC-01", refusal: null, heldBy: null });
    expect(byName.get("PH_Valve_Cmd")).toMatchObject({ plcName: "PLC-02", refusal: null });
    expect(byName.get("Start_Cmd")?.refusal?.rule).toBe("signal-plc-driven");
    expect(byName.get("Input_Bit")?.refusal?.rule).toBe("signal-address");
    expect(byName.get("PH_Speed_SP")?.refusal?.rule).toBe("signal-data-type");
    // A memory bit can carry a command the program writes; only an input (%I) cannot.
    expect(byName.get("PH_Running")?.refusal).toBeNull();
    expect((await fail(listBindableTags(db, alice, moduleId, "FLOW")))?.details.rule).toBe("module-signal-direction");
    expect((await fail(listBindableTags(db, alice, moduleId, "STANDBY_RUN_CMD")))?.details.rule).toBe(
      "module-signal-profile",
    );
    expect((await fail(listBindableTags(db, alice, moduleId, "NOPE")))?.code).toBe("NOT_FOUND");
  });

  it("binds compatible free tags and reports them; required signals bound makes the module ready", async () => {
    await bind("DUTY_RUN_CMD", "PH_Run_Cmd");
    await bind("DUTY_RUNNING", "PH_Running");
    const registry = await bind("DISCHARGE_PRESSURE", "PH_Pressure");
    expect(registry.readyToRun).toBe(true);
    expect(registry.rows.filter((entry) => entry.state === "BOUND").map((entry) => entry.signal.key)).toEqual([
      "DUTY_RUN_CMD",
      "DUTY_RUNNING",
      "DISCHARGE_PRESSURE",
    ]);
    expect((await row("DISCHARGE_PRESSURE"))?.binding).toMatchObject({
      plcName: "PLC-01",
      tagName: "PH_Pressure",
      logicalAddress: "%MD10",
      dataType: "FLOAT32",
      modbusArea: "HOLDING_REGISTER",
      modbusAddress: 2048 + 20,
      unit: "bar",
      ioPointId: null,
    });
    expect(registry.plcs).toEqual([{ plcId, plcName: "PLC-01", inputs: 2, outputs: 1, alarms: 0 }]);
    expect((await getModule(db, alice, moduleId)).bindings).toEqual({ bound: 3, invalid: 0, requiredUnbound: 0 });
  });

  it("refuses an incompatible tag, a tag another signal holds, a bound signal, and a tag of another owner", async () => {
    expect((await fail(bind("LOW_PRESSURE", "Input_Bit")))?.details.rule).toBe("signal-address");
    expect((await fail(bind("DUTY_SPEED_SETPOINT", "Start_Cmd")))?.details.rule).toBe("signal-plc-driven");
    expect((await fail(bind("DUTY_FAULT", "PH_Speed_SP")))?.details.rule).toBe("signal-address");
    expect((await fail(bind("DUTY_SPEED_SETPOINT", "PH_Run_Cmd_2")))?.details.rule).toBe("signal-data-type");
    const held = await fail(bind("LOW_PRESSURE", "PH_Running"));
    expect(held).toMatchObject({ code: "OCCUPIED_ENDPOINT", details: { rule: "tag-mapped", signal: "DUTY_RUNNING" } });
    expect((await fail(bind("DUTY_RUN_CMD", "PH_Run_Cmd_2")))?.details.rule).toBe("signal-bound");
    expect((await fail(bind("FLOW", "Spare_Bit")))?.details.rule).toBe("module-signal-direction");

    const other = await createFactory(db, bob, { name: "Elsewhere", slug: "elsewhere", subnetCidr: "10.241.2.0/24" });
    const otherPlc = (
      await createDeviceInstance(db, {
        factoryId: other.id,
        deviceModelId: (await createGenericModel(db, "PLC", "Generic PLC B", { architectureType: "COMPACT" })).id,
        name: "PLC-X",
      })
    ).id;
    await createTag(db, bob, otherPlc, { name: "Foreign", dataType: "BOOL", role: "STATUS", logicalAddress: "%MX0.0" });
    const foreign = await db.tag.findFirstOrThrow({ where: { plcInstanceId: otherPlc }, select: { id: true } });
    expect(
      (await fail(bindModuleSignal(db, alice, moduleId, { signalKey: "LOW_PRESSURE", tagId: foreign.id })))?.code,
    ).toBe("NOT_FOUND");
    expect((await fail(getModuleIoRegistry(db, bob, moduleId)))?.code).toBe("NOT_FOUND");
    // A second module cannot take a tag the first holds, whatever the signal.
    const second = (await createModule(db, alice, { factoryId, typeId, name: "PH-02" })).id;
    expect((await fail(bind("DUTY_RUN_CMD", "PH_Run_Cmd", second)))?.details.rule).toBe("tag-mapped");
    expect(
      (await listBindableTags(db, alice, second, "DUTY_RUN_CMD")).find((c) => c.tagName === "PH_Run_Cmd"),
    ).toMatchObject({
      refusal: { rule: "tag-mapped" },
      heldBy: { module: "PH-01", signal: "DUTY_RUN_CMD" },
    });
    await db.processModuleInstance.delete({ where: { id: second } });
  });

  it("lets two bindings race for one tag: exactly one wins", async () => {
    const second = (await createModule(db, alice, { factoryId, typeId, name: "PH-02" })).id;
    const results = await Promise.allSettled([
      bind("DISCHARGE_VALVE_CMD", "Spare_Bit"),
      bind("DUTY_FAULT", "Spare_Bit"),
      bind("DUTY_RUN_CMD", "Spare_Bit", second),
    ]);
    const won = results.filter((result) => result.status === "fulfilled");
    const lost = results.filter((result) => result.status === "rejected") as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost.map((result) => (result.reason as DomainError).code)).toEqual([
      "OCCUPIED_ENDPOINT",
      "OCCUPIED_ENDPOINT",
    ]);
    expect(await db.modulePlcIoMapping.count({ where: { tagId: tagId("Spare_Bit") } })).toBe(1);
    await db.modulePlcIoMapping.deleteMany({ where: { tagId: tagId("Spare_Bit") } });
    await db.processModuleInstance.delete({ where: { id: second } });
  });

  it("rebinds a signal to another tag and releases it, freeing the tag", async () => {
    const moved = await rebindModuleSignal(db, alice, moduleId, {
      signalKey: "DUTY_RUN_CMD",
      tagId: tagId("PH_Run_Cmd_2"),
    });
    expect(moved.rows.find((entry) => entry.signal.key === "DUTY_RUN_CMD")?.binding?.tagName).toBe("PH_Run_Cmd_2");
    expect(
      (await listBindableTags(db, alice, moduleId, "DISCHARGE_VALVE_CMD")).find((c) => c.tagName === "PH_Run_Cmd")
        ?.refusal,
    ).toBeNull();
    expect(
      (await fail(rebindModuleSignal(db, alice, moduleId, { signalKey: "DUTY_FAULT", tagId: tagId("Spare_Bit") })))
        ?.details.rule,
    ).toBe("signal-unbound");
    // Rebinding onto the tag it already has is fine; onto another module's tag is not.
    await rebindModuleSignal(db, alice, moduleId, { signalKey: "DUTY_RUN_CMD", tagId: tagId("PH_Run_Cmd_2") });

    await rebindModuleSignal(db, alice, moduleId, { signalKey: "DUTY_RUN_CMD", tagId: tagId("PH_Run_Cmd") });
    const released = await releaseModuleSignal(db, alice, moduleId, "DUTY_RUNNING");
    expect(released.readyToRun).toBe(false);
    expect(released.rows.find((entry) => entry.signal.key === "DUTY_RUNNING")).toMatchObject({
      state: "UNBOUND",
      blocking: true,
    });
    expect((await fail(releaseModuleSignal(db, alice, moduleId, "DUTY_RUNNING")))?.code).toBe("NOT_FOUND");
    // The tag itself was not touched.
    expect(await db.tag.count({ where: { id: tagId("PH_Running") } })).toBe(1);
    await bind("DUTY_RUNNING", "PH_Running");
  });

  it("shows a binding as INVALID when its tag no longer fits, and drops it when the tag goes", async () => {
    await bind("LOW_PRESSURE", "PH_Low_Pressure");
    // The tag is handed to a device signal behind the registry's back.
    const pump = await db.deviceInstance.findFirstOrThrow({ where: { factoryId, name: "P-01" }, select: { id: true } });
    await db.tag.update({
      where: { id: tagId("PH_Low_Pressure") },
      data: { sourceDeviceInstanceId: pump.id, sourceSignal: "faulted" },
    });
    const invalid = await row("LOW_PRESSURE");
    expect(invalid).toMatchObject({ state: "INVALID", blocking: false, issue: { rule: "tag-in-use" } });
    expect((await getModule(db, alice, moduleId)).bindings.invalid).toBe(1);
    expect((await getModuleIoRegistry(db, alice, moduleId)).readyToRun).toBe(true);
    await db.tag.update({
      where: { id: tagId("PH_Low_Pressure") },
      data: { sourceDeviceInstanceId: null, sourceSignal: null },
    });

    // A required signal's tag made invalid blocks the module.
    await db.tag.update({
      where: { id: tagId("PH_Running") },
      data: { sourceDeviceInstanceId: pump.id, sourceSignal: "running" },
    });
    expect(await row("DUTY_RUNNING")).toMatchObject({ state: "INVALID", blocking: true });
    expect((await getModuleIoRegistry(db, alice, moduleId)).readyToRun).toBe(false);
    await db.tag.update({
      where: { id: tagId("PH_Running") },
      data: { sourceDeviceInstanceId: null, sourceSignal: null },
    });

    // Deleting the tag removes the binding; the signal is unbound again.
    await deleteTag(db, alice, plcId, "PH_Low_Pressure");
    expect(await row("LOW_PRESSURE")).toMatchObject({ state: "UNBOUND", binding: null });
    await createTag(db, alice, plcId, {
      name: "PH_Low_Pressure",
      dataType: "BOOL",
      role: "ALARM",
      logicalAddress: "%MX10.1",
    });
    const recreated = await db.tag.findFirstOrThrow({
      where: { plcInstanceId: plcId, name: "PH_Low_Pressure" },
      select: { id: true },
    });
    tags.set("PH_Low_Pressure", recreated.id);
  });

  it("refuses a profile change that would orphan a binding", async () => {
    await bind("DISCHARGE_VALVE_CMD", "PH_Valve_Cmd");
    const registry = await getModuleIoRegistry(db, alice, moduleId);
    expect(registry.plcs.map((use) => [use.plcName, use.inputs, use.outputs, use.alarms])).toEqual([
      ["PLC-01", 2, 1, 0],
      ["PLC-02", 0, 1, 0],
    ]);
    // DUTY_STANDBY has every SINGLE_PUMP signal, so the change is fine; it adds required signals.
    await updateModule(db, alice, moduleId, { profile: "DUTY_STANDBY" });
    expect((await getModuleIoRegistry(db, alice, moduleId)).readyToRun).toBe(false);
    // A binding of a standby signal has no place in SINGLE_PUMP: the way back is refused until it is released.
    await createTag(db, alice, plc2Id, {
      name: "SB_Run_Cmd",
      dataType: "BOOL",
      role: "STATUS",
      logicalAddress: "%QX0.1",
    });
    const standby = await db.tag.findFirstOrThrow({
      where: { plcInstanceId: plc2Id, name: "SB_Run_Cmd" },
      select: { id: true },
    });
    await bindModuleSignal(db, alice, moduleId, { signalKey: "STANDBY_RUN_CMD", tagId: standby.id });
    expect((await fail(updateModule(db, alice, moduleId, { profile: "SINGLE_PUMP" })))?.details).toMatchObject({
      rule: "module-profile-in-use",
      signalKey: "STANDBY_RUN_CMD",
    });
    await releaseModuleSignal(db, alice, moduleId, "STANDBY_RUN_CMD");
    await updateModule(db, alice, moduleId, { profile: "SINGLE_PUMP" });
    expect((await getModuleIoRegistry(db, alice, moduleId)).readyToRun).toBe(true);
  });

  it("sums what every PLC gives and feeds the bridge from the stored bindings", async () => {
    expect(await getFactoryIoSummary(db, alice, factoryId)).toEqual({
      plcs: [
        { plcId, plcName: "PLC-01", modules: ["PH-01"], inputs: 2, outputs: 1, alarms: 0 },
        { plcId: plc2Id, plcName: "PLC-02", modules: ["PH-01"], inputs: 0, outputs: 1, alarms: 0 },
      ],
      modules: [{ moduleId, name: "PH-01", bound: 4 }],
    });
    const mappings = await listFactoryModuleMappings(db, alice, factoryId);
    expect(mappings.map((mapping) => mapping.signalKey).sort()).toEqual([
      "DISCHARGE_PRESSURE",
      "DISCHARGE_VALVE_CMD",
      "DUTY_RUNNING",
      "DUTY_RUN_CMD",
    ]);
    const plan = await planProcessBridge(db, alice, factoryId);
    expect(plan.blocked).toEqual([]);
    expect(plan.modules).toHaveLength(1);
    expect(plan.modules[0]?.bindings.map((binding) => binding.signal).sort()).toEqual(
      mappings.map((mapping) => mapping.signalKey).sort(),
    );
    expect([...plan.plcs.keys()].sort()).toEqual([plcId, plc2Id].sort());
    expect(await planProcessBridge(db, alice, factoryId, [])).toMatchObject({
      modules: [],
      blocked: [{ name: "PH-01" }],
    });
  });

  it("lists the module signals a PLC carries in its engineering export", async () => {
    const document = await buildPlcExport(db, alice, plcId);
    expect(document.moduleSignals).toEqual([
      {
        module: "PH-01",
        moduleType: "PUMP_HOUSE",
        signal: "DISCHARGE_PRESSURE",
        direction: "INPUT",
        tag: "PH_Pressure",
        programAddress: "%MD10",
      },
      {
        module: "PH-01",
        moduleType: "PUMP_HOUSE",
        signal: "DUTY_RUN_CMD",
        direction: "OUTPUT",
        tag: "PH_Run_Cmd",
        programAddress: "%QX100.0",
      },
      {
        module: "PH-01",
        moduleType: "PUMP_HOUSE",
        signal: "DUTY_RUNNING",
        direction: "INPUT",
        tag: "PH_Running",
        programAddress: "%MX10.0",
      },
    ]);
  });

  it("exports the bindings by names and reconstructs them on a module of the same type and profile", async () => {
    const document = await exportModuleIo(db, alice, moduleId);
    expect(document).toMatchObject({
      schema: "z-factory.module-io",
      schemaVersion: 1,
      module: { name: "PH-01", type: "PUMP_HOUSE", version: 1, profile: "SINGLE_PUMP" },
    });
    expect(document.bindings.map((binding) => [binding.signal, binding.plc, binding.tag])).toEqual([
      ["DUTY_RUN_CMD", "PLC-01", "PH_Run_Cmd"],
      ["DUTY_RUNNING", "PLC-01", "PH_Running"],
      ["DISCHARGE_PRESSURE", "PLC-01", "PH_Pressure"],
      ["DISCHARGE_VALVE_CMD", "PLC-02", "PH_Valve_Cmd"],
    ]);

    // Importing onto the same module replaces its bindings with the document's.
    await releaseModuleSignal(db, alice, moduleId, "DISCHARGE_VALVE_CMD");
    const restored = await importModuleIo(db, alice, moduleId, document);
    expect(restored.rows.filter((entry) => entry.state === "BOUND")).toHaveLength(4);

    // A second module of the same kind cannot take the same tags; a wrong type or profile is refused outright.
    const second = (await createModule(db, alice, { factoryId, typeId, name: "PH-02" })).id;
    expect((await fail(importModuleIo(db, alice, second, document)))?.details.rule).toBe("tag-mapped");
    expect(
      (
        await fail(
          importModuleIo(db, alice, second, { ...document, module: { ...document.module, profile: "DUTY_STANDBY" } }),
        )
      )?.details.rule,
    ).toBe("module-io-profile");
    expect(
      (await fail(importModuleIo(db, alice, second, { ...document, module: { ...document.module, version: 2 } })))
        ?.details.rule,
    ).toBe("module-io-type");
    expect(
      (
        await fail(
          importModuleIo(db, alice, second, {
            ...document,
            bindings: [{ signal: "DUTY_RUN_CMD", plc: "PLC-09", tag: "X" }],
          }),
        )
      )?.details.rule,
    ).toBe("module-io-tag");
    // All or nothing: the failed import left the second module without bindings.
    expect((await getModuleIoRegistry(db, alice, second)).rows.every((entry) => entry.state === "UNBOUND")).toBe(true);
    expect((await fail(importModuleIo(db, alice, second, { schema: "other" })))?.code).toBe("VALIDATION");
    await db.processModuleInstance.delete({ where: { id: second } });
  });

  it("removes the bindings with the module and keeps the tags", async () => {
    const before = await db.tag.count({ where: { plc: { deviceInstance: { factoryId } } } });
    await db.processModuleInstance.delete({ where: { id: moduleId } });
    expect(await db.modulePlcIoMapping.count()).toBe(0);
    expect(await db.tag.count({ where: { plc: { deviceInstance: { factoryId } } } })).toBe(before);
  });
});
