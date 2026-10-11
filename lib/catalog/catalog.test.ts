// @vitest-environment node
import { describe, expect, it } from "vitest";
import { loadCatalog, mergeCatalogs } from "@/lib/catalog";
import { GENERIC_CATEGORIES } from "@/lib/catalog/generic-categories";
import { genericModels } from "@/lib/catalog/generic-models";
import {
  type CatalogInput,
  GENERIC_MANUFACTURER,
  parseCatalog,
  protocolOf,
  resolveFactSource,
} from "@/lib/catalog/schema";
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
const vendorDrive = (
  simulation: Simulation,
  verified = true,
  capabilities: Model["capabilities"] = ["PARAMETER_CONFIGURABLE"],
): Model => ({
  manufacturer: "Siemens",
  category: "VFD",
  family: "Test drives",
  modelName: "Test drive",
  sku: "TEST-1",
  runtimeSupport: "DEVICE_SIM",
  controlCapability: "PARAMETER_CONFIGURED",
  capabilities,
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
/** A vendor model's declared features at a coverage, on the generic VFD profile, each with a source. */
const withFeatures = (coverage: "PARTIAL" | "FULL", features: Feature[]): Simulation => ({
  coverage,
  profile: "VFD",
  profileVersion: 1,
  features,
  sources: Object.fromEntries(features.map((feature) => [`feature:${feature.key}`, { reference: "test, page 1" }])),
});
const withDrive = (simulation: Simulation, verified = true, capabilities?: Model["capabilities"]): CatalogInput => ({
  ...siemens,
  models: [...siemens.models, vendorDrive(simulation, verified, capabilities)],
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
    const plcs = vendorModels.filter((model) => model.category === "PLC");
    expect(plcs.map((model) => [model.manufacturer, model.modelName, model.sku, model.architectureType])).toEqual([
      ["Siemens", "CPU 1214C DC/DC/DC", "6ES7214-1AG40-0XB0", "COMPACT"],
      ["Siemens", "CPU 1511-1 PN", "6ES7511-1AK02-0AB0", "MODULAR"],
      ["Rockwell Automation", "5069-L306ER", "5069-L306ER", "MODULAR"],
      ["Schneider Electric", "TM241CE24T", "TM241CE24T", "COMPACT"],
    ]);
    expect(plcs.every((model) => model.controlCapability === "PROGRAMMABLE")).toBe(true);
  });

  it("names what the runtime runs for the models the server's simulator does not (TASK-1013)", () => {
    const byName = Object.fromEntries(catalog.models.map((model) => [model.modelName, model.simulation]));
    const modbusDrive = byName["Generic VFD, Modbus TCP"];
    expect(modbusDrive).toMatchObject({
      coverage: "NOT_SIMULATABLE",
      reason: expect.stringContaining("VFD_MODBUS_TCP"),
      runtimeOnly: {
        profile: "VFD",
        profileVersion: 1,
        protocol: { kind: "MODBUS_TCP", registerMap: "VFD_MODBUS_TCP", registerMapVersion: 1 },
      },
    });
    for (const [name, profile] of [
      ["Generic contactor, 24 V DC coil", "RELAY"],
      ["Generic heater, contactor-switched", "HEATER"],
      ["Generic stack light, 24 V DC", "INDICATOR"],
      ["Generic temperature controller", "PID_CONTROLLER"],
    ]) {
      expect(byName[name!], name).toMatchObject({
        coverage: "NOT_SIMULATABLE",
        runtimeOnly: { profile, profileVersion: 1 },
      });
    }
    // Nothing else names a protocol: a vendor's register map is never guessed.
    const withProtocol = catalog.models.filter((model) => protocolOf(model) !== null);
    expect(withProtocol.map((model) => model.modelName)).toEqual(["Generic VFD, Modbus TCP"]);
    // The remote I/O station and the gateway say what is missing, not that registers are coming.
    expect(byName["Generic remote I/O station, Modbus TCP"]).toMatchObject({
      coverage: "NOT_SIMULATABLE",
      reason: expect.stringContaining("No behaviour profile"),
    });
  });

  it("maps the two vendor drives onto the generic VFD profile with sourced factory values (TASK-1012)", () => {
    const drives = vendorModels.filter((model) => model.category === "VFD");
    expect(drives.map((model) => [model.manufacturer, model.modelName, model.sku, model.runtimeSupport])).toEqual([
      ["Rockwell Automation", "PowerFlex 525 25B-D010N104", "25B-D010N104", "DEVICE_SIM"],
      ["Schneider Electric", "ATV320U07N4C", "ATV320U07N4C", "DEVICE_SIM"],
    ]);
    for (const drive of drives) {
      const { simulation } = drive;
      expect(simulation.coverage, drive.modelName).toBe("PARTIAL");
      if (simulation.coverage !== "PARTIAL") continue;
      expect(simulation).toMatchObject({
        profile: "VFD",
        profileVersion: 1,
        faults: ["OVERCURRENT", "OVERTEMPERATURE"],
      });
      // The profile implements the ramps, the reversal and the trips; the rest is declared absent.
      expect(simulation.features.filter((f) => f.implemented).map((f) => f.key)).toEqual([
        "LINEAR_RAMP",
        "REVERSAL",
        "TRIP_RESET",
      ]);
      expect(simulation.features.filter((f) => !f.implemented).length).toBeGreaterThanOrEqual(5);
      // Every model-specific fact names its page; every source resolves to a manufacturer document.
      const facts = [
        ...Object.keys(simulation.parameters).map((key) => `parameter:${key}`),
        ...simulation.faults.map((code) => `fault:${code}`),
        ...simulation.features.map((feature) => `feature:${feature.key}`),
      ];
      expect(Object.keys(simulation.sources).sort(), drive.modelName).toEqual(facts.sort());
      for (const [fact, source] of Object.entries(simulation.sources)) {
        expect(source.reference, `${drive.modelName} ${fact}`).toMatch(/pages? \d+/);
        const resolved = resolveFactSource(drive, source);
        expect(resolved.document?.url, `${drive.modelName} ${fact}`).toBeDefined();
        expect(MANUFACTURER_HOSTS).toContain(new URL(resolved.document?.url ?? "").host);
      }
      // The terminals carry the factory assignments of the manual: run, reverse and the reference at least.
      const signals = drive.terminals.map((terminal) => terminal.simulatorSignal).filter(Boolean);
      expect(signals, drive.modelName).toEqual(expect.arrayContaining(["run", "reverse", "frequencySetpoint"]));
    }
    // The factory defaults as the manuals print them.
    const byName = Object.fromEntries(drives.map((drive) => [drive.sku, drive.simulation]));
    expect(byName["25B-D010N104"]).toMatchObject({
      parameters: { maxFrequencyHz: 60, accelTimeS: 10, decelTimeS: 10 },
    });
    expect(byName.ATV320U07N4C).toMatchObject({ parameters: { maxFrequencyHz: 50, accelTimeS: 3, decelTimeS: 3 } });
    // The ATV320 reads its parameters from a second, named document.
    const atv = drives.find((drive) => drive.sku === "ATV320U07N4C");
    expect(atv?.documents.programming?.title).toContain("Programming Manual");
    if (atv?.simulation.coverage === "PARTIAL") {
      const source = atv.simulation.sources["parameter:accelTimeS"];
      if (!source) throw new Error("source missing");
      expect(source.document).toBe("programming");
      expect(source.note).toContain("FrS");
      expect(resolveFactSource(atv, source).document?.title).toContain("Programming Manual");
    }
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
      const generic = model.manufacturer === GENERIC_MANUFACTURER;
      if (model.runtimeSupport === "DEVICE_SIM") {
        expect(model.simulation, model.modelName).toMatchObject({
          // A generic model claims the generic behaviour; a vendor drive declares its features (TASK-1012).
          coverage: generic ? "GENERIC" : "PARTIAL",
          profile: type,
          profileVersion: 1,
        });
      } else {
        expect(model.simulation.coverage, model.modelName).toBe("NOT_SIMULATABLE");
        expect("reason" in model.simulation && model.simulation.reason.length, model.modelName).toBeGreaterThan(10);
      }
    }
    // Nothing in the shipped catalog claims every behaviour of a vendor model.
    expect(new Set(catalog.models.map((model) => model.simulation.coverage))).toEqual(
      new Set(["GENERIC", "PARTIAL", "NOT_SIMULATABLE"]),
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

  it("executes a model only on a profile the server's simulator runs, until TASK-1015", () => {
    const heater = genericModels.models.find((model) => model.modelName === "Generic heater, contactor-switched");
    if (!heater) throw new Error("no generic heater");
    expect(heater.simulation).toMatchObject({ coverage: "NOT_SIMULATABLE", reason: expect.stringContaining("HEATER") });
    expectRejected(
      {
        ...genericModels,
        models: [{ ...heater, runtimeSupport: "DEVICE_SIM", simulation: simulated("HEATER") }],
      },
      /does not run this behaviour profile yet/,
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
    expect(parseCatalog(withDrive(simulated("VFD"), false)).models).toHaveLength(3);
    // … but a model-specific fact (a value, a feature, a supported fault) needs its verified provenance.
    expectRejected(
      withDrive(simulated("VFD", [], { parameters: { maxFrequencyHz: 60 } }), false),
      /VERIFIED provenance/,
    );
    expectRejected(withDrive(simulated("VFD", ["OVERCURRENT"]), false), /VERIFIED provenance/);
    expectRejected(withDrive(withFeatures("PARTIAL", features), false), /VERIFIED provenance/);
    expect(parseCatalog(withDrive(withFeatures("PARTIAL", features))).models[2]?.simulation).toMatchObject({
      coverage: "PARTIAL",
    });
  });

  it("wants a source for every model-specific fact of a vendor model, and no stray source (TASK-1012)", () => {
    const source = { reference: "P044 [Maximum Freq], page 87" };
    // A parameter value without its source.
    expectRejected(
      withDrive(simulated("VFD", [], { parameters: { maxFrequencyHz: 60 } })),
      /names the manufacturer document it was read from/,
    );
    // A supported fault without its source.
    expectRejected(withDrive(simulated("VFD", ["OVERCURRENT"])), /names the manufacturer document it was read from/);
    // A declared feature without its source.
    const features = [
      { key: "LINEAR_RAMP", label: "Linear ramps", implemented: true },
      { key: "PID", label: "Built-in PID", implemented: false },
    ];
    expectRejected(
      withDrive({
        coverage: "PARTIAL",
        profile: "VFD",
        profileVersion: 1,
        features,
        sources: { "feature:LINEAR_RAMP": source },
      }),
      /names the manufacturer document it was read from/,
    );
    // A source for a fact the model does not declare.
    expectRejected(
      withDrive(simulated("VFD", [], { sources: { "parameter:maxFrequencyHz": source } })),
      /names a parameter, feature or fault the model does not declare/,
    );
    // A source naming a document the model does not list.
    expectRejected(
      withDrive(
        simulated("VFD", [], {
          parameters: { maxFrequencyHz: 60 },
          sources: { "parameter:maxFrequencyHz": { ...source, document: "programming" } },
        }),
      ),
      /names a document the model does not list/,
    );
    // Complete: the value, its source, and a second document for another fact.
    const programming = {
      url: "https://cache.industry.siemens.com/dl/files/test/test-drive-parameters.pdf",
      title: "Test drive parameter manual",
      revision: "A5E00000001-AA, 01/2026",
      retrievedAt: "2026-10-05",
    };
    const complete = parseCatalog({
      ...siemens,
      models: [
        ...siemens.models,
        {
          ...vendorDrive(
            simulated("VFD", ["OVERCURRENT"], {
              parameters: { maxFrequencyHz: 60 },
              sources: {
                "parameter:maxFrequencyHz": source,
                "fault:OVERCURRENT": { document: "programming", reference: "F012, page 161", note: "one trip" },
              },
            }),
          ),
          documents: { programming },
        },
      ],
    });
    const drive = complete.models[2];
    if (!drive || drive.simulation.coverage === "NOT_SIMULATABLE") throw new Error("drive missing");
    const sourceOf = (fact: string) => {
      const found = drive.simulation.coverage !== "NOT_SIMULATABLE" && drive.simulation.sources[fact];
      if (!found) throw new Error(`no source for ${fact}`);
      return found;
    };
    // Resolved: the model's own source unless a document is named.
    expect(resolveFactSource(drive, sourceOf("parameter:maxFrequencyHz"))).toEqual({
      reference: "P044 [Maximum Freq], page 87",
      note: null,
      document: expect.objectContaining({ title: "Test drive operating instructions" }),
    });
    expect(resolveFactSource(drive, sourceOf("fault:OVERCURRENT"))).toEqual({
      reference: "F012, page 161",
      note: "one trip",
      document: programming,
    });
  });

  it("lets a generic model state no vendor fact: no sources, no documents, no firmware", () => {
    expectRejected(
      withModel(genericModels, (model) => ({
        ...model,
        simulation: simulated("VFD", [], { sources: { "parameter:maxFrequencyHz": { reference: "nowhere" } } }),
      })),
      /names no source for one/,
    );
    expectRejected(
      withModel(genericModels, (model) => ({
        ...model,
        documents: {
          manual: {
            url: "https://cache.industry.siemens.com/dl/files/test/x.pdf",
            title: "A vendor manual",
            revision: "1",
            retrievedAt: "2026-10-05",
          },
        },
      })),
      /A generic model has no manufacturer documents/,
    );
    // Nothing deploys firmware to a behaviour model, vendor or generic.
    expectRejected(
      withModel(genericModels, (model) => ({
        ...model,
        capabilities: [...(model.capabilities ?? []), "FIRMWARE_DEPLOYABLE"],
      })),
      /no firmware is deployed to it/,
    );
    expectRejected(
      withDrive(simulated("VFD"), true, ["PARAMETER_CONFIGURABLE", "FIRMWARE_DEPLOYABLE"]),
      /no firmware is deployed to it/,
    );
  });

  it("serves a protocol device only on a declared register map of its profile, through a port (TASK-1013)", () => {
    const modbus = { kind: "MODBUS_TCP" as const, registerMap: "VFD_MODBUS_TCP", registerMapVersion: 1 };
    const port = { name: "Ethernet", physicalType: "Ethernet", protocols: ["MODBUS_TCP" as const] };
    const served = (protocol: Record<string, unknown>, ports: Array<typeof port> = [port]): CatalogInput => ({
      ...siemens,
      models: [
        ...siemens.models,
        {
          ...vendorDrive(simulated("VFD", [], { protocol: { ...modbus, ...protocol } as never })),
          ports,
          capabilities: ports.length > 0 ? ["PARAMETER_CONFIGURABLE", "MODBUS_SERVER"] : ["PARAMETER_CONFIGURABLE"],
        },
      ],
    });
    expect(parseCatalog(served({})).models[2]?.simulation).toMatchObject({ protocol: modbus });
    expectRejected(served({ registerMap: "PUMP_MODBUS_TCP" }), /not declared; vendor maps are never guessed/);
    expectRejected(served({ registerMapVersion: 2 }), /not declared/);
    expectRejected(served({}, []), /communication port for it/);
    // A map of another profile is refused; so is a protocol kind the catalog does not know.
    expectRejected(
      withModel(genericModels, (model) => ({
        ...model,
        modelName: "Generic pump, Modbus",
        family: "Generic pumps",
        category: "PUMP",
        ports: [port],
        terminals: [],
        simulation: simulated("PUMP", [], { protocol: modbus }),
      })),
      /map of its behaviour profile/,
    );
    expect(() => parseCatalog(served({ kind: "PROFINET" }))).toThrow();
    // A NOT_SIMULATABLE model may name what the runtime runs for it, under the same rules.
    const runtimeOnly = (block: Record<string, unknown>): CatalogInput =>
      withModel(genericModels, (model) => ({
        ...model,
        runtimeSupport: "NONE",
        terminals: [],
        ports: [port],
        simulation: { coverage: "NOT_SIMULATABLE", reason: "test: the runtime runs it", runtimeOnly: block } as never,
      }));
    expect(
      parseCatalog(runtimeOnly({ profile: "VFD", profileVersion: 1, protocol: modbus })).models[0]?.simulation,
    ).toMatchObject({ coverage: "NOT_SIMULATABLE", runtimeOnly: { profile: "VFD", protocol: modbus } });
    expectRejected(runtimeOnly({ profile: "BOILER", profileVersion: 1 }), /runtime profile/);
    expectRejected(runtimeOnly({ profile: "PUMP", profileVersion: 1 }), /runtime profile is the one of its category/);
    expectRejected(
      runtimeOnly({ profile: "VFD", profileVersion: 1, protocol: { ...modbus, registerMap: "X" } }),
      /never guessed/,
    );
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
