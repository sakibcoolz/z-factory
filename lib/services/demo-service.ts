import "server-only";
import type { Actor } from "@/lib/auth/actor";
import {
  DEMO_DEVICES,
  DEMO_FACTORY_NAME,
  DEMO_MODELS,
  DEMO_OPERATOR_TAGS,
  DEMO_POSITIONS,
  DEMO_PROFILES,
  demoProgram,
} from "@/lib/demo/pump-station";
import { listHostNetworks } from "@/lib/docker/networks";
import { DomainError } from "@/lib/domain/errors";
import { iecTypeFor, isIecIdentifier } from "@/lib/plc/program-template";
import { createFactory, listFactories, suggestFactorySubnet } from "./factory-service";
import { addGateway, connectGateway, type GatewayDeps, getGatewaysView, mapAllGatewayTags } from "./gateway-service";
import { addPeripheral, createPlc, installModule } from "./plc-config-service";
import { createProgramVersion } from "./plc-runtime-service";
import { createTag } from "./tag-service";
import { connectWire, getPairWiring } from "./wiring-service";
import { linkDevices, moveDevices, placeDevice } from "./topology-service";

/**
 * Builds the pump station of the MVP demo as an ordinary stored factory (TASK-502). It
 * uses the services the screens use and nothing else, so what it creates is what a person
 * could have created by hand: catalog devices with unique names, real wiring to PLC
 * channels, generated tags, a program version, and a gateway with its mapped tags.
 *
 * It starts nothing. Starting is the factory's lifecycle (`factory-runtime-service`).
 */

export type DemoFactory = {
  factoryId: string;
  name: string;
  plcId: string;
  gatewayConnectionId: string;
  /** Where an edge device connects. */
  endpoint: { host: string; port: number; unitId: number };
  deviceIds: Record<keyof typeof DEMO_DEVICES | "gateway", string>;
};

const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export async function createDemoFactory(
  deps: GatewayDeps,
  actor: Actor,
  options: { subnetCidr?: string; gatewayHost?: string } = {},
): Promise<DemoFactory> {
  const { db } = deps;
  const model = async (modelName: string) => {
    const found = await db.deviceModel.findFirst({ where: { modelName }, select: { id: true } });
    if (!found) {
      throw new DomainError("CONFLICT", `The catalog has no model "${modelName}". Run npm run db:seed.`, {
        rule: "demo-catalog-required",
      });
    }
    return found.id;
  };

  // "Pump Station Demo", then "Pump Station Demo 2": a demo can be built more than once.
  const taken = new Set((await listFactories(db, actor)).map((factory) => factory.name));
  let name = DEMO_FACTORY_NAME;
  for (let copy = 2; taken.has(name); copy += 1) name = `${DEMO_FACTORY_NAME} ${copy}`;
  // Free in the database and on the Docker host (TASK-207), so the demo can start.
  const hostNetworks = () => listHostNetworks(deps.docker);
  const subnetCidr = options.subnetCidr ?? (await suggestFactorySubnet(db, hostNetworks));
  if (!subnetCidr) throw new DomainError("CONFLICT", "No free subnet is left for another factory.");
  const factory = await createFactory(
    db,
    actor,
    {
      name,
      slug: slugOf(name),
      subnetCidr,
      description: "MVP demo: pressure transmitter, PLC, drive, motor and pump in a closed loop, with a gateway.",
    },
    hostNetworks,
  );
  const factoryId = factory.id;

  // The PLC and the modules its field devices are wired to.
  const plc = await createPlc(db, actor, {
    factoryId,
    deviceModelId: await model(DEMO_MODELS.plc),
    name: DEMO_DEVICES.plc,
    role: "Pump station controller",
  });
  for (const [index, moduleName] of DEMO_MODELS.modules.entries()) {
    const moduleModel = await db.moduleModel.findFirst({ where: { modelName: moduleName }, select: { id: true } });
    if (!moduleModel) {
      throw new DomainError("CONFLICT", `The catalog has no module "${moduleName}". Run npm run db:seed.`, {
        rule: "demo-catalog-required",
      });
    }
    await installModule(db, actor, plc.id, { moduleModelId: moduleModel.id, slotIndex: index + 1 });
  }

  // Wired devices: every terminal gets a free compatible channel and a tag.
  await addPeripheral(db, actor, plc.id, {
    deviceModelId: await model(DEMO_MODELS.vfd),
    name: DEMO_DEVICES.vfd,
    role: "Pump drive",
  });
  await addPeripheral(db, actor, plc.id, {
    deviceModelId: await model(DEMO_MODELS.transmitter),
    name: DEMO_DEVICES.transmitter,
    role: "Discharge pressure",
  });
  const deviceId = async (deviceName: string) =>
    (await db.deviceInstance.findFirstOrThrow({ where: { factoryId, name: deviceName }, select: { id: true } })).id;
  const vfdId = await deviceId(DEMO_DEVICES.vfd);
  const transmitterId = await deviceId(DEMO_DEVICES.transmitter);

  // The drive train: the drive drives the motor, the motor the pump; the transmitter measures the pump.
  const place = async (key: "motor" | "pump") =>
    (
      await placeDevice(db, actor, factoryId, {
        deviceModelId: await model(DEMO_MODELS[key]),
        name: DEMO_DEVICES[key],
        x: DEMO_POSITIONS[key][0],
        y: DEMO_POSITIONS[key][1],
      })
    ).id;
  const motorId = await place("motor");
  const pumpId = await place("pump");
  // Named, because two devices with terminals could also be wired pin by pin.
  await linkDevices(db, actor, factoryId, { fromId: vfdId, toId: motorId, kind: "DRIVES" });
  // The motor cable, phase by phase, so the 3D view draws three conductors (TASK-405).
  const phases = await getPairWiring(db, actor, factoryId, vfdId, motorId);
  for (const label of ["U", "V", "W"]) {
    const from = phases.first.endpoints.find((endpoint) => endpoint.label === label);
    const to = phases.second.endpoints.find((endpoint) => endpoint.label === label);
    if (!from || !to) throw new DomainError("INVARIANT", `The demo drive or motor has no ${label} terminal.`);
    await connectWire(db, actor, factoryId, {
      from: { deviceId: vfdId, type: from.type, id: from.id },
      to: { deviceId: motorId, type: to.type, id: to.id },
    });
  }
  await linkDevices(db, actor, factoryId, { fromId: motorId, toId: pumpId, kind: "MECHANICALLY_DRIVES" });
  await linkDevices(db, actor, factoryId, { fromId: transmitterId, toId: pumpId, kind: "MEASURES" });
  await db.simulationProfile.createMany({
    data: [
      { deviceInstanceId: vfdId, kind: "STATE_MACHINE", parametersJson: DEMO_PROFILES.vfd },
      { deviceInstanceId: transmitterId, kind: "STATE_MACHINE", parametersJson: DEMO_PROFILES.transmitter },
    ],
  });

  // What an operator or a gateway writes, and what the program reports.
  for (const tag of DEMO_OPERATOR_TAGS) await createTag(db, actor, plc.id, { ...tag });

  // The program, with every tag of the PLC declared at the address the wiring gave it.
  const tags = await db.tag.findMany({ where: { plcInstanceId: plc.id }, orderBy: { logicalAddress: "asc" } });
  const sourceNames = new Map(
    (await db.deviceInstance.findMany({ where: { factoryId }, select: { id: true, name: true } })).map((device) => [
      device.id,
      device.name,
    ]),
  );
  await createProgramVersion(db, actor, plc.id, {
    sourceText: demoProgram(
      tags.flatMap((tag) =>
        tag.logicalAddress && isIecIdentifier(tag.name)
          ? [
              {
                name: tag.name,
                address: tag.logicalAddress,
                type: iecTypeFor(tag.dataType),
                comment: tag.sourceDeviceInstanceId
                  ? `${sourceNames.get(tag.sourceDeviceInstanceId) ?? "device"}${tag.sourceSignal ? ` ${tag.sourceSignal}` : ""}`
                  : tag.role.toLowerCase(),
              },
            ]
          : [],
      ),
    ),
  });

  // The gateway: one endpoint for an edge device, with every tag mapped (commands and setpoints writable).
  const gateway = await addGateway(deps, actor, factoryId);
  // In the designer and the 3D view the gateway is a device on the PLC's network.
  await linkDevices(db, actor, factoryId, { fromId: plc.id, toId: gateway.id, kind: "COMMUNICATES_WITH" });
  const view = await getGatewaysView(deps, actor, factoryId);
  if (view.suggestedPort === null)
    throw new DomainError("CONFLICT", "No free host port is left for the gateway endpoint.");
  const host = options.gatewayHost ?? "127.0.0.1";
  const { connectionId } = await connectGateway(deps, actor, gateway.id, {
    plcId: plc.id,
    host,
    port: view.suggestedPort,
  });
  await mapAllGatewayTags(deps, actor, connectionId);

  const deviceIds = {
    gateway: gateway.id,
    plc: plc.id,
    vfd: vfdId,
    motor: motorId,
    pump: pumpId,
    transmitter: transmitterId,
  };
  await moveDevices(
    db,
    actor,
    factoryId,
    (Object.keys(deviceIds) as Array<keyof typeof deviceIds>).map((key) => ({
      deviceId: deviceIds[key],
      x: DEMO_POSITIONS[key][0],
      y: DEMO_POSITIONS[key][1],
    })),
  );

  return {
    factoryId,
    name,
    plcId: plc.id,
    gatewayConnectionId: connectionId,
    endpoint: { host, port: view.suggestedPort, unitId: 1 },
    deviceIds,
  };
}
