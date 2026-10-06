// @vitest-environment node
import { afterAll, beforeAll, expect, it } from "vitest";
import { loadCatalog } from "@/lib/catalog";
import { ingestCatalog } from "@/lib/catalog/ingest";
import { DomainError } from "@/lib/domain/errors";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { createFactory } from "@/lib/services/factory-service";
import {
  addPlcLinkMapping,
  createPlcLink,
  exportPlcLink,
  getPlcLink,
  listPlcLinkMappings,
  listPlcLinkVersions,
  removePlcLinkMapping,
  updatePlcLinkMapping,
} from "@/lib/services/plc-communication-service";
import { createPlc } from "@/lib/services/plc-config-service";
import { createTag, deleteTag, getModbusMap } from "@/lib/services/tag-service";
import { describeDb, openTestDb, resetDb } from "./harness";

/**
 * Mappings over a PLC link (TASK-702): which tag of the client a server value fills, which
 * computed value of the client reaches a command of the server, and nothing else.
 * Needs TEST_DATABASE_URL.
 */
const alice = { ownerId: "alice" };
const bob = { ownerId: "bob" };

const fail = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error as DomainError,
  );

describeDb("PLC link mappings", () => {
  let db: PrismaClient;
  let factoryId: string;
  let plcA: string;
  let plcB: string;
  let plcC: string;
  let linkId: string;
  const tags = new Map<string, string>();
  const id = (plc: string, name: string) => {
    const found = tags.get(`${plc}/${name}`);
    if (!found) throw new Error(`no tag ${plc}/${name}`);
    return found;
  };
  const map = (
    operation: "READ" | "WRITE",
    local: string,
    remote: string,
    extra: Record<string, unknown> = {},
    link = linkId,
  ) =>
    addPlcLinkMapping(db, alice, link, {
      operation,
      localTagId: id("A", local),
      remoteTagId: id("B", remote),
      ...extra,
    });

  beforeAll(async () => {
    db = openTestDb();
    await resetDb(db);
    await ingestCatalog(db, loadCatalog());
    const cpu = (
      await db.deviceModel.findFirstOrThrow({ where: { modelName: "CPU 1214C DC/DC/DC" }, select: { id: true } })
    ).id;
    factoryId = (await createFactory(db, alice, { name: "Line", slug: "line", subnetCidr: "10.244.1.0/24" })).id;
    plcA = (await createPlc(db, alice, { factoryId, deviceModelId: cpu, name: "PLC-A" })).id;
    plcB = (await createPlc(db, alice, { factoryId, deviceModelId: cpu, name: "PLC-B" })).id;
    plcC = (await createPlc(db, alice, { factoryId, deviceModelId: cpu, name: "PLC-C" })).id;
    const define = async (plc: string, label: string, list: Array<Record<string, unknown>>) => {
      for (const tag of list) await createTag(db, alice, plc, tag);
      for (const tag of await db.tag.findMany({ where: { plcInstanceId: plc }, select: { id: true, name: true } })) {
        tags.set(`${label}/${tag.name}`, tag.id);
      }
    };
    // PLC-A, the supervisor: what it computes for B, where B's values land, and a gateway command.
    await define(plcA, "A", [
      { name: "Start_B", dataType: "BOOL", role: "STATUS", logicalAddress: "%QX101.0" },
      { name: "Speed_B", dataType: "INT16", role: "STATUS", logicalAddress: "%MW20", scale: 0.1, unit: "%" },
      { name: "B_Temp", dataType: "FLOAT32", role: "PROCESS_VALUE", logicalAddress: "%MD10", unit: "°C" },
      { name: "B_Running", dataType: "BOOL", role: "STATUS", logicalAddress: "%MX10.0" },
      { name: "B_Pressure", dataType: "INT16", role: "PROCESS_VALUE", logicalAddress: "%MW30", unit: "bar" },
      { name: "Gw_Start", dataType: "BOOL", role: "COMMAND", logicalAddress: "%QX102.0" },
      { name: "A_Output", dataType: "BOOL", role: "STATUS", logicalAddress: "%QX103.0" },
    ]);
    // PLC-B, the machine: its commands, its program's outputs and its process values.
    await define(plcB, "B", [
      { name: "Start_Cmd", dataType: "BOOL", role: "COMMAND", logicalAddress: "%QX100.0" },
      { name: "Speed_SP", dataType: "INT16", role: "SETPOINT", logicalAddress: "%QW100", scale: 0.01, unit: "%" },
      {
        name: "Temperature",
        dataType: "INT16",
        role: "PROCESS_VALUE",
        logicalAddress: "%MW200",
        scale: 0.1,
        unit: "°C",
      },
      { name: "Running", dataType: "BOOL", role: "STATUS", logicalAddress: "%QX104.0" },
      { name: "Motor_Out", dataType: "BOOL", role: "STATUS", logicalAddress: "%QX104.1" },
    ]);
    linkId = (
      await createPlcLink(db, alice, { factoryId, sourcePlcId: plcA, targetPlcId: plcB, relationship: "SUPERVISES" })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await db.$disconnect();
  });

  it("reads server values into the client and writes computed values to the server's commands", async () => {
    const read = await map("READ", "B_Temp", "Temperature");
    expect(read).toMatchObject({
      operation: "READ",
      localTag: { name: "B_Temp", logicalAddress: "%MD10", dataType: "FLOAT32", unit: "°C" },
      remoteTag: { name: "Temperature", area: "HOLDING_REGISTER", address: 1224, dataType: "INT16", scale: 0.1 },
      updateIntervalMs: null,
      effectiveIntervalMs: 1000,
      enabled: true,
      quality: null,
    });
    await map("READ", "B_Running", "Running");
    await map("WRITE", "Start_B", "Start_Cmd");
    await map("WRITE", "Speed_B", "Speed_SP", { updateIntervalMs: 250 });
    const listed = await listPlcLinkMappings(db, alice, linkId);
    expect(
      listed.map((mapping) => [
        mapping.operation,
        mapping.localTag.name,
        mapping.remoteTag.name,
        mapping.effectiveIntervalMs,
      ]),
    ).toEqual([
      ["READ", "B_Temp", "Temperature", 1000],
      ["READ", "B_Running", "Running", 1000],
      ["WRITE", "Start_B", "Start_Cmd", 1000],
      ["WRITE", "Speed_B", "Speed_SP", 250],
    ]);
    expect((await getPlcLink(db, alice, linkId)).mappingCount).toBe(4);
  });

  it("shows the tags a link fills as PLC link input in the client's Modbus map", async () => {
    const rows = Object.fromEntries((await getModbusMap(db, alice, plcA)).rows.map((row) => [row.name, row.authority]));
    expect(rows).toMatchObject({
      B_Temp: "LINK_INPUT",
      B_Running: "LINK_INPUT",
      Start_B: "PROGRAM_OUTPUT",
      Gw_Start: "EXTERNAL_COMMAND",
    });
  });

  it("refuses wrong ends, wrong types, wrong units and anything ADR-0015 forbids", async () => {
    const rule = async (promise: Promise<unknown>) => (await fail(promise))?.details.rule;
    // A server output or feedback is never written; a gateway command is never forwarded.
    expect(await rule(map("WRITE", "A_Output", "Motor_Out"))).toBe("plc-link-remote-write");
    expect(await rule(map("WRITE", "A_Output", "Running"))).toBe("plc-link-remote-write");
    expect(await rule(map("WRITE", "Gw_Start", "Start_Cmd"))).toBe("plc-link-local-write");
    // A READ fills only free %M memory of the client.
    expect(await rule(map("READ", "A_Output", "Running"))).toBe("plc-link-local-read");
    expect(await rule(map("READ", "Gw_Start", "Running"))).toBe("plc-link-local-read");
    expect(await rule(map("READ", "B_Running", "Temperature"))).toBe("plc-link-data-type");
    expect(await rule(map("READ", "B_Pressure", "Temperature"))).toBe("plc-link-unit");
    // The ends are fixed by the link's roles.
    expect(
      await rule(
        addPlcLinkMapping(db, alice, linkId, {
          operation: "READ",
          localTagId: id("B", "Temperature"),
          remoteTagId: id("A", "B_Temp"),
        }),
      ),
    ).toBe("plc-link-tag-plc");
    expect(
      (
        await fail(
          addPlcLinkMapping(db, alice, linkId, {
            operation: "PUSH",
            localTagId: id("A", "B_Temp"),
            remoteTagId: id("B", "Temperature"),
          }),
        )
      )?.code,
    ).toBe("VALIDATION");
    expect((await fail(map("READ", "B_Pressure", "Temperature", { updateIntervalMs: 10 })))?.code).toBe("VALIDATION");
  });

  it("keeps one writer per value across links", async () => {
    // B_Temp is already filled by the first READ; Start_Cmd already written by the first WRITE.
    expect((await fail(map("READ", "B_Temp", "Temperature")))?.code).toBe("OCCUPIED_ENDPOINT");
    expect((await fail(map("WRITE", "A_Output", "Start_Cmd")))?.details.rule).toBe("plc-link-one-writer");
    // A second client of B cannot write the same command either.
    const second = (
      await createPlcLink(db, alice, { factoryId, sourcePlcId: plcC, targetPlcId: plcB, relationship: "SUPERVISES" })
    ).id;
    await createTag(db, alice, plcC, { name: "C_Start", dataType: "BOOL", role: "STATUS", logicalAddress: "%QX101.0" });
    const cStart = (
      await db.tag.findFirstOrThrow({ where: { plcInstanceId: plcC, name: "C_Start" }, select: { id: true } })
    ).id;
    const taken = await fail(
      addPlcLinkMapping(db, alice, second, {
        operation: "WRITE",
        localTagId: cStart,
        remoteTagId: id("B", "Start_Cmd"),
      }),
    );
    expect(taken).toMatchObject({ code: "OCCUPIED_ENDPOINT", details: { rule: "plc-link-one-writer" } });
    // Two clients racing for one command: exactly one wins, by the database's own index.
    await createTag(db, alice, plcC, {
      name: "C_Speed",
      dataType: "INT16",
      role: "STATUS",
      logicalAddress: "%MW40",
      unit: "%",
    });
    await createTag(db, alice, plcB, {
      name: "Mode_Cmd",
      dataType: "INT16",
      role: "COMMAND",
      logicalAddress: "%QW101",
    });
    tags.set("B/Mode_Cmd", (await db.tag.findFirstOrThrow({ where: { plcInstanceId: plcB, name: "Mode_Cmd" } })).id);
    const cSpeed = (await db.tag.findFirstOrThrow({ where: { plcInstanceId: plcC, name: "C_Speed" } })).id;
    await createTag(db, alice, plcA, { name: "Mode_B", dataType: "INT16", role: "STATUS", logicalAddress: "%MW50" });
    tags.set("A/Mode_B", (await db.tag.findFirstOrThrow({ where: { plcInstanceId: plcA, name: "Mode_B" } })).id);
    const results = await Promise.allSettled([
      map("WRITE", "Mode_B", "Mode_Cmd"),
      addPlcLinkMapping(db, alice, second, {
        operation: "WRITE",
        localTagId: cSpeed,
        remoteTagId: id("B", "Mode_Cmd"),
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      await db.plcCommunicationMapping.count({ where: { remoteTagId: id("B", "Mode_Cmd"), operation: "WRITE" } }),
    ).toBe(1);
    await db.plcCommunicationMapping.deleteMany({ where: { remoteTagId: id("B", "Mode_Cmd") } });
  });

  it("versions every mapping change with the mappings by name, and exports them", async () => {
    const before = (await getPlcLink(db, alice, linkId)).configVersion;
    const [, , , speed] = await listPlcLinkMappings(db, alice, linkId);
    const changed = await updatePlcLinkMapping(db, alice, linkId, speed!.id, {
      enabled: false,
      updateIntervalMs: null,
    });
    expect(changed).toMatchObject({ enabled: false, updateIntervalMs: null, effectiveIntervalMs: 1000 });
    const after = await getPlcLink(db, alice, linkId);
    expect(after.configVersion).toBe(before + 1);
    const [latest] = await listPlcLinkVersions(db, alice, linkId);
    expect(latest?.version).toBe(after.configVersion);
    expect(
      latest?.snapshot.mappings.map((mapping) => [
        mapping.operation,
        mapping.localTag,
        mapping.remoteTag,
        mapping.enabled,
      ]),
    ).toEqual([
      ["READ", "B_Temp", "Temperature", true],
      ["READ", "B_Running", "Running", true],
      ["WRITE", "Start_B", "Start_Cmd", true],
      ["WRITE", "Speed_B", "Speed_SP", false],
    ]);
    const document = await exportPlcLink(db, alice, linkId);
    expect(document.mappings[0]).toEqual({
      operation: "READ",
      localTag: "B_Temp",
      remoteTag: "Temperature",
      remoteArea: "HOLDING_REGISTER",
      remoteAddress: 1224,
      dataType: "INT16",
      updateIntervalMs: null,
      enabled: true,
    });
  });

  it("removes a mapping, frees its value, and goes with either tag", async () => {
    const [temperature] = await listPlcLinkMappings(db, alice, linkId);
    await removePlcLinkMapping(db, alice, linkId, temperature!.id);
    expect((await listPlcLinkMappings(db, alice, linkId)).map((mapping) => mapping.localTag.name)).not.toContain(
      "B_Temp",
    );
    await map("READ", "B_Temp", "Temperature");
    // Deleting the server's tag removes the mapping that reads it; the client's tag stays.
    await deleteTag(db, alice, plcB, "Running");
    expect((await listPlcLinkMappings(db, alice, linkId)).map((mapping) => mapping.remoteTag.name)).not.toContain(
      "Running",
    );
    expect(await db.tag.count({ where: { id: id("A", "B_Running") } })).toBe(1);
    expect((await fail(removePlcLinkMapping(db, alice, linkId, temperature!.id)))?.code).toBe("NOT_FOUND");
    expect((await fail(listPlcLinkMappings(db, bob, linkId)))?.code).toBe("NOT_FOUND");
  });
});
