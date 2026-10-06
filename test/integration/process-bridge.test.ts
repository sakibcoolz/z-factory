// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { DomainError } from "@/lib/domain/errors";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { loadModuleTypes } from "@/lib/process-modules";
import { ingestModuleTypes } from "@/lib/process-modules/ingest";
import { ProcessBridgeRuntime } from "@/lib/runtimes/process-bridge/runtime";
import { createDeviceInstance } from "@/lib/services/device-service";
import { createFactory } from "@/lib/services/factory-service";
import {
  assignModuleDevice,
  createModule,
  defineModuleType,
  listModuleTypes,
} from "@/lib/services/process-module-service";
import {
  planProcessBridge,
  type ProcessBridgeDeps,
  type ProcessMappingInput,
  startProcessBridge,
} from "@/lib/services/process-bridge-service";
import { createTag } from "@/lib/services/tag-service";
import { createGenericModel, describeDb, openTestDb, resetDb } from "./harness";

/**
 * Planning the process bridge from stored configuration (TASK-603): which modules it would
 * run, with which tags, and what it refuses. The loop itself runs against a real OpenPLC
 * runtime in process-bridge-runtime.test.ts. Needs TEST_DATABASE_URL.
 */
const alice = { ownerId: "alice" };
const bob = { ownerId: "bob" };

describeDb("process bridge plan", () => {
  let db: PrismaClient;
  let factoryId: string;
  let plcId: string;
  let pumpHouseId: string;
  let typeId: string;
  const tags = new Map<string, string>();
  const tagId = (name: string) => {
    const id = tags.get(name);
    if (!id) throw new Error(`no tag ${name}`);
    return id;
  };
  const mapping = (moduleId: string, signalKey: string, tagName: string): ProcessMappingInput => ({
    moduleId,
    signalKey,
    tagId: tagId(tagName),
  });
  /** The complete, valid set for the pump house. */
  const complete = () => [
    mapping(pumpHouseId, "DUTY_RUN_CMD", "PH_Run_Cmd"),
    mapping(pumpHouseId, "DUTY_SPEED_SETPOINT", "PH_Speed_SP"),
    mapping(pumpHouseId, "DUTY_RUNNING", "PH_Running"),
    mapping(pumpHouseId, "DISCHARGE_PRESSURE", "PH_Pressure"),
    mapping(pumpHouseId, "LOW_PRESSURE", "PH_Low_Pressure"),
  ];
  const fail = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: unknown) => error as DomainError,
    );

  beforeAll(async () => {
    db = openTestDb();
    await resetDb(db);
    await ingestModuleTypes(db, loadModuleTypes());
    const factory = await createFactory(db, alice, { name: "Bridge", slug: "bridge", subnetCidr: "10.240.1.0/24" });
    factoryId = factory.id;
    const plcModel = await createGenericModel(db, "PLC", "Generic PLC", { architectureType: "COMPACT" });
    plcId = (await createDeviceInstance(db, { factoryId, deviceModelId: plcModel.id, name: "PLC-01" })).id;

    const percent = { dataType: "INT16", scale: 0.01, unit: "%" };
    const definitions = [
      // What a gateway or the UI may write: the program decides what the process gets.
      { name: "Start_Cmd", dataType: "BOOL", role: "COMMAND", logicalAddress: "%QX101.0" },
      { name: "Speed_SP", ...percent, role: "SETPOINT", logicalAddress: "%QW101" },
      // What the program drives into the process.
      { name: "PH_Run_Cmd", dataType: "BOOL", role: "STATUS", logicalAddress: "%QX100.0" },
      { name: "PH_Speed_SP", ...percent, role: "PROCESS_VALUE", logicalAddress: "%QW100" },
      // What the process returns to the program.
      { name: "PH_Running", dataType: "BOOL", role: "STATUS", logicalAddress: "%MX10.0" },
      { name: "PH_Pressure", dataType: "FLOAT32", role: "PROCESS_VALUE", logicalAddress: "%MD10", unit: "bar" },
      { name: "PH_Low_Pressure", dataType: "BOOL", role: "ALARM", logicalAddress: "%MX10.1" },
      // Tags that must be refused for one reason each.
      { name: "Input_Bit", dataType: "BOOL", role: "STATUS", logicalAddress: "%IX0.0" },
      { name: "Output_Bit", dataType: "BOOL", role: "STATUS", logicalAddress: "%QX100.1" },
      { name: "Pressure_Hz", dataType: "FLOAT32", role: "PROCESS_VALUE", logicalAddress: "%MD11", unit: "Hz" },
      { name: "Narrow_Speed", dataType: "INT16", scale: 0.001, role: "PROCESS_VALUE", logicalAddress: "%QW102" },
    ];
    for (const definition of definitions) await createTag(db, alice, plcId, definition);
    for (const tag of await db.tag.findMany({ where: { plcInstanceId: plcId }, select: { id: true, name: true } })) {
      tags.set(tag.name, tag.id);
    }

    const types = await listModuleTypes(db);
    typeId = types.find((type) => type.code === "PUMP_HOUSE")?.id ?? "";
    pumpHouseId = (await createModule(db, alice, { factoryId, typeId, name: "PH-01", config: { ratedFlow: 80 } })).id;
    // The devices the module's required roles need: a pump and a pressure transmitter.
    for (const [category, name, roleKey] of [
      ["PUMP", "P-01", "DUTY_PUMP"],
      ["SENSOR", "PT-01", "DISCHARGE_PRESSURE"],
    ] as const) {
      const model = await createGenericModel(db, category, `Generic ${category}`);
      const device = await createDeviceInstance(db, { factoryId, deviceModelId: model.id, name });
      await assignModuleDevice(db, alice, pumpHouseId, { roleKey, deviceId: device.id });
    }
  }, 60_000);

  afterAll(async () => {
    await db.$disconnect();
  });

  it("plans one model per module with its settings, and one binding per mapping", async () => {
    const plan = await planProcessBridge(db, alice, factoryId, complete(), { tickMs: 50 });
    expect(plan.blocked).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect(plan.modules).toHaveLength(1);
    const [module] = plan.modules;
    expect(module?.config).toMatchObject({
      instanceId: pumpHouseId,
      factoryId,
      moduleType: "PUMP_HOUSE",
      modelType: "PUMP_HOUSE",
      modelVersion: 1,
      tickMs: 50,
      clock: "manual",
      parameters: { ratedFlow: 80, ratedPressure: 6 },
    });
    expect(
      module?.bindings.map((binding) => [binding.signal, binding.direction, binding.area, binding.address]),
    ).toEqual([
      ["DUTY_RUN_CMD", "IN", "COIL", 800],
      ["DUTY_SPEED_SETPOINT", "IN", "HOLDING_REGISTER", 100],
      ["DUTY_RUNNING", "OUT", "COIL", 8192 + 80],
      ["DISCHARGE_PRESSURE", "OUT", "HOLDING_REGISTER", 2048 + 20],
      ["LOW_PRESSURE", "OUT", "COIL", 8192 + 81],
    ]);
    expect(module?.bindings[1]?.encoding).toMatchObject({ dataType: "INT16", scale: 0.01 });
    expect(module?.signals.map((signal) => signal.key)).toContain("DUTY_RUN_CMD");
    expect(module?.signals.map((signal) => signal.key)).not.toContain("STANDBY_RUN_CMD");
    expect([...plan.plcs.values()]).toEqual([{ name: "PLC-01", endpoint: null, runtimeStatus: "STOPPED" }]);
  });

  it("blocks a module whose required signals are not all mapped, naming them", async () => {
    const plan = await planProcessBridge(db, alice, factoryId, complete().slice(0, 2));
    expect(plan.modules).toEqual([]);
    expect(plan.blocked[0]?.issues.map((issue) => [issue.rule, issue.signalKey])).toEqual([
      ["required-signal", "DUTY_RUNNING"],
      ["required-signal", "DISCHARGE_PRESSURE"],
    ]);
  });

  it("refuses the tags the rules refuse, one rule each", async () => {
    const refused: Array<[signal: string, tag: string, rule: string]> = [
      ["DUTY_RUN_CMD", "Start_Cmd", "signal-plc-driven"],
      ["DUTY_RUN_CMD", "Input_Bit", "signal-address"],
      ["DUTY_RUNNING", "Output_Bit", "signal-address"],
      ["DISCHARGE_PRESSURE", "Pressure_Hz", "signal-unit"],
      ["DUTY_SPEED_SETPOINT", "Narrow_Speed", "signal-range"],
      ["DUTY_RUNNING", "Pressure_Hz", "signal-data-type"],
      ["FLOW", "Pressure_Hz", "module-signal-direction"],
      ["STANDBY_RUN_CMD", "Output_Bit", "module-signal-profile"],
      ["NOPE", "Output_Bit", "module-signal-unknown"],
    ];
    for (const [signal, tag, rule] of refused) {
      const mappings = [...complete().filter((entry) => entry.signalKey !== signal), mapping(pumpHouseId, signal, tag)];
      const plan = await planProcessBridge(db, alice, factoryId, mappings);
      expect(
        plan.blocked[0]?.issues.map((issue) => issue.rule),
        `${signal} on ${tag}`,
      ).toContain(rule);
    }
  });

  it("refuses a signal or a tag used twice", async () => {
    const twice = await planProcessBridge(db, alice, factoryId, [
      ...complete(),
      mapping(pumpHouseId, "DUTY_RUNNING", "Output_Bit"),
    ]);
    expect(twice.blocked[0]?.issues.map((issue) => issue.rule)).toEqual(["duplicate-signal"]);
    const shared = await planProcessBridge(db, alice, factoryId, [
      ...complete().slice(0, 4),
      mapping(pumpHouseId, "LOW_PRESSURE", "PH_Running"),
    ]);
    expect(shared.blocked[0]?.issues.map((issue) => issue.rule)).toEqual(["duplicate-tag"]);
  });

  it("knows nothing of tags, modules or factories of other owners", async () => {
    const other = await createFactory(db, bob, { name: "Elsewhere", slug: "elsewhere", subnetCidr: "10.240.2.0/24" });
    const otherModel = await createGenericModel(db, "PLC", "Generic PLC 2", { architectureType: "COMPACT" });
    const otherPlc = (
      await createDeviceInstance(db, { factoryId: other.id, deviceModelId: otherModel.id, name: "PLC-02" })
    ).id;
    await createTag(db, bob, otherPlc, { name: "Foreign", dataType: "BOOL", role: "STATUS", logicalAddress: "%MX0.0" });
    const foreign = await db.tag.findFirstOrThrow({ where: { plcInstanceId: otherPlc }, select: { id: true } });
    const plan = await planProcessBridge(db, alice, factoryId, [
      ...complete().slice(0, 4),
      { moduleId: pumpHouseId, signalKey: "LOW_PRESSURE", tagId: foreign.id },
    ]);
    expect(plan.blocked[0]?.issues[0]).toMatchObject({ rule: "modbus-mapping", signalKey: "LOW_PRESSURE" });

    expect((await fail(planProcessBridge(db, bob, factoryId, complete())))?.code).toBe("NOT_FOUND");
    expect(
      (await fail(planProcessBridge(db, alice, factoryId, [{ ...complete()[0]!, moduleId: randomUUID() }])))?.code,
    ).toBe("NOT_FOUND");
    expect((await fail(planProcessBridge(db, alice, factoryId, [{ moduleId: "x" }])))?.details.rule).toBe(
      "process-mapping-input",
    );
  });

  it("blocks a module that is incomplete, before any mapping is looked at", async () => {
    const empty = (await createModule(db, alice, { factoryId, typeId, name: "PH-02" })).id;
    const plan = await planProcessBridge(db, alice, factoryId, complete());
    expect(plan.modules.map((module) => module.moduleId)).toEqual([pumpHouseId]);
    expect(plan.blocked.find((module) => module.moduleId === empty)?.issues.map((issue) => issue.rule)).toEqual([
      "module-role-empty",
      "module-role-empty",
      "required-signal",
      "required-signal",
      "required-signal",
    ]);
    await db.processModuleInstance.delete({ where: { id: empty } });
  });

  it("leaves a module alone whose type names no process model", async () => {
    const type = await defineModuleType(db, {
      code: "HAND_VALVE",
      name: "Hand valve",
      roles: [{ key: "VALVE", name: "Valve", deviceCategoryCodes: ["VALVE"] }],
      signals: [{ key: "OPEN", name: "Open", direction: "INPUT", dataType: "BOOL", role: "STATUS", roleKey: "VALVE" }],
    });
    const manual = await createModule(db, alice, { factoryId, typeId: type.id, name: "HV-01" });
    const plan = await planProcessBridge(db, alice, factoryId, complete());
    expect(plan.modules.map((module) => module.moduleId)).toEqual([pumpHouseId]);
    expect(plan.skipped).toEqual([
      { moduleId: manual.id, name: "HV-01", reason: "Module type HAND_VALVE v1 has no process model." },
    ]);
  });

  it("does not start without the service, without an endpoint for the PLC, or with a blocked module", async () => {
    const bridge = new ProcessBridgeRuntime();
    const unconfigured: ProcessBridgeDeps = { db, bridge, client: null };
    expect((await fail(startProcessBridge(unconfigured, alice, factoryId, complete())))?.details.rule).toBe(
      "process-sim-not-configured",
    );
    // A client that is never reached: the plan is refused before the service is asked anything.
    const client = { health: async () => Promise.reject(new Error("never called")) } as unknown as NonNullable<
      ProcessBridgeDeps["client"]
    >;
    const configured: ProcessBridgeDeps = { db, bridge, client };
    expect((await fail(startProcessBridge(configured, alice, factoryId, complete())))?.details.rule).toBe(
      "plc-endpoint-required",
    );
    const blocked = await fail(startProcessBridge(configured, alice, factoryId, complete().slice(0, 2)));
    expect(blocked).toMatchObject({ code: "VALIDATION", details: { rule: "process-mapping" } });
    expect(blocked?.message).toContain("PH-01 cannot run");
    expect(blocked?.message).toContain("Duty pump running is not mapped.");
    expect((await fail(startProcessBridge(configured, alice, factoryId, [])))?.details.rule).toBe("process-mapping");
    expect(bridge.isRunning(factoryId)).toBe(false);
    expect(
      (await db.processModuleInstance.findUniqueOrThrow({ where: { id: pumpHouseId }, select: { status: true } }))
        .status,
    ).toBe("STOPPED");
  });
});
