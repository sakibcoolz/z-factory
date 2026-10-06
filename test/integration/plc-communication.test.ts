// @vitest-environment node
import { afterAll, beforeAll, expect, it } from "vitest";
import { loadCatalog } from "@/lib/catalog";
import { ingestCatalog } from "@/lib/catalog/ingest";
import { DomainError } from "@/lib/domain/errors";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { listEvents } from "@/lib/services/event-service";
import { createFactory } from "@/lib/services/factory-service";
import {
  createPlcLink,
  deletePlcLink,
  exportPlcLink,
  getPlcLink,
  listPlcLinks,
  listPlcLinkVersions,
  setPlcLinkEnabled,
  updatePlcLink,
} from "@/lib/services/plc-communication-service";
import { createPlc } from "@/lib/services/plc-config-service";
import { buildPlcExport } from "@/lib/services/plc-export-service";
import { placeDevice } from "@/lib/services/topology-service";
import { describeDb, openTestDb, resetDb } from "./harness";

/**
 * PLC-to-PLC communication links (TASK-701): two PLCs of one factory, their roles, the
 * server's name on the factory network, versions of the configuration and the export.
 * Needs TEST_DATABASE_URL.
 */
const alice = { ownerId: "alice" };
const bob = { ownerId: "bob" };

const fail = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error as DomainError,
  );

describeDb("PLC-to-PLC links", () => {
  let db: PrismaClient;
  let factoryId: string;
  let plcA: string;
  let plcB: string;
  let rtu: string;
  let driveId: string;
  let otherPlc: string;
  let linkId: string;

  beforeAll(async () => {
    db = openTestDb();
    await resetDb(db);
    await ingestCatalog(db, loadCatalog());
    const modelId = async (modelName: string) =>
      (await db.deviceModel.findFirstOrThrow({ where: { modelName }, select: { id: true } })).id;
    factoryId = (await createFactory(db, alice, { name: "Line", slug: "line", subnetCidr: "10.243.1.0/24" })).id;
    const cpu = await modelId("CPU 1214C DC/DC/DC");
    plcA = (await createPlc(db, alice, { factoryId, deviceModelId: cpu, name: "PLC-A" })).id;
    plcB = (await createPlc(db, alice, { factoryId, deviceModelId: cpu, name: "PLC_B.Machine-2" })).id;
    rtu = (
      await createPlc(db, alice, {
        factoryId,
        deviceModelId: await modelId("Generic RTU, IEC 61131-3"),
        name: "RTU-01",
      })
    ).id;
    driveId = (
      await placeDevice(db, alice, factoryId, {
        deviceModelId: await modelId("Generic VFD, Modbus TCP"),
        x: 0,
        y: 0,
        name: "VFD-01",
      })
    ).id;
    const other = await createFactory(db, alice, { name: "Elsewhere", slug: "elsewhere", subnetCidr: "10.243.2.0/24" });
    otherPlc = (await createPlc(db, alice, { factoryId: other.id, deviceModelId: cpu, name: "PLC-X" })).id;
  }, 120_000);

  afterAll(async () => {
    await db.$disconnect();
  });

  it("links two PLCs with explicit roles and the server's name on the factory network", async () => {
    const link = await createPlcLink(db, alice, {
      factoryId,
      sourcePlcId: plcA,
      targetPlcId: plcB,
      relationship: "SUPERVISES",
      pollIntervalMs: 500,
    });
    linkId = link.id;
    expect(link).toMatchObject({
      relationship: "SUPERVISES",
      protocol: "MODBUS_TCP",
      source: { plcId: plcA, name: "PLC-A", runtimeStatus: "STOPPED" },
      target: { plcId: plcB, name: "PLC_B.Machine-2" },
      client: "SOURCE",
      clientPlcId: plcA,
      serverPlcId: plcB,
      serverHost: "plc-b-machine-2",
      serverPort: 502,
      unitId: 1,
      pollIntervalMs: 500,
      enabled: true,
      configVersion: 1,
      mappingCount: 0,
    });
    expect(await listPlcLinks(db, alice, factoryId)).toHaveLength(1);
    expect(await getPlcLink(db, alice, link.id)).toMatchObject({ id: link.id });
    const events = await listEvents(db, alice, factoryId, { limit: 10 });
    expect(events[0]).toMatchObject({
      type: "PLC_LINK_CHANGED",
      deviceId: plcA,
      payload: { action: "created", version: 1 },
    });
  });

  it("refuses a PLC with itself, another factory's PLC, a device that is no controller, and a duplicate", async () => {
    const attempt = (input: Record<string, unknown>) =>
      fail(createPlcLink(db, alice, { factoryId, relationship: "COMMUNICATES_WITH", ...input }));
    expect((await attempt({ sourcePlcId: plcA, targetPlcId: plcA }))?.details.rule).toBe("plc-link-self");
    expect((await attempt({ sourcePlcId: plcA, targetPlcId: otherPlc }))?.details.rule).toBe("plc-link-factory");
    expect((await attempt({ sourcePlcId: otherPlc, targetPlcId: plcA }))?.details.rule).toBe("plc-link-factory");
    expect((await attempt({ sourcePlcId: plcA, targetPlcId: driveId }))?.code).toBe("NOT_FOUND");
    expect((await attempt({ sourcePlcId: plcA, targetPlcId: plcB }))?.code).toBe("CONFLICT");
    // The other direction, and another protocol-free relationship, are their own links.
    const back = await createPlcLink(db, alice, {
      factoryId,
      sourcePlcId: plcB,
      targetPlcId: plcA,
      relationship: "COMMUNICATES_WITH",
      client: "TARGET",
    });
    expect(back).toMatchObject({ clientPlcId: plcA, serverPlcId: plcB, serverHost: "plc-b-machine-2" });
    await deletePlcLink(db, alice, back.id);
    expect(
      (
        await fail(
          createPlcLink(db, alice, { factoryId, sourcePlcId: plcA, targetPlcId: plcB, relationship: "NEARBY" }),
        )
      )?.code,
    ).toBe("VALIDATION");
    expect(
      (
        await fail(
          createPlcLink(db, alice, {
            factoryId,
            sourcePlcId: plcA,
            targetPlcId: rtu,
            relationship: "SUPERVISES",
            pollIntervalMs: 10,
          }),
        )
      )?.code,
    ).toBe("VALIDATION");
  });

  it("links a PLC to a programmable RTU: the RTU serves Modbus TCP too", async () => {
    const link = await createPlcLink(db, alice, {
      factoryId,
      sourcePlcId: plcA,
      targetPlcId: rtu,
      relationship: "SUPERVISES",
    });
    expect(link.serverHost).toBe("rtu-01");
    await deletePlcLink(db, alice, link.id);
  });

  it("versions every change and keeps the server's name in step with the roles", async () => {
    const swapped = await updatePlcLink(db, alice, linkId, { client: "TARGET", unitId: 2 });
    expect(swapped).toMatchObject({
      client: "TARGET",
      clientPlcId: plcB,
      serverPlcId: plcA,
      serverHost: "plc-a",
      unitId: 2,
      configVersion: 2,
    });
    const disabled = await setPlcLinkEnabled(db, alice, linkId, false);
    expect(disabled).toMatchObject({ enabled: false, configVersion: 3 });
    const versions = await listPlcLinkVersions(db, alice, linkId);
    expect(versions.map((entry) => [entry.version, entry.snapshot.link.client, entry.snapshot.link.enabled])).toEqual([
      [3, "TARGET", false],
      [2, "TARGET", true],
      [1, "SOURCE", true],
    ]);
    expect(versions[0]?.createdBy).toBe("alice");
    const actions = (await listEvents(db, alice, factoryId, { limit: 20 }))
      .filter((event) => event.type === "PLC_LINK_CHANGED")
      .map((event) => event.payload.action);
    expect(actions.slice(0, 2)).toEqual(["disabled", "updated"]);
    expect((await fail(updatePlcLink(db, alice, linkId, { serverPort: 70_000 })))?.code).toBe("VALIDATION");
    await setPlcLinkEnabled(db, alice, linkId, true);
  });

  it("exports the link by names and lists it in both PLCs' engineering exports", async () => {
    const document = await exportPlcLink(db, alice, linkId);
    expect(document).toMatchObject({
      schema: "z-factory.plc-link",
      schemaVersion: 1,
      configVersion: 4,
      link: { sourcePlc: "PLC-A", targetPlc: "PLC_B.Machine-2", client: "TARGET", serverHost: "plc-a", unitId: 2 },
      mappings: [],
    });
    const a = await buildPlcExport(db, alice, plcA);
    expect(a.network.plcLinks).toEqual([
      {
        relationship: "SUPERVISES",
        role: "server",
        peer: "PLC_B.Machine-2",
        protocol: "Modbus TCP",
        serverHost: "plc-a",
        serverPort: 502,
        unitId: 2,
        pollIntervalMs: 500,
        enabled: true,
        configVersion: 4,
      },
    ]);
    const b = await buildPlcExport(db, alice, plcB);
    expect(b.network.plcLinks[0]).toMatchObject({ role: "client", peer: "PLC-A" });
  });

  it("knows nothing of another owner's links, and removes a link with its PLC", async () => {
    expect((await fail(getPlcLink(db, bob, linkId)))?.code).toBe("NOT_FOUND");
    expect((await fail(listPlcLinks(db, bob, factoryId)))?.code).toBe("NOT_FOUND");
    expect((await fail(updatePlcLink(db, bob, linkId, { enabled: false })))?.code).toBe("NOT_FOUND");
    // The link's history stays after the link is removed; the PLCs are untouched.
    await deletePlcLink(db, alice, linkId);
    expect(await listPlcLinks(db, alice, factoryId)).toEqual([]);
    expect(await db.configurationVersion.count({ where: { scopeType: "PLC_COMMUNICATION", scopeId: linkId } })).toBe(4);
    expect(await db.deviceInstance.count({ where: { id: { in: [plcA, plcB] } } })).toBe(2);
    const again = await createPlcLink(db, alice, {
      factoryId,
      sourcePlcId: plcA,
      targetPlcId: plcB,
      relationship: "COMMUNICATES_WITH",
    });
    await db.deviceInstance.delete({ where: { id: plcB } });
    expect((await fail(getPlcLink(db, alice, again.id)))?.code).toBe("NOT_FOUND");
  });
});
