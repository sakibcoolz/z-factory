// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { withDomainErrors } from "@/lib/db/errors";
import { factoryRepository } from "@/lib/db/repositories/factory-repository";
import { DomainError, type DomainErrorCode } from "@/lib/domain/errors";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { connectDevices } from "@/lib/services/connection-service";
import { createDeviceInstance } from "@/lib/services/device-service";
import { createFactory, createGenericModel, describeDb, openTestDb, resetDb } from "./harness";

async function expectDomainError(action: Promise<unknown>, code: DomainErrorCode, constraintOrRule?: string) {
  const error = await action.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe(code);
  if (constraintOrRule) {
    const { rule, constraint } = (error as DomainError).details;
    expect(rule ?? constraint).toBe(constraintOrRule);
  }
}

describeDb("domain foundation against PostgreSQL", () => {
  let db: PrismaClient;

  beforeAll(() => {
    db = openTestDb();
  });
  beforeEach(async () => {
    await resetDb(db);
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  /** Pump-house chain: sensor, compact PLC with built-in channels, VFD, two motors, pump. */
  async function buildFactory() {
    const factory = await createFactory(db, "Pump House");
    const plcModel = await createGenericModel(db, "PLC", "Generic compact PLC", {
      architectureType: "COMPACT",
      builtInChannels: [
        { ioType: "AI", channelIndex: 0, signalType: "CURRENT_4_20MA" },
        { ioType: "AI", channelIndex: 1, signalType: "VOLTAGE_0_10V" },
        { ioType: "DI", channelIndex: 0, signalType: "DC_24V" },
      ],
    });
    const sensorModel = await createGenericModel(db, "SENSOR", "Generic pressure transmitter", {
      ioDefinitions: [{ direction: "OUTPUT", ioType: "ANALOG", signalType: "CURRENT_4_20MA" }],
    });
    const vfdModel = await createGenericModel(db, "VFD", "Generic VFD");
    const motorModel = await createGenericModel(db, "MOTOR", "Generic motor");
    const pumpModel = await createGenericModel(db, "PUMP", "Generic pump");

    const make = (deviceModelId: string, name: string) =>
      createDeviceInstance(db, { factoryId: factory.id, deviceModelId, name });
    const plc = await make(plcModel.id, "PLC-01");
    const sensor = await make(sensorModel.id, "PT-101");
    const vfd = await make(vfdModel.id, "VFD-01");
    const motor = await make(motorModel.id, "MOTOR-01");
    const spareMotor = await make(motorModel.id, "MOTOR-02");
    const pump = await make(pumpModel.id, "PUMP-01");

    const ioPoints = await Promise.all(
      plcModel.builtInIoChannels.map((channel, index) =>
        db.plcIoPoint.create({
          data: {
            plcInstanceId: plc.id,
            sourceType: "BUILT_IN",
            builtInChannelId: channel.id,
            logicalAddress: `%IW${100 + index}`,
          },
          include: { builtInChannel: true },
        }),
      ),
    );
    const point = (ioType: string, signalType: string) => {
      const found = ioPoints.find(
        (p) => p.builtInChannel?.ioType === ioType && p.builtInChannel.signalType === signalType,
      );
      if (!found) throw new Error(`no ${ioType} ${signalType} point`);
      return found;
    };

    return {
      factory,
      models: { plcModel, sensorModel, vfdModel, motorModel, pumpModel },
      plc,
      sensor,
      vfd,
      motor,
      spareMotor,
      pump,
      sensorTerminal: sensorModel.ioDefinitions[0]!,
      currentInput: point("AI", "CURRENT_4_20MA"),
      voltageInput: point("AI", "VOLTAGE_0_10V"),
      digitalInput: point("DI", "DC_24V"),
    };
  }

  it("keeps device instance names unique within a factory, not across factories", async () => {
    const { factory, models } = await buildFactory();

    await expectDomainError(
      createDeviceInstance(db, { factoryId: factory.id, deviceModelId: models.vfdModel.id, name: "VFD-01" }),
      "CONFLICT",
      "DeviceInstance_factoryId_name_key",
    );

    const other = await createFactory(db, "Conveyor Line");
    const sameName = await createDeviceInstance(db, {
      factoryId: other.id,
      deviceModelId: models.vfdModel.id,
      name: "VFD-01",
    });
    expect(sameName.factoryId).toBe(other.id);
  });

  it("keeps catalog models separate from factory instances", async () => {
    const { factory, models, vfd } = await buildFactory();

    // One reusable model, many instances.
    const second = await createDeviceInstance(db, {
      factoryId: factory.id,
      deviceModelId: models.vfdModel.id,
      name: "VFD-02",
    });
    expect(second.deviceModelId).toBe(vfd.deviceModelId);

    // A model in use cannot be deleted from the catalog…
    await expectDomainError(
      withDomainErrors(() => db.deviceModel.delete({ where: { id: models.vfdModel.id } })),
      "CONFLICT",
    );

    // …and deleting a factory removes its instances but leaves the catalog untouched.
    expect(await factoryRepository.delete(db, factory.ownerId, factory.id)).toBe(1);
    expect(await db.deviceInstance.count()).toBe(0);
    expect(await db.deviceModel.count()).toBe(5);
  });

  it("derives runtime behavior from the catalog and gives PLCs an instance profile", async () => {
    const { plc, vfd } = await buildFactory();

    expect(plc.runtimeType).toBe("OPENPLC");
    expect(vfd.runtimeType).toBe("DEVICE_SIM");
    expect(vfd.simulatorType).toBe("VFD");
    expect(await db.plcInstanceProfile.count({ where: { deviceInstanceId: plc.id } })).toBe(1);
    expect(await db.plcInstanceProfile.count({ where: { deviceInstanceId: vfd.id } })).toBe(0);
  });

  it("rejects unknown models, unknown factories and unsafe names", async () => {
    const { factory, models } = await buildFactory();
    const missing = "01a107ff-de99-71ec-adbb-40049a4cf552";

    await expectDomainError(
      createDeviceInstance(db, { factoryId: factory.id, deviceModelId: missing, name: "X-01" }),
      "NOT_FOUND",
    );
    await expectDomainError(
      createDeviceInstance(db, { factoryId: missing, deviceModelId: models.vfdModel.id, name: "X-01" }),
      "NOT_FOUND",
    );
    await expectDomainError(
      createDeviceInstance(db, { factoryId: factory.id, deviceModelId: models.vfdModel.id, name: "bad name;" }),
      "VALIDATION",
    );
  });

  it("refuses a PLC model that declares no architecture", async () => {
    const { factory } = await buildFactory();
    const undeclared = await createGenericModel(db, "PLC", "PLC without architecture");

    await expectDomainError(
      createDeviceInstance(db, { factoryId: factory.id, deviceModelId: undeclared.id, name: "PLC-02" }),
      "VALIDATION",
      "plc-architecture-required",
    );
  });

  it("lets one VFD drive exactly one motor", async () => {
    const { factory, vfd, motor, spareMotor } = await buildFactory();
    const drive = (targetId: string) =>
      connectDevices(db, {
        factoryId: factory.id,
        relationship: "DRIVES",
        source: { deviceId: vfd.id },
        target: { deviceId: targetId },
      });

    await drive(motor.id);
    await expectDomainError(drive(spareMotor.id), "INVARIANT", "one-motor-per-drive");

    // The database holds the same line even when the service is bypassed.
    await expectDomainError(
      withDomainErrors(() =>
        db.deviceConnection.create({
          data: {
            factoryId: factory.id,
            sourceDeviceId: vfd.id,
            targetDeviceId: spareMotor.id,
            sourceEndpointType: "DEVICE",
            sourceEndpointRef: vfd.id,
            targetEndpointType: "DEVICE",
            targetEndpointRef: spareMotor.id,
            relationship: "DRIVES",
          },
        }),
      ),
      "INVARIANT",
      "DeviceConnection_one_motor_per_drive",
    );
  });

  it("only lets a drive drive a motor, and a motor drive equipment", async () => {
    const { factory, plc, vfd, motor, pump } = await buildFactory();
    const connect = (relationship: string, sourceId: string, targetId: string) =>
      connectDevices(db, {
        factoryId: factory.id,
        relationship,
        source: { deviceId: sourceId },
        target: { deviceId: targetId },
      });

    await expectDomainError(connect("DRIVES", plc.id, motor.id), "INCOMPATIBLE", "drives-source");
    await expectDomainError(connect("DRIVES", vfd.id, pump.id), "INCOMPATIBLE", "drives-target");
    await expectDomainError(connect("MECHANICALLY_DRIVES", vfd.id, pump.id), "INCOMPATIBLE", "mechanical-source");

    const mechanical = await connect("MECHANICALLY_DRIVES", motor.id, pump.id);
    expect(mechanical.relationship).toBe("MECHANICALLY_DRIVES");
  });

  it("wires a compatible signal to a free channel and marks it occupied", async () => {
    const { factory, plc, sensor, sensorTerminal, currentInput } = await buildFactory();

    await connectDevices(db, {
      factoryId: factory.id,
      relationship: "MEASURES",
      source: { deviceId: sensor.id, endpointType: "DEVICE_IO", endpointRef: sensorTerminal.id },
      target: { deviceId: plc.id, endpointType: "PLC_IO_POINT", endpointRef: currentInput.id },
    });

    const point = await db.plcIoPoint.findUniqueOrThrow({ where: { id: currentInput.id } });
    expect(point.status).toBe("OCCUPIED");
  });

  it("rejects incompatible wiring", async () => {
    const { factory, plc, sensor, sensorTerminal, voltageInput, digitalInput } = await buildFactory();
    const wire = (ioPointId: string) =>
      connectDevices(db, {
        factoryId: factory.id,
        relationship: "MEASURES",
        source: { deviceId: sensor.id, endpointType: "DEVICE_IO", endpointRef: sensorTerminal.id },
        target: { deviceId: plc.id, endpointType: "PLC_IO_POINT", endpointRef: ioPointId },
      });

    await expectDomainError(wire(voltageInput.id), "INCOMPATIBLE", "signal-type");
    await expectDomainError(wire(digitalInput.id), "INCOMPATIBLE", "io-point-type");
    expect(await db.deviceConnection.count()).toBe(0);
    expect(await db.plcIoPoint.count({ where: { status: "OCCUPIED" } })).toBe(0);
  });

  it("never assigns an occupied channel twice", async () => {
    const { factory, models, plc, sensor, sensorTerminal, currentInput } = await buildFactory();
    const second = await createDeviceInstance(db, {
      factoryId: factory.id,
      deviceModelId: models.sensorModel.id,
      name: "PT-102",
    });
    const wire = (deviceId: string) =>
      connectDevices(db, {
        factoryId: factory.id,
        relationship: "MEASURES",
        source: { deviceId, endpointType: "DEVICE_IO", endpointRef: sensorTerminal.id },
        target: { deviceId: plc.id, endpointType: "PLC_IO_POINT", endpointRef: currentInput.id },
      });

    await wire(sensor.id);
    await expectDomainError(wire(second.id), "OCCUPIED_ENDPOINT", "io-point-free");
  });

  it("rejects an I/O point that belongs to another PLC", async () => {
    const { factory, models, sensor, sensorTerminal, currentInput } = await buildFactory();
    const otherPlc = await createDeviceInstance(db, {
      factoryId: factory.id,
      deviceModelId: models.plcModel.id,
      name: "PLC-02",
    });

    await expectDomainError(
      connectDevices(db, {
        factoryId: factory.id,
        relationship: "MEASURES",
        source: { deviceId: sensor.id, endpointType: "DEVICE_IO", endpointRef: sensorTerminal.id },
        target: { deviceId: otherPlc.id, endpointType: "PLC_IO_POINT", endpointRef: currentInput.id },
      }),
      "NOT_FOUND",
    );
  });

  it("stores command/setpoint tags as writable and refuses writable feedback", async () => {
    const { plc } = await buildFactory();
    const tag = (name: string, role: "SETPOINT" | "FEEDBACK", accessMode: "READ_ONLY" | "READ_WRITE") =>
      withDomainErrors(() =>
        db.tag.create({
          data: {
            plcInstanceId: plc.id,
            name,
            dataType: "FLOAT32",
            direction: "OUTPUT",
            role,
            accessMode,
            wordCount: 2,
          },
        }),
      );

    expect((await tag("VFD01_FrequencySetpoint", "SETPOINT", "READ_WRITE")).accessMode).toBe("READ_WRITE");
    expect((await tag("VFD01_ActualFrequency", "FEEDBACK", "READ_ONLY")).role).toBe("FEEDBACK");
    await expectDomainError(tag("Motor01_ActualRPM", "FEEDBACK", "READ_WRITE"), "INVARIANT", "Tag_writable_role_check");
    await expectDomainError(tag("VFD01_FrequencySetpoint", "SETPOINT", "READ_WRITE"), "CONFLICT");
  });

  it("refuses an I/O point that mixes built-in and module sources", async () => {
    const { plc, models } = await buildFactory();
    const channel = models.plcModel.builtInIoChannels[0]!;

    await expectDomainError(
      withDomainErrors(() =>
        db.plcIoPoint.create({
          data: { plcInstanceId: plc.id, sourceType: "MODULE", builtInChannelId: channel.id, logicalAddress: "%IW900" },
        }),
      ),
      "INVARIANT",
      "PlcIoPoint_source_check",
    );
  });

  it("scopes factories to their owner and reports conflicts", async () => {
    const mine = await createFactory(db, "Mine", "owner-1");
    await createFactory(db, "Theirs", "owner-2");

    expect((await factoryRepository.list(db, "owner-1")).map((f) => f.name)).toEqual(["Mine"]);
    expect(await factoryRepository.findById(db, "owner-2", mine.id)).toBeNull();
    expect(await factoryRepository.update(db, "owner-2", mine.id, { name: "Hijacked" })).toBe(0);
    expect(await factoryRepository.delete(db, "owner-2", mine.id)).toBe(0);

    await expectDomainError(
      factoryRepository.create(db, {
        id: "01a107ff-de99-71ec-adbb-40049a4cf552",
        ownerId: "owner-1",
        name: "Duplicate subnet",
        slug: "duplicate-subnet",
        subnetCidr: mine.subnetCidr,
        dockerNetworkName: "zfactory_duplicate",
      }),
      "CONFLICT",
      "Factory_subnetCidr_key",
    );
  });
});
