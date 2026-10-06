// @vitest-environment node
import { afterAll, beforeAll, expect, it } from "vitest";
import { loadCatalog } from "@/lib/catalog";
import { ingestCatalog } from "@/lib/catalog/ingest";
import { withDomainErrors } from "@/lib/db/errors";
import { createDockerClient } from "@/lib/docker/client";
import { DEFAULT_LIMITS } from "@/lib/docker/policy";
import { RUNTIME_IMAGES } from "@/lib/docker/runtime-images";
import { DomainError } from "@/lib/domain/errors";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { GatewayEndpointRuntime } from "@/lib/runtimes/gateway-endpoint/runtime";
import { listEvents } from "@/lib/services/event-service";
import { createFactory } from "@/lib/services/factory-service";
import {
  addGateway,
  connectGateway,
  getGatewayMap,
  mapAllGatewayTags,
  mapGatewayTag,
} from "@/lib/services/gateway-service";
import { getLiveTags } from "@/lib/services/live-service";
import { createPlc } from "@/lib/services/plc-config-service";
import { buildPlcExport } from "@/lib/services/plc-export-service";
import { writePlcRegister } from "@/lib/services/plc-runtime-service";
import { createTag, getModbusMap, writeTag } from "@/lib/services/tag-service";
import { placeDevice } from "@/lib/services/topology-service";
import { TagMonitorRuntime } from "@/lib/runtimes/tag-monitor/monitor";
import { DeviceSimulatorRuntime } from "@/lib/runtimes/device-sim/runtime";
import { EventBus } from "@/lib/events/bus";
import { createGenericModel, describeDb, openTestDb, resetDb, wireAllSignals } from "./harness";

/**
 * Program-authoritative I/O (TASK-205, ADR-0015): the PLC scan cycle owns its local outputs,
 * the field or a simulation bridge owns its inputs, and only external command memory is
 * written from outside. Checked at every door: the tag service, the gateway, the raw
 * register write, the tag registry rules and the database. Needs TEST_DATABASE_URL.
 */
const alice = { ownerId: "alice" };

const fail = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error as DomainError,
  );

describeDb("program-authoritative I/O", () => {
  let db: PrismaClient;
  let factoryId: string;
  let plcId: string;
  let valveId: string;
  let sensorId: string;
  const runtime = () => ({
    db,
    docker: createDockerClient("unix:///nonexistent/docker.sock"),
    policy: {
      images: RUNTIME_IMAGES,
      portRange: { min: 15_880, max: 15_899 },
      bindAddresses: ["127.0.0.1"],
      limits: DEFAULT_LIMITS,
      labels: {},
    },
    runtimeSecret: "integration-test-runtime-secret-0123456789",
    bus: new EventBus(),
  });
  const tagByName = async (name: string) => db.tag.findFirstOrThrow({ where: { plcInstanceId: plcId, name } });

  beforeAll(async () => {
    db = openTestDb();
    await resetDb(db);
    await ingestCatalog(db, loadCatalog());
    factoryId = (await createFactory(db, alice, { name: "Authority", slug: "authority", subnetCidr: "10.242.1.0/24" }))
      .id;
    const modelId = async (modelName: string) =>
      (await db.deviceModel.findFirstOrThrow({ where: { modelName }, select: { id: true } })).id;
    plcId = (
      await createPlc(db, alice, { factoryId, deviceModelId: await modelId("CPU 1214C DC/DC/DC"), name: "PLC-01" })
    ).id;
    valveId = (
      await placeDevice(db, alice, factoryId, {
        deviceModelId: await modelId("Generic on/off valve, 24 V DC"),
        x: 0,
        y: 0,
        name: "XV-101",
      })
    ).id;
    sensorId = (
      await placeDevice(db, alice, factoryId, {
        deviceModelId: await modelId("Generic pressure transmitter, 4–20 mA"),
        x: 0,
        y: 0,
        name: "PT-101",
      })
    ).id;
    // The valve's terminals get I/O points: its command on a DO (%QX), its limit switches on DIs (%MX).
    expect(await wireAllSignals(db, alice, factoryId, plcId, valveId)).toBe(3);
    // The transmitter's value reaches the program through memory the simulation bridge fills.
    await createTag(db, alice, plcId, {
      name: "PT_101_Pressure",
      dataType: "FLOAT32",
      role: "PROCESS_VALUE",
      logicalAddress: "%MD0",
      unit: "bar",
      sourceDeviceInstanceId: sensorId,
      sourceSignal: "value",
    });
    await createTag(db, alice, plcId, {
      name: "Start_Cmd",
      dataType: "BOOL",
      role: "COMMAND",
      logicalAddress: "%QX100.0",
    });
    await createTag(db, alice, plcId, {
      name: "Speed_SP",
      dataType: "INT16",
      role: "SETPOINT",
      logicalAddress: "%QW100",
      scale: 0.1,
    });
    await createTag(db, alice, plcId, {
      name: "High_Pressure_Trip",
      dataType: "BOOL",
      role: "ALARM",
      logicalAddress: "%QX100.1",
    });
    await createTag(db, alice, plcId, {
      name: "Scan_Counter",
      dataType: "INT16",
      role: "STATUS",
      logicalAddress: "%MW200",
    });
  }, 120_000);

  afterAll(async () => {
    await db.$disconnect();
  });

  it("says who drives every tag, in the Modbus map, the live tags and the export", async () => {
    const map = await getModbusMap(db, alice, plcId);
    const authority = Object.fromEntries(map.rows.map((row) => [row.name, [row.logicalAddress, row.authority]]));
    expect(authority).toMatchObject({
      XV_101_Y1: ["%QX0.0", "PROGRAM_OUTPUT"],
      XV_101_ZSO: [expect.stringMatching(/^%MX/), "PROGRAM_INPUT"],
      XV_101_ZSC: [expect.stringMatching(/^%MX/), "PROGRAM_INPUT"],
      PT_101_Pressure: ["%MD0", "SIMULATION_FEEDBACK"],
      Start_Cmd: ["%QX100.0", "EXTERNAL_COMMAND"],
      Speed_SP: ["%QW100", "EXTERNAL_COMMAND"],
      High_Pressure_Trip: ["%QX100.1", "PROGRAM_OUTPUT"],
      Scan_Counter: ["%MW200", "PROGRAM_INTERNAL"],
    });
    const live = await getLiveTags(
      { db, bus: new EventBus(), monitor: new TagMonitorRuntime(), simulator: new DeviceSimulatorRuntime() },
      alice,
      factoryId,
    );
    expect(
      live.tags
        .filter((tag) => tag.writable)
        .map((tag) => tag.name)
        .sort(),
    ).toEqual(["Speed_SP", "Start_Cmd"]);
    expect(live.tags.find((tag) => tag.name === "XV_101_Y1")).toMatchObject({
      writable: false,
      authority: "PROGRAM_OUTPUT",
    });
    const exported = await buildPlcExport(db, alice, plcId);
    expect(exported.tags.find((tag) => tag.name === "XV_101_Y1")?.authority).toBe("PROGRAM_OUTPUT");
    expect(exported.tags.find((tag) => tag.name === "Start_Cmd")?.authority).toBe("EXTERNAL_COMMAND");
  });

  it("refuses a normal control write to a local output, from the UI and from a gateway, and records it", async () => {
    for (const source of ["UI", "GATEWAY"] as const) {
      const error = await fail(writeTag(runtime(), alice, plcId, "XV_101_Y1", true, source));
      expect(error?.details.rule, source).toBe("tag-read-only");
    }
    expect((await fail(writeTag(runtime(), alice, plcId, "High_Pressure_Trip", false)))?.details.rule).toBe(
      "tag-read-only",
    );
    expect((await fail(writeTag(runtime(), alice, plcId, "PT_101_Pressure", 3)))?.details.rule).toBe("tag-read-only");
    const rejected = (await listEvents(db, alice, factoryId, { limit: 50 })).filter(
      (event) => event.type === "COMMAND_REJECTED",
    );
    expect(rejected.map((event) => event.payload.tag).sort()).toEqual([
      "High_Pressure_Trip",
      "PT_101_Pressure",
      "XV_101_Y1",
      "XV_101_Y1",
    ]);
    // A command tag passes the authority rule; only the missing runtime stops it here.
    expect((await fail(writeTag(runtime(), alice, plcId, "Start_Cmd", true)))?.details.rule).not.toBe("tag-read-only");
  });

  it("refuses a raw register write anywhere but external command memory", async () => {
    const y1 = await tagByName("XV_101_Y1");
    const output = await fail(
      writePlcRegister(runtime(), alice, plcId, { area: "COIL", address: y1.protocolAddress ?? 0, value: true }),
    );
    expect(output).toMatchObject({
      code: "INVARIANT",
      details: { rule: "program-authority", tag: "XV_101_Y1", authority: "PROGRAM_OUTPUT" },
    });
    const zso = await tagByName("XV_101_ZSO");
    expect(
      (
        await fail(
          writePlcRegister(runtime(), alice, plcId, { area: "COIL", address: zso.protocolAddress ?? 0, value: true }),
        )
      )?.details,
    ).toMatchObject({
      rule: "program-authority",
      authority: "PROGRAM_INPUT",
    });
    expect(
      (
        await fail(
          writePlcRegister(runtime(), alice, plcId, { area: "HOLDING_REGISTER", address: 1024 + 200, value: 1 }),
        )
      )?.details,
    ).toMatchObject({
      rule: "program-authority",
      authority: "PROGRAM_INTERNAL",
    });
    // No tag at all: nobody's address.
    expect(
      (await fail(writePlcRegister(runtime(), alice, plcId, { area: "COIL", address: 900, value: true })))?.details
        .rule,
    ).toBe("program-authority");
    // External command memory passes the rule; the stopped runtime is what refuses here.
    expect(
      (await fail(writePlcRegister(runtime(), alice, plcId, { area: "COIL", address: 800, value: true })))?.details
        .rule,
    ).toBe("runtime-required");
  });

  it("keeps command memory off the I/O points, in the service and in the database", async () => {
    const y1 = await tagByName("XV_101_Y1");
    // A command tag at a channel's address: refused before anything is stored.
    expect(
      (
        await fail(
          createTag(db, alice, plcId, {
            name: "Force_Y1",
            dataType: "BOOL",
            role: "COMMAND",
            logicalAddress: y1.logicalAddress ?? "",
          }),
        )
      )?.details.rule,
    ).toBe("io-point-address");
    // The row of a channel tag cannot be made writable behind the service's back either.
    const forced = await fail(
      withDomainErrors(() =>
        db.tag.update({ where: { id: y1.id }, data: { accessMode: "READ_WRITE", role: "COMMAND" } }),
      ),
    );
    expect(forced).toMatchObject({ code: "INVARIANT" });
    expect(forced?.message).toContain("never externally writable");
    expect((await tagByName("XV_101_Y1")).accessMode).toBe("READ_ONLY");
  });

  it("lets a gateway read a local output but never write it; map-all follows the same rule", async () => {
    await createGenericModel(db, "GATEWAY", "Test gateway");
    const deps = { ...runtime(), endpoints: new GatewayEndpointRuntime() };
    const gateway = await addGateway(deps, alice, factoryId);
    const { connectionId } = await connectGateway(deps, alice, gateway.id, { plcId, host: "127.0.0.1", port: 15_890 });
    const y1 = await tagByName("XV_101_Y1");
    expect(
      (await fail(mapGatewayTag(deps, alice, connectionId, { tagId: y1.id, access: "READ_WRITE" })))?.details.rule,
    ).toBe("gateway-write-command-only");
    await mapGatewayTag(deps, alice, connectionId, { tagId: y1.id, access: "READ" });
    await mapAllGatewayTags(deps, alice, connectionId);
    const map = await getGatewayMap(deps, alice, connectionId);
    const writable = map.registers
      .filter((register) => register.access === "READ_WRITE")
      .map((register) => register.tag)
      .sort();
    expect(writable).toEqual(["Speed_SP", "Start_Cmd"]);
    expect(map.registers.find((register) => register.tag === "XV_101_Y1")?.access).toBe("READ");
    await deps.endpoints.stopAll();
  });
});
