// @vitest-environment node
import { describe, expect, it } from "vitest";
import { loadCatalog, mergeCatalogs } from "@/lib/catalog";
import { GENERIC_CATEGORIES } from "@/lib/catalog/generic-categories";
import { genericModels } from "@/lib/catalog/generic-models";
import { type CatalogInput, GENERIC_MANUFACTURER, parseCatalog } from "@/lib/catalog/schema";
import { siemens } from "@/lib/catalog/vendor/siemens";
import { CONTROL_CAPABILITIES, DRIVE_TYPES, signalFits, VERIFICATION_STATUSES } from "@/lib/domain/catalog";
import { DomainError } from "@/lib/domain/errors";
import * as prismaEnums from "@/lib/generated/prisma/enums";

const catalog = loadCatalog();
const sorted = (values: readonly string[]) => [...values].sort();

/** Documentation hosts of the manufacturers themselves. */
const MANUFACTURER_HOSTS = [
  "cache.industry.siemens.com",
  "literature.rockwellautomation.com",
  "download.schneider-electric.com",
];

function expectRejected(input: CatalogInput, message: RegExp) {
  try {
    parseCatalog(input);
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).details.rule).toBe("catalog-definition");
    expect((error as DomainError).message).toMatch(message);
    return;
  }
  throw new Error("expected the catalog to be rejected");
}

type Model = CatalogInput["models"][number];
type Simulation = Model["simulation"];
const simulated = (
  profile: string,
  faults: string[] = [],
  rest: Partial<Extract<Simulation, { coverage: "GENERIC" }>> = {},
): Simulation => ({ coverage: "GENERIC", profile, profileVersion: 1, faults, ...rest });
const vendorDrive = (simulation: Simulation, verified = true): Model => ({
  manufacturer: "Siemens",
  category: "VFD",
  family: "Test drives",
  modelName: "Test drive",
  sku: "TEST-1",
  runtimeSupport: "DEVICE_SIM",
  controlCapability: "PARAMETER_CONFIGURED",
  capabilities: ["PARAMETER_CONFIGURABLE"],
  verification: verified
    ? {
        status: "VERIFIED",
        verifiedAt: "2026-10-05",
        source: {
          url: "https://cache.industry.siemens.com/dl/files/test/test-drive-manual.pdf",
          title: "Test drive operating instructions",
          revision: "A5E00000000-AA, 01/2026",
          retrievedAt: "2026-10-05",
        },
      }
    : { status: "UNVERIFIED" },
  simulation,
});
type Feature = { key: string; label: string; implemented: boolean };
/** A vendor model's declared features at a coverage, on the generic VFD profile. */
const withFeatures = (coverage: "PARTIAL" | "FULL", features: Feature[]): Simulation => ({
  coverage,
  profile: "VFD",
  profileVersion: 1,
  features,
});
const withDrive = (simulation: Simulation, verified = true): CatalogInput => ({
  ...siemens,
  models: [...siemens.models, vendorDrive(simulation, verified)],
});
const firstModel = (part: CatalogInput): Model => {
  const model = part.models[0];
  if (!model) throw new Error("no model");
  return model;
};
const withModel = (part: CatalogInput, change: (model: Model) => Model): CatalogInput => ({
  ...part,
  models: [change(firstModel(part)), ...part.models.slice(1)],
});

describe("catalog vocabulary", () => {
  it("matches the database enums", () => {
    expect(sorted(CONTROL_CAPABILITIES)).toEqual(sorted(Object.values(prismaEnums.ControlCapability)));
    expect(sorted(DRIVE_TYPES)).toEqual(sorted(Object.values(prismaEnums.DriveType)));
    expect(sorted(VERIFICATION_STATUSES)).toEqual(sorted(Object.values(prismaEnums.VerificationStatus)));
  });

  it("treats a signal inside a wider range as fitting, never the other way round", () => {
    expect(signalFits("VOLTAGE_PM_10V", "VOLTAGE_0_10V")).toBe(true);
    expect(signalFits("CURRENT_0_20MA", "CURRENT_4_20MA")).toBe(true);
    expect(signalFits("VOLTAGE_0_10V", "VOLTAGE_0_10V")).toBe(true);
    expect(signalFits("VOLTAGE_0_10V", "VOLTAGE_PM_10V")).toBe(false);
    expect(signalFits("VOLTAGE_0_10V", "CURRENT_4_20MA")).toBe(false);
    expect(signalFits("CURRENT_4_20MA", "CURRENT_0_20MA")).toBe(false);
  });
});

describe("generic categories", () => {
  const byCode = Object.fromEntries(GENERIC_CATEGORIES.map((category) => [category.code, category]));

  it("covers controllers, intermediate devices and field devices", () => {
    for (const code of [
      "PLC",
      "VFD",
      "SERVO_DRIVE",
      "SOFT_STARTER",
      "MOTION_CONTROLLER",
      "PROCESS_CONTROLLER",
      "TEMPERATURE_CONTROLLER",
      "ROBOT_CONTROLLER",
      "SAFETY_RELAY",
      "REMOTE_IO",
      "IO_LINK_MASTER",
      "GATEWAY",
      "EDGE_GATEWAY",
      "SIGNAL_CONDITIONER",
      "TRANSMITTER",
      "MOTOR_STARTER",
      "HMI",
      "MOTOR",
      "PUMP",
      "FAN",
      "CONVEYOR",
      "MIXER",
      "COMPRESSOR",
      "VALVE",
      "ACTUATOR",
      "HEATER",
      "RELAY",
      "CONTACTOR",
      "SWITCH",
      "SENSOR",
      "PROXIMITY_SENSOR",
      "ENCODER",
    ]) {
      expect(byCode[code], code).toBeDefined();
    }
    expect(new Set(GENERIC_CATEGORIES.map((category) => category.code)).size).toBe(GENERIC_CATEGORIES.length);
  });

  it("records drive relationships without forcing a drive on every motor-driven device", () => {
    expect(byCode.PUMP).toMatchObject({ requiresMotor: true, requiresDrive: false, preferredDriveType: "VFD" });
    expect(byCode.COMPRESSOR).toMatchObject({
      requiresMotor: true,
      requiresDrive: false,
      preferredDriveType: "SOFT_STARTER",
    });
    expect(byCode.MOTOR).toMatchObject({ requiresMotor: false, requiresDrive: false });
    expect(byCode.SERVO_MOTOR).toMatchObject({ requiresDrive: true, preferredDriveType: "SERVO" });
    expect(byCode.SENSOR).toMatchObject({ requiresMotor: false, requiresDrive: false, preferredDriveType: null });
  });
});

describe("shipped catalog", () => {
  const vendorModels = catalog.models.filter((model) => model.manufacturer !== GENERIC_MANUFACTURER);

  it("contains the four initial PLC targets with their exact order numbers and architecture", () => {
    expect(
      vendorModels.map((model) => [model.manufacturer, model.modelName, model.sku, model.architectureType]),
    ).toEqual([
      ["Siemens", "CPU 1214C DC/DC/DC", "6ES7214-1AG40-0XB0", "COMPACT"],
      ["Siemens", "CPU 1511-1 PN", "6ES7511-1AK02-0AB0", "MODULAR"],
      ["Rockwell Automation", "5069-L306ER", "5069-L306ER", "MODULAR"],
      ["Schneider Electric", "TM241CE24T", "TM241CE24T", "COMPACT"],
    ]);
    expect(vendorModels.every((model) => model.controlCapability === "PROGRAMMABLE")).toBe(true);
  });

  it("carries complete provenance from manufacturer documentation for every vendor record", () => {
    for (const record of [...vendorModels, ...catalog.modules]) {
      const name = `${record.manufacturer} ${record.modelName}`;
      expect(record.verification.status, name).toBe("VERIFIED");
      if (record.verification.status !== "VERIFIED") continue;
      const { source, verifiedAt } = record.verification;
      expect(MANUFACTURER_HOSTS, name).toContain(new URL(source.url).host);
      expect(source.title.length, name).toBeGreaterThan(10);
      // Document number and edition date as printed.
      expect(source.revision, name).toMatch(/\d{4}/);
      expect(source.retrievedAt, name).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(verifiedAt >= source.retrievedAt, name).toBe(true);
    }
  });

  it("records the documented built-in I/O of the compact PLCs and none for the modular ones", () => {
    const io = (modelName: string) =>
      Object.fromEntries(
        (catalog.models.find((model) => model.modelName === modelName)?.builtInChannels ?? []).map((group) => [
          group.ioType,
          [group.count, group.signalType],
        ]),
      );
    expect(io("CPU 1214C DC/DC/DC")).toEqual({ DI: [14, "DC_24V"], DO: [10, "DC_24V"], AI: [2, "VOLTAGE_0_10V"] });
    expect(io("TM241CE24T")).toEqual({ DI: [14, "DC_24V"], DO: [10, "DC_24V"] });
    expect(io("CPU 1511-1 PN")).toEqual({});
    expect(io("5069-L306ER")).toEqual({});
  });

  it("claims Modbus TCP only where the source states it", () => {
    const protocols = (modelName: string) =>
      (catalog.models.find((model) => model.modelName === modelName)?.ports ?? []).flatMap((port) => port.protocols);
    expect(protocols("CPU 1214C DC/DC/DC")).toEqual(["MODBUS_TCP"]);
    expect(protocols("CPU 1511-1 PN")).toEqual(["MODBUS_TCP"]);
    expect(protocols("TM241CE24T")).toEqual(["MODBUS_TCP"]);
    expect(protocols("5069-L306ER")).toEqual([]);
  });

  it("gives each modular CPU a rack and digital and analog modules in both directions", () => {
    for (const cpu of ["CPU 1511-1 PN", "5069-L306ER"]) {
      const model = catalog.models.find((candidate) => candidate.modelName === cpu);
      expect(
        catalog.racks.some((rack) => rack.family === model?.family),
        cpu,
      ).toBe(true);
      const types = catalog.modules
        .filter((module) => module.compatibleCpus.includes(cpu))
        .map((module) => module.moduleType);
      expect(sorted(types), cpu).toEqual(["ANALOG_INPUT", "ANALOG_OUTPUT", "DIGITAL_INPUT", "DIGITAL_OUTPUT"]);
    }
  });

  it("keeps generic models free of vendor claims", () => {
    const generic = catalog.models.filter((model) => model.manufacturer === GENERIC_MANUFACTURER);
    expect(generic.length).toBeGreaterThan(15);
    for (const model of generic) {
      expect(model.verification, model.modelName).toEqual({ status: "GENERIC" });
      expect(model.sku, model.modelName).toBeUndefined();
      expect(model.modelName, model.modelName).toMatch(/^Generic /);
    }
  });

  it("declares how each model is controlled instead of inferring it from the category", () => {
    const capability = (modelName: string) =>
      catalog.models.find((model) => model.modelName === modelName)?.controlCapability;
    // Two models of the same category, controlled differently.
    expect(capability("Generic VFD, hardwired control")).toBe("PARAMETER_CONFIGURED");
    expect(capability("Generic VFD, Modbus TCP")).toBe("PROTOCOL_CONTROLLED");
    expect(capability("Generic push button, 24 V DC")).toBe("DIRECT_IO");
    expect(capability("Generic temperature controller")).toBe("PARAMETER_CONFIGURED");
    expect(new Set(catalog.models.map((model) => model.controlCapability))).toEqual(new Set(CONTROL_CAPABILITIES));
  });

  it("marks a model executable in the simulator only when a behaviour model exists for it", () => {
    const simulatedTypes = new Set([
      "VFD",
      "MOTOR",
      "PUMP",
      "FAN",
      "CONVEYOR",
      "MIXER",
      "COMPRESSOR",
      "VALVE",
      "SENSOR",
      "SWITCH",
    ]);
    for (const model of catalog.models.filter((candidate) => candidate.runtimeSupport === "DEVICE_SIM")) {
      const type = GENERIC_CATEGORIES.find((category) => category.code === model.category)?.simulatorType;
      expect(simulatedTypes.has(type ?? ""), model.modelName).toBe(true);
    }
  });

  it("declares a simulation decision for every model: generic behaviour or the reason nothing runs", () => {
    for (const model of catalog.models) {
      const type = GENERIC_CATEGORIES.find((category) => category.code === model.category)?.simulatorType;
      if (model.runtimeSupport === "DEVICE_SIM") {
        expect(model.simulation, model.modelName).toMatchObject({
          coverage: "GENERIC",
          profile: type,
          profileVersion: 1,
        });
      } else {
        expect(model.simulation.coverage, model.modelName).toBe("NOT_SIMULATABLE");
        expect("reason" in model.simulation && model.simulation.reason.length, model.modelName).toBeGreaterThan(10);
      }
    }
    // Nothing in the shipped catalog claims more than the generic behaviour of its category.
    expect(new Set(catalog.models.map((model) => model.simulation.coverage))).toEqual(
      new Set(["GENERIC", "NOT_SIMULATABLE"]),
    );
    // A programmable controller runs its program on the adapter; it is not a simulated device.
    for (const plc of catalog.models.filter((model) => model.category === "PLC")) {
      expect(plc.simulation).toMatchObject({ coverage: "NOT_SIMULATABLE", reason: expect.stringContaining("OpenPLC") });
    }
  });
});

describe("simulation decision rules", () => {
  it("ties the coverage to the runtime: the simulator executes a model with a profile, nothing else", () => {
    expectRejected(
      withModel(genericModels, (model) => ({ ...model, runtimeSupport: "NONE" })),
      /NOT_SIMULATABLE/,
    );
    expectRejected(
      withModel(genericModels, (model) => ({
        ...model,
        simulation: { coverage: "NOT_SIMULATABLE", reason: "test: nothing runs it" },
      })),
      /NOT_SIMULATABLE/,
    );
    // A PLC is a program host, not a simulated device: its coverage cannot name a profile.
    expectRejected(
      withModel(siemens, (model) => ({ ...model, simulation: simulated("VFD") })),
      /NOT_SIMULATABLE/,
    );
    expectRejected(
      withModel(siemens, (model) => ({ ...model, simulation: { coverage: "NOT_SIMULATABLE" } as never })),
      /not valid/,
    );
  });

  it("accepts only a profile of the model's category, at a version that exists", () => {
    expectRejected(
      withModel(genericModels, (model) => ({ ...model, simulation: simulated("BOILER") })),
      /profile that does not exist/,
    );
    expectRejected(
      withModel(genericModels, (model) => ({ ...model, simulation: { ...simulated("VFD"), profileVersion: 2 } })),
      /version of its behaviour profile/,
    );
    expectRejected(
      withModel(genericModels, (model) => ({ ...model, simulation: simulated("PUMP") })),
      /profile is the one of its category/,
    );
  });

  it("refuses a terminal signal on a model that is not simulated", () => {
    expectRejected(
      withModel(genericModels, (model) => ({
        ...model,
        runtimeSupport: "NONE",
        simulation: { coverage: "NOT_SIMULATABLE", reason: "test: nothing runs it" },
      })),
      /names a simulator signal, but the model is not simulated/,
    );
  });

  it("checks parameter values against the profile's bounds and names", () => {
    expectRejected(
      withModel(genericModels, (model) => ({
        ...model,
        simulation: simulated("VFD", [], { parameters: { accelTimeS: 0 } }),
      })),
      /outside the bounds/,
    );
    expectRejected(
      withModel(genericModels, (model) => ({
        ...model,
        simulation: simulated("VFD", [], { parameters: { maxFrequencyHz: 1001 } }),
      })),
      /outside the bounds/,
    );
    expectRejected(
      withModel(genericModels, (model) => ({
        ...model,
        simulation: simulated("VFD", [], { parameters: { ratedFlow: 10 } }),
      })),
      /parameter its behaviour profile does not have/,
    );
    // Within the bounds, a generic model may set the generic defaults of its own kind.
    expect(
      parseCatalog(
        withModel(genericModels, (model) => ({
          ...model,
          simulation: simulated("VFD", ["OVERCURRENT"], { parameters: { maxFrequencyHz: 60, accelTimeS: 3 } }),
        })),
      ).models[0]?.simulation,
    ).toMatchObject({ parameters: { maxFrequencyHz: 60, accelTimeS: 3 } });
  });

  it("keeps generic and vendor facts apart", () => {
    const features = [
      { key: "S_CURVE_RAMP", label: "S-curve ramp", implemented: true },
      { key: "DC_BRAKING", label: "DC braking", implemented: false },
    ];
    // A generic model has nothing model-specific.
    expectRejected(
      withModel(genericModels, (model) => ({
        ...model,
        simulation: withFeatures("PARTIAL", features),
      })),
      /generic model has no model-specific behaviour/,
    );
    // A vendor model may run on the generic behaviour of its category without any claim …
    expect(parseCatalog(withDrive(simulated("VFD", ["OVERCURRENT"]), false)).models).toHaveLength(3);
    // … but a model-specific fact needs its verified provenance.
    expectRejected(
      withDrive(simulated("VFD", [], { parameters: { maxFrequencyHz: 60 } }), false),
      /VERIFIED provenance/,
    );
    expectRejected(withDrive(withFeatures("PARTIAL", features), false), /VERIFIED provenance/);
    expect(parseCatalog(withDrive(withFeatures("PARTIAL", features))).models[2]?.simulation).toMatchObject({
      coverage: "PARTIAL",
    });
  });

  it("makes the coverage match the declared features", () => {
    const done = { key: "S_CURVE_RAMP", label: "S-curve ramp", implemented: true };
    const open = { key: "DC_BRAKING", label: "DC braking", implemented: false };
    expectRejected(
      withDrive(withFeatures("FULL", [done, open])),
      /FULL coverage means every declared feature is implemented/,
    );
    expectRejected(
      withDrive(withFeatures("PARTIAL", [done, { ...open, implemented: true }])),
      /PARTIAL coverage means some/,
    );
    expectRejected(withDrive(withFeatures("PARTIAL", [open, { ...open, label: "again" }])), /declared twice/);
    expectRejected(withDrive(withFeatures("FULL", [])), /not valid/);
    expect(parseCatalog(withDrive(withFeatures("FULL", [done]))).models[2]?.simulation).toMatchObject({
      coverage: "FULL",
    });
  });
});

describe("catalog definition rules", () => {
  it("accepts the shipped parts on their own", () => {
    expect(parseCatalog(siemens).models).toHaveLength(2);
    expect(parseCatalog(genericModels).modules).toEqual([]);
  });

  it("rejects a verified record without its source or verification date", () => {
    expectRejected(
      withModel(siemens, (model) => ({ ...model, verification: { status: "VERIFIED" } as never })),
      /not valid/,
    );
    expectRejected(
      withModel(siemens, (model) => ({
        ...model,
        verification: {
          status: "VERIFIED",
          verifiedAt: "2026-10-05",
          source: { url: "not a url", title: "t", revision: "r", retrievedAt: "2026-10-05" },
        },
      })),
      /not valid/,
    );
  });

  it("rejects vendor records without an order number and generic records with one", () => {
    expectRejected(
      withModel(siemens, ({ sku: _sku, ...model }) => model),
      /exact order number/,
    );
    expectRejected(
      withModel(genericModels, (model) => ({ ...model, sku: "ABC-123" })),
      /no vendor order number/,
    );
    expectRejected(
      withModel(genericModels, (model) => ({ ...model, verification: { status: "UNVERIFIED" } })),
      /GENERIC status/,
    );
    expectRejected(
      withModel(siemens, (model) => ({ ...model, verification: { status: "GENERIC" } })),
      /GENERIC status/,
    );
  });

  it("rejects PLC architecture mistakes", () => {
    expectRejected(
      withModel(siemens, ({ architectureType: _architecture, ...model }) => model),
      /architecture/,
    );
    expectRejected(
      withModel(genericModels, (model) => ({ ...model, architectureType: "COMPACT" })),
      /architecture/,
    );
    expectRejected(
      withModel(siemens, (model) => ({ ...model, architectureType: "MODULAR" })),
      /modules, not built-in channels/,
    );
  });

  it("rejects simulator signals and faults the device type does not have", () => {
    const terminal = { terminalLabel: "X", direction: "INPUT", ioType: "DIGITAL", signalType: "DC_24V" } as const;
    expectRejected(
      withModel(genericModels, (model) => ({ ...model, terminals: [{ ...terminal, simulatorSignal: "torque" }] })),
      /simulator signal/,
    );
    // `running` is something a VFD reports, not something it is told.
    expectRejected(
      withModel(genericModels, (model) => ({ ...model, terminals: [{ ...terminal, simulatorSignal: "running" }] })),
      /simulator signal/,
    );
    expectRejected(
      withModel(genericModels, (model) => ({ ...model, simulation: simulated("VFD", ["DRY_RUN"]) })),
      /fault/,
    );
    expectRejected(
      withModel(genericModels, (model) => ({ ...model, terminals: [terminal, terminal] })),
      /Terminal labels must be unique/,
    );
  });

  it("rejects unknown references and duplicates", () => {
    expectRejected({ ...siemens, manufacturers: [] }, /unknown manufacturer/);
    expectRejected({ ...siemens, models: [...siemens.models, firstModel(siemens)] }, /defined twice/);
    expectRejected(
      {
        ...siemens,
        modules: (siemens.modules ?? []).map((module) => ({ ...module, compatibleCpus: ["CPU 1214C DC/DC/DC"] })),
      },
      /modular CPUs of its own family/,
    );
    expectRejected(
      mergeCatalogs([
        siemens,
        {
          manufacturers: [],
          models: [],
          racks: [{ manufacturer: "Siemens", family: "LOGO!", name: "r", slotCount: 4 }],
        },
      ]),
      /rack belongs/,
    );
    expectRejected(
      withModel(siemens, (model) => ({ ...model, category: "NOT_A_CATEGORY" })),
      /not valid/,
    );
    expectRejected(
      withModel(siemens, (model) => ({ ...model, unknownField: true }) as never),
      /not valid/,
    );
  });
});
