// @vitest-environment node
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { loadCatalog } from "@/lib/catalog";
import { ingestCatalog } from "@/lib/catalog/ingest";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { createFactory } from "@/lib/services/factory-service";
import { addPeripheral, createPlc } from "@/lib/services/plc-config-service";
import { describeDb, openTestDb, resetDb } from "./harness";

/**
 * The export download route with its real service and database. Only the actor and the
 * database handle are supplied by the test.
 */
const state = vi.hoisted(() => ({ db: undefined as unknown, actor: { ownerId: "alice" } }));
vi.mock("@/lib/db/client", async (original) => ({ ...(await original<object>()), getDb: () => state.db }));
vi.mock("@/lib/auth/actor", () => ({ requireActor: async () => state.actor }));

const { GET } = await import("@/app/factories/[factoryId]/plcs/[plcId]/export/files/[file]/route");

describeDb("PLC export download route", () => {
  let db: PrismaClient;
  let factoryId: string;
  let plcId: string;
  let otherFactoryId: string;

  const get = (file: string, ids: { factoryId?: string; plcId?: string } = {}, query = "") =>
    GET(new Request(`http://localhost/export/files/${file}${query}`), {
      params: Promise.resolve({ factoryId: ids.factoryId ?? factoryId, plcId: ids.plcId ?? plcId, file }),
    });

  beforeAll(async () => {
    db = openTestDb();
    state.db = db;
    await resetDb(db);
    await ingestCatalog(db, loadCatalog());
    const alice = { ownerId: "alice" };
    const model = async (modelName: string) => (await db.deviceModel.findFirstOrThrow({ where: { modelName } })).id;
    factoryId = (
      await createFactory(db, alice, { name: "Pump House", slug: "pump-house", subnetCidr: "172.25.1.0/24" })
    ).id;
    otherFactoryId = (await createFactory(db, alice, { name: "Other", slug: "other", subnetCidr: "172.25.2.0/24" })).id;
    plcId = (
      await createPlc(db, alice, {
        factoryId,
        deviceModelId: await model("CPU 1214C DC/DC/DC"),
        name: "PLC 01".replace(" ", "-"),
      })
    ).id;
    await addPeripheral(db, alice, plcId, {
      deviceModelId: await model("Generic on/off valve, 24 V DC"),
      name: "XV-101",
    });
    await db.deviceInstance.update({
      where: { id: plcId },
      data: { dockerContainerId: "container-secret-1", runtimeStatus: "RUNNING" },
    });
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("downloads the JSON document as an attachment named after PLC and revision", async () => {
    const response = await get("plc.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const document = JSON.parse(await response.text());
    expect(document).toMatchObject({
      schema: "z-factory.plc-export",
      plc: { name: "PLC-01" },
      factory: { id: factoryId },
    });
    expect(document.runtime).toBeUndefined();
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="PLC-01-${document.revision.configuration}-export.json"`,
    );

    const withRuntime = JSON.parse(await (await get("plc.json", {}, "?runtime=1")).text());
    expect(withRuntime.runtime).toMatchObject({ state: "RUNNING" });
    expect(withRuntime.revision.configuration).toBe(document.revision.configuration);
  });

  it("downloads the three CSV schedules as UTF-8 with a byte-order mark", async () => {
    const expected: Record<string, [string, number]> = {
      "io.csv": ["Source,Slot,Module,Type,Channel", 27],
      "tags.csv": ["Tag,Role,Data type", 4],
      "devices.csv": ["PLC Point,Tag,Device Instance", 4],
    };
    for (const [file, [header, lines]] of Object.entries(expected)) {
      const response = await get(file);
      expect(response.status, file).toBe(200);
      expect(response.headers.get("content-type"), file).toBe("text/csv; charset=utf-8");
      expect(response.headers.get("content-disposition"), file).toMatch(
        new RegExp(`^attachment; filename="PLC-01-[0-9a-f]{12}-${file}"$`),
      );
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect([...bytes.slice(0, 3)], file).toEqual([0xef, 0xbb, 0xbf]);
      const text = new TextDecoder("utf-8", { ignoreBOM: false }).decode(bytes);
      expect(text.startsWith(header), file).toBe(true);
      expect(text.trimEnd().split("\r\n"), file).toHaveLength(lines);
    }
  });

  it("answers 404 for unknown files, malformed ids, another factory and another owner", async () => {
    for (const response of [
      await get("program.zip"),
      await get("../../../etc/passwd"),
      await get("plc.json", { plcId: "not-a-uuid" }),
      await get("plc.json", { plcId: "00000000-0000-7000-8000-000000000000" }),
      // The PLC exists, but not in this factory.
      await get("plc.json", { factoryId: otherFactoryId }),
    ]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Not found." });
    }
    state.actor = { ownerId: "bob" };
    expect((await get("plc.json")).status).toBe(404);
    state.actor = { ownerId: "alice" };
  });

  it("never sends the container id, and answers 500 without detail when an export is stopped", async () => {
    for (const file of ["plc.json", "io.csv", "tags.csv", "devices.csv"]) {
      const text = await (await get(file)).text();
      expect(text, file).not.toContain("container-secret-1");
      expect(text, file).not.toMatch(/docker/i);
    }
    await db.deviceInstance.update({ where: { id: plcId }, data: { role: "unix:///var/run/docker.sock" } });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const stopped = await get("plc.json");
    expect(stopped.status).toBe(500);
    const body = await stopped.text();
    expect(body).toBe('{"error":"The export could not be produced."}');
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]?.[0])).not.toContain("docker.sock");
    errors.mockRestore();
    await db.deviceInstance.update({ where: { id: plcId }, data: { role: null } });
  });
});
