// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { loadCatalog } from "@/lib/catalog";
import { ingestCatalog } from "@/lib/catalog/ingest";
import { DEMO_FACTORY_NAME } from "@/lib/demo/pump-station";
import { createDockerClient } from "@/lib/docker/client";
import { DEFAULT_LIMITS } from "@/lib/docker/policy";
import { RUNTIME_IMAGES } from "@/lib/docker/runtime-images";
import { DomainError } from "@/lib/domain/errors";
import { EventBus } from "@/lib/events/bus";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { GatewayEndpointRuntime } from "@/lib/runtimes/gateway-endpoint/runtime";
import { createDemoFactory } from "@/lib/services/demo-service";
import { type GatewayDeps, getGatewayMap } from "@/lib/services/gateway-service";
import { getFactoryDeviceTree, getPlcConfiguration } from "@/lib/services/plc-config-service";
import { buildPlcExport } from "@/lib/services/plc-export-service";
import { checkProgram, listProgramVersions } from "@/lib/services/plc-runtime-service";
import { planSimulation } from "@/lib/services/simulation-service";
import { getTopology } from "@/lib/services/topology-service";
import { describeDb, openTestDb, resetDb } from "./harness";

/**
 * The pump station demo as a stored factory, against PostgreSQL: what the demo service
 * builds, that its program compiles, and that the simulator, the gateway and the export
 * can work with it. Running it is covered by the end-to-end test with a real runtime.
 */
const alice = { ownerId: "alice" };

describeDb("the pump station demo factory", () => {
  let db: PrismaClient;
  let deps: GatewayDeps;

  beforeAll(async () => {
    db = openTestDb();
    await resetDb(db);
    await ingestCatalog(db, loadCatalog());
  });
  beforeEach(async () => {
    await deps?.endpoints.stopAll();
    await db.factory.deleteMany();
    deps = {
      db,
      bus: new EventBus(),
      docker: createDockerClient("unix:///nonexistent/docker.sock"),
      policy: {
        images: RUNTIME_IMAGES,
        portRange: { min: 15_950, max: 15_979 },
        bindAddresses: ["127.0.0.1"],
        limits: DEFAULT_LIMITS,
        labels: {},
      },
      runtimeSecret: "integration-test-runtime-secret-0123456789",
      endpoints: new GatewayEndpointRuntime(),
    };
  });
  afterAll(async () => {
    await deps?.endpoints.stopAll();
    await db.$disconnect();
  });

  it("builds the pump station from catalog models with unique names, real wiring and a gateway", async () => {
    const demo = await createDemoFactory(deps, alice);
    expect(demo).toMatchObject({ name: DEMO_FACTORY_NAME, endpoint: { host: "127.0.0.1", port: 15_979, unitId: 1 } });

    const topology = await getTopology(db, alice, demo.factoryId);
    expect(topology.nodes.map((node) => node.name).sort()).toEqual([
      "GATEWAY-01",
      "MOTOR-01",
      "PLC-01",
      "PT-101",
      "PUMP-01",
      "VFD-01",
    ]);
    // Every device stands where the demo puts it, so the designer and the 3D view show the loop.
    expect(topology.nodes.every((node) => node.placed)).toBe(true);
    const name = (id: string) => topology.nodes.find((node) => node.id === id)?.name;
    expect(
      topology.edges.map((edge) => `${name(edge.sourceId)} ${edge.relationship} ${name(edge.targetId)}`).sort(),
    ).toEqual([
      "MOTOR-01 MECHANICALLY_DRIVES PUMP-01",
      "PLC-01 COMMUNICATES_WITH GATEWAY-01",
      "PLC-01 WIRED_TO PT-101",
      "PLC-01 WIRED_TO VFD-01",
      "PT-101 MEASURES PUMP-01",
      "VFD-01 DRIVES MOTOR-01",
      "VFD-01 WIRED_TO MOTOR-01",
    ]);
    // One wiring edge per device, with every wire on it: seven for the drive, one for the transmitter.
    const wires = (deviceName: string) =>
      topology.edges.find((edge) => edge.relationship === "WIRED_TO" && name(edge.targetId) === deviceName)?.wires;
    expect(wires("VFD-01")).toHaveLength(7);
    // The motor cable: three phases, three conductors, the DRIVES relationship beside them.
    const cable = topology.edges.find((edge) => edge.relationship === "WIRED_TO" && name(edge.targetId) === "MOTOR-01");
    expect(cable?.wires.map((wire) => [wire.kind, wire.from.name, wire.to.name])).toEqual([
      ["POWER", "VFD-01 / U", "MOTOR-01 / U"],
      ["POWER", "VFD-01 / V", "MOTOR-01 / V"],
      ["POWER", "VFD-01 / W", "MOTOR-01 / W"],
    ]);
    expect(wires("PT-101")?.map((wire) => [wire.from.name, wire.tagName])).toEqual([["PT-101 / OUT", "PT_101_OUT"]]);

    // The drive and the transmitter are wired to channels of the installed modules.
    const configuration = await getPlcConfiguration(db, alice, demo.plcId);
    expect(configuration.plc.architectureType).toBe("MODULAR");
    const wired = await db.tag.findMany({
      where: { plcInstanceId: demo.plcId, plcIoPointId: { not: null } },
      include: { ioPoint: { include: { moduleChannel: true } }, sourceDevice: true },
    });
    expect(
      wired.map((tag) => `${tag.ioPoint?.moduleChannel?.ioType} ${tag.name} ${tag.sourceDevice?.name}`).sort(),
    ).toEqual([
      "AI PT_101_OUT PT-101",
      "AI VFD_01_FREQ VFD-01",
      "AO VFD_01_REF VFD-01",
      "DI VFD_01_FAULT VFD-01",
      "DI VFD_01_RUNNING VFD-01",
      "DO VFD_01_RESET VFD-01",
      "DO VFD_01_REV VFD-01",
      "DO VFD_01_RUN VFD-01",
    ]);

    const tags = await db.tag.findMany({ where: { plcInstanceId: demo.plcId }, orderBy: { name: "asc" } });
    expect(tags.map((tag) => [tag.name, tag.role, tag.accessMode])).toEqual([
      ["High_Pressure_Trip", "ALARM", "READ_ONLY"],
      ["PT_101_OUT", "PROCESS_VALUE", "READ_ONLY"],
      ["Pump_Reset", "COMMAND", "READ_WRITE"],
      ["Pump_Speed_SP", "SETPOINT", "READ_WRITE"],
      ["Pump_Start", "COMMAND", "READ_WRITE"],
      ["VFD_01_FAULT", "STATUS", "READ_ONLY"],
      ["VFD_01_FREQ", "FEEDBACK", "READ_ONLY"],
      ["VFD_01_REF", "STATUS", "READ_ONLY"],
      ["VFD_01_RESET", "STATUS", "READ_ONLY"],
      ["VFD_01_REV", "STATUS", "READ_ONLY"],
      ["VFD_01_RUN", "STATUS", "READ_ONLY"],
      ["VFD_01_RUNNING", "STATUS", "READ_ONLY"],
    ]);
  });

  it("reads as a hierarchy: the PLC with what is connected to it, each device once", async () => {
    const demo = await createDemoFactory(deps, alice);
    const loose = await db.deviceInstance.findFirstOrThrow({ where: { name: "PT-101" } });
    await db.deviceInstance.create({
      data: {
        factoryId: demo.factoryId,
        deviceModelId: loose.deviceModelId,
        name: "PT-900",
        runtimeType: loose.runtimeType,
        simulatorType: loose.simulatorType,
      },
    });

    type Node = Awaited<ReturnType<typeof getFactoryDeviceTree>>[number];
    const text = (nodes: Node[]): string =>
      nodes.map((node) => node.device.name + (node.children.length ? `(${text(node.children)})` : "")).join(", ");

    const tree = await getFactoryDeviceTree(db, alice, demo.factoryId);
    // The pump is found in its drive chain, not under the transmitter that measures it.
    expect(text(tree)).toBe("PLC-01(GATEWAY-01, PT-101, VFD-01(MOTOR-01(PUMP-01))), PT-900");
    expect(tree[0]?.device).toMatchObject({ name: "PLC-01", architectureType: "MODULAR", categoryCode: "PLC" });
    await expect(getFactoryDeviceTree(db, { ownerId: "bob" }, demo.factoryId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("gives the PLC a program that compiles and declares every tag where the wiring put it", async () => {
    const demo = await createDemoFactory(deps, alice);
    const [version] = await listProgramVersions(db, alice, demo.plcId);
    expect(version).toMatchObject({ version: 1, status: "DRAFT" });
    const source = (await db.programVersion.findFirstOrThrow({ where: { plcInstanceId: demo.plcId } })).sourceText;
    const tags = await db.tag.findMany({ where: { plcInstanceId: demo.plcId } });
    for (const tag of tags)
      expect(source).toMatch(new RegExp(`${tag.name}\\s+AT ${tag.logicalAddress?.replace(".", "\\.")} :`));
    expect(source).toContain("IF PT_101_OUT > 30 THEN");
    expect(source).toContain("VFD_01_RUN := Pump_Start AND NOT VFD_01_FAULT AND NOT High_Pressure_Trip;");
    expect(source).toContain("ELSIF Pump_Speed_SP > 5000 THEN");

    const check = await checkProgram(db, alice, demo.plcId, { sourceText: source });
    expect(check.errors).toEqual([]);
    expect(check.success).toBe(true);
  }, 60_000);

  it("is ready for the simulator, the gateway and the engineering export", async () => {
    const demo = await createDemoFactory(deps, alice);

    // Every simulated device has its signals wired; nothing is skipped for a missing link.
    const plan = await planSimulation(db, alice, demo.factoryId);
    expect(plan.devices.map((device) => `${device.name} ${device.type}`).sort()).toEqual([
      "MOTOR-01 MOTOR",
      "PT-101 SENSOR",
      "PUMP-01 PUMP",
      "VFD-01 VFD",
    ]);
    expect(plan.skipped).toEqual([]);

    // The gateway is given every tag; it may write the two commands and the setpoint.
    const map = await getGatewayMap(deps, alice, demo.gatewayConnectionId);
    expect(map.endpoint).toEqual({ protocol: "MODBUS_TCP", ...demo.endpoint });
    expect(map.registers).toHaveLength(12);
    expect(
      map.registers
        .filter((register) => register.access === "READ_WRITE")
        .map((register) => register.tag)
        .sort(),
    ).toEqual(["Pump_Reset", "Pump_Speed_SP", "Pump_Start"]);
    expect(deps.endpoints.status(demo.gatewayConnectionId).listening).toBe(true);
    // The gateway device shows that its endpoint is open, in the designer and the 3D view too.
    const gateway = await db.deviceInstance.findUniqueOrThrow({ where: { id: demo.deviceIds.gateway } });
    expect(gateway.runtimeStatus).toBe("RUNNING");

    const exported = await buildPlcExport(db, alice, demo.plcId, { includeRuntime: false });
    expect(JSON.stringify(exported)).toContain("VFD-01");
    expect(JSON.stringify(exported)).toContain("Pump_Speed_SP");
    expect(JSON.stringify(exported)).toContain("PT-101");
  });

  it("can be built again beside itself, and tells when the catalog is not loaded", async () => {
    const first = await createDemoFactory(deps, alice);
    const second = await createDemoFactory(deps, alice);
    expect(second.name).toBe(`${DEMO_FACTORY_NAME} 2`);
    expect(second.factoryId).not.toBe(first.factoryId);
    // Each has its own endpoint on its own port.
    expect(second.endpoint.port).toBe(first.endpoint.port - 1);

    await db.factory.deleteMany();
    await deps.endpoints.stopAll();
    await db.deviceModel.deleteMany({ where: { modelName: "Generic centrifugal pump" } });
    const error = await createDemoFactory(deps, alice).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).details.rule).toBe("demo-catalog-required");
    await ingestCatalog(db, loadCatalog());
  });
});
