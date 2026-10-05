// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { loadCatalog } from "@/lib/catalog";
import { ingestCatalog } from "@/lib/catalog/ingest";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { EMPTY_ACTION_STATE } from "@/lib/plc/form-state";
import { createFactory } from "@/lib/services/factory-service";
import { getPeripheralOptions, getPlcConfiguration } from "@/lib/services/plc-config-service";
import { describeDb, openTestDb, resetDb } from "./harness";

/**
 * The PLC configuration server actions with their real services and database. Only the
 * Next.js request plumbing is replaced: a redirect becomes a thrown marker, and the
 * actor and database come from the test.
 */
const state = vi.hoisted(() => ({ db: undefined as unknown, actor: { ownerId: "alice" } }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));
vi.mock("@/lib/db/client", async (original) => ({ ...(await original<object>()), getDb: () => state.db }));
vi.mock("@/lib/auth/actor", () => ({ requireActor: async () => state.actor }));

const actions = await import("@/app/factories/[factoryId]/plcs/actions");

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

/** Runs an action that is expected to redirect and returns where to. */
async function redirected(action: Promise<unknown>): Promise<string> {
  const error = await action.then(
    (result) => new Error(`no redirect: ${JSON.stringify(result)}`),
    (reason: unknown) => reason,
  );
  const message = (error as Error).message;
  expect(message).toMatch(/^REDIRECT /);
  return message.slice("REDIRECT ".length);
}

describeDb("PLC configuration server actions", () => {
  let db: PrismaClient;
  let factoryId: string;
  const alice = { ownerId: "alice" };

  const modelId = async (modelName: string) => (await db.deviceModel.findFirstOrThrow({ where: { modelName } })).id;
  const plcIdFrom = (url: string) => url.split("/plcs/")[1]?.split("/")[0] ?? "";

  beforeAll(async () => {
    db = openTestDb();
    state.db = db;
    await resetDb(db);
    await ingestCatalog(db, loadCatalog());
  });
  beforeEach(async () => {
    state.actor = alice;
    await db.factory.deleteMany();
    factoryId = (await createFactory(db, alice, { name: "Line", slug: "line", subnetCidr: "172.22.1.0/24" })).id;
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("creates a compact PLC from the form and opens its hardware screen", async () => {
    const url = await redirected(
      actions.createPlcAction(
        factoryId,
        EMPTY_ACTION_STATE,
        form({ deviceModelId: await modelId("CPU 1214C DC/DC/DC"), name: "PLC-01", role: "Pump station" }),
      ),
    );
    expect(url).toMatch(new RegExp(`^/factories/${factoryId}/plcs/[0-9a-f-]{36}/hardware$`));
    const view = await getPlcConfiguration(db, alice, plcIdFrom(url));
    expect(view.plc).toMatchObject({ name: "PLC-01", role: "Pump station", architectureType: "COMPACT" });
    expect(view.occupancy.total).toBe(26);
  });

  it("returns field errors and keeps what was typed when the PLC cannot be created", async () => {
    const deviceModelId = await modelId("CPU 1214C DC/DC/DC");
    await redirected(
      actions.createPlcAction(factoryId, EMPTY_ACTION_STATE, form({ deviceModelId, name: "PLC-01", role: "" })),
    );

    const duplicate = await actions.createPlcAction(
      factoryId,
      EMPTY_ACTION_STATE,
      form({ deviceModelId, name: "PLC-01", role: "Second" }),
    );
    expect(duplicate).toEqual({
      message: undefined,
      fieldErrors: { name: "A device with this name already exists in this factory." },
      values: { deviceModelId, name: "PLC-01", role: "Second" },
    });

    const invalid = await actions.createPlcAction(
      factoryId,
      EMPTY_ACTION_STATE,
      form({ deviceModelId, name: "has space", role: "" }),
    );
    expect(invalid.fieldErrors.name).toMatch(/letters, digits/);

    const noModel = await actions.createPlcAction(
      factoryId,
      EMPTY_ACTION_STATE,
      form({ deviceModelId: "", name: "PLC-02", role: "" }),
    );
    expect(Object.keys(noModel.fieldErrors)).toEqual(["deviceModelId"]);

    // Another owner gets the same answer as for a factory that does not exist.
    state.actor = { ownerId: "bob" };
    const foreign = await actions.createPlcAction(
      factoryId,
      EMPTY_ACTION_STATE,
      form({ deviceModelId, name: "PLC-03", role: "" }),
    );
    expect(foreign.message ?? Object.values(foreign.fieldErrors)[0]).toMatch(/does not exist/);
    expect(await db.deviceInstance.count({ where: { factoryId } })).toBe(1);
  });

  it("installs and removes a module through the modular path", async () => {
    const url = await redirected(
      actions.createPlcAction(
        factoryId,
        EMPTY_ACTION_STATE,
        form({ deviceModelId: await modelId("CPU 1511-1 PN"), name: "PLC-01", role: "" }),
      ),
    );
    const plcId = plcIdFrom(url);
    const moduleModelId = (await db.moduleModel.findFirstOrThrow({ where: { sku: "6ES7521-1BH10-0AA0" } })).id;

    expect(
      await redirected(
        actions.installModuleAction(factoryId, plcId, EMPTY_ACTION_STATE, form({ moduleModelId, slotIndex: "2" })),
      ),
    ).toBe(`/factories/${factoryId}/plcs/${plcId}/hardware`);

    const occupied = await actions.installModuleAction(
      factoryId,
      plcId,
      EMPTY_ACTION_STATE,
      form({ moduleModelId, slotIndex: "2" }),
    );
    expect(occupied.fieldErrors).toEqual({ slotIndex: "Slot 2 already holds a module." });
    const outOfRange = await actions.installModuleAction(
      factoryId,
      plcId,
      EMPTY_ACTION_STATE,
      form({ moduleModelId, slotIndex: "40" }),
    );
    expect(outOfRange.fieldErrors.slotIndex).toMatch(/slots 1 to 31/);
    const foreignModule = (await db.moduleModel.findFirstOrThrow({ where: { sku: "5069-IB16" } })).id;
    const incompatible = await actions.installModuleAction(
      factoryId,
      plcId,
      EMPTY_ACTION_STATE,
      form({ moduleModelId: foreignModule, slotIndex: "3" }),
    );
    expect(incompatible.fieldErrors.moduleModelId).toMatch(/cannot be installed with this CPU/);

    const installed = (await getPlcConfiguration(db, alice, plcId)).rack?.slots[1]?.module;
    expect(installed).toMatchObject({ modelName: "DI 16x24VDC BA", pointCount: 16 });
    await redirected(actions.removeModuleAction(factoryId, plcId, installed?.id ?? "", EMPTY_ACTION_STATE));
    expect((await getPlcConfiguration(db, alice, plcId)).occupancy.total).toBe(0);
  });

  it("adds a peripheral with the channels chosen in the form, then removes it", async () => {
    const plcId = plcIdFrom(
      await redirected(
        actions.createPlcAction(
          factoryId,
          EMPTY_ACTION_STATE,
          form({ deviceModelId: await modelId("CPU 1214C DC/DC/DC"), name: "PLC-01", role: "" }),
        ),
      ),
    );
    const valveModel = await modelId("Generic on/off valve, 24 V DC");
    const options = await getPeripheralOptions(db, alice, plcId, valveModel);
    const fields: Record<string, string> = { name: "XV-101", role: "Inlet valve" };
    // Take the last free channel of the right class for each terminal, not the suggested first one.
    const taken = new Set<string>();
    for (const terminal of options.terminals) {
      const choice = [...terminal.options].reverse().find((option) => !taken.has(option.pointId));
      if (!choice) throw new Error("no channel left");
      taken.add(choice.pointId);
      fields[`terminal:${terminal.id}`] = choice.pointId;
    }

    expect(
      await redirected(actions.addPeripheralAction(factoryId, plcId, valveModel, EMPTY_ACTION_STATE, form(fields))),
    ).toBe(`/factories/${factoryId}/plcs/${plcId}/connections`);
    const [peripheral] = (await getPlcConfiguration(db, alice, plcId)).peripherals;
    expect(peripheral).toMatchObject({ name: "XV-101", role: "Inlet valve" });
    expect(Object.fromEntries((peripheral?.wires ?? []).map((wire) => [wire.terminalLabel, wire.pointLabel]))).toEqual({
      Y1: "Qb.1",
      ZSC: "Ib.5",
      ZSO: "Ib.4",
    });
  });

  it("refuses two terminals on one channel and reports a taken name on its field", async () => {
    const plcId = plcIdFrom(
      await redirected(
        actions.createPlcAction(
          factoryId,
          EMPTY_ACTION_STATE,
          form({ deviceModelId: await modelId("CPU 1214C DC/DC/DC"), name: "PLC-01", role: "" }),
        ),
      ),
    );
    const valveModel = await modelId("Generic on/off valve, 24 V DC");
    const options = await getPeripheralOptions(db, alice, plcId, valveModel);
    const inputs = options.terminals.filter((terminal) => terminal.required === "DI");
    const samePoint = inputs[0]?.options[0]?.pointId ?? "";
    const clash = await actions.addPeripheralAction(
      factoryId,
      plcId,
      valveModel,
      EMPTY_ACTION_STATE,
      form({
        name: "XV-101",
        role: "",
        [`terminal:${inputs[0]?.id}`]: samePoint,
        [`terminal:${inputs[1]?.id}`]: samePoint,
      }),
    );
    expect(clash.message).toMatch(/not available/);
    expect(clash.values.name).toBe("XV-101");
    expect(await db.deviceInstance.count({ where: { factoryId } })).toBe(1);

    await redirected(
      actions.addPeripheralAction(factoryId, plcId, valveModel, EMPTY_ACTION_STATE, form({ name: "XV-101", role: "" })),
    );
    const taken = await actions.addPeripheralAction(
      factoryId,
      plcId,
      valveModel,
      EMPTY_ACTION_STATE,
      form({ name: "XV-101", role: "" }),
    );
    expect(taken.fieldErrors).toEqual({ name: "A device with this name already exists in this factory." });

    const deviceId = (await getPlcConfiguration(db, alice, plcId)).peripherals[0]?.deviceId ?? "";
    await redirected(actions.removePeripheralAction(factoryId, plcId, deviceId, EMPTY_ACTION_STATE));
    expect((await getPlcConfiguration(db, alice, plcId)).occupancy.occupied).toBe(0);

    expect(await redirected(actions.deletePlcAction(factoryId, plcId, EMPTY_ACTION_STATE))).toBe(
      `/factories/${factoryId}`,
    );
    expect(await db.deviceInstance.count({ where: { factoryId } })).toBe(0);
  });
});
