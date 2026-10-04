import { describe, expect, it } from "vitest";
import { DomainError, type DomainErrorCode } from "@/lib/domain/errors";
import {
  assertConnectionAllowed,
  assertIoPointAvailable,
  assertSignalCompatible,
  requiredIoPointType,
} from "./connection";
import { parseInput } from "./parse";
import {
  assertIoPointSource,
  assertModelArchitecture,
  assertModulePlacement,
  assertRackAllowed,
} from "./plc-architecture";
import { connectionInputSchema, deviceNameSchema, factoryInputSchema, subnetCidrSchema } from "./schemas";
import { assertNoAddressOverlap, assertTagAccess, assertTagArea } from "./tag";

function expectDomainError(action: () => unknown, code: DomainErrorCode, rule?: string) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
    if (rule) expect((error as DomainError).details.rule).toBe(rule);
    return;
  }
  expect.unreachable("expected a DomainError");
}

describe("compact vs modular PLC rules", () => {
  it("requires every PLC model to declare an architecture", () => {
    expectDomainError(
      () => assertModelArchitecture({ categoryCode: "PLC", architectureType: null }),
      "VALIDATION",
      "plc-architecture-required",
    );
    expect(() => assertModelArchitecture({ categoryCode: "PLC", architectureType: "COMPACT" })).not.toThrow();
    expect(() => assertModelArchitecture({ categoryCode: "PLC", architectureType: "MODULAR" })).not.toThrow();
  });

  it("keeps architecture off non-PLC models", () => {
    expectDomainError(
      () => assertModelArchitecture({ categoryCode: "VFD", architectureType: "COMPACT" }),
      "VALIDATION",
      "architecture-plc-only",
    );
    expect(() => assertModelArchitecture({ categoryCode: "VFD", architectureType: null })).not.toThrow();
  });

  it("gives racks to modular PLCs only", () => {
    expectDomainError(() => assertRackAllowed("COMPACT"), "INCOMPATIBLE", "rack-modular-only");
    expect(() => assertRackAllowed("MODULAR")).not.toThrow();
  });

  it("takes compact I/O from built-in channels only", () => {
    expectDomainError(
      () => assertIoPointSource({ architecture: "COMPACT", sourceType: "MODULE", cpuHasOnboardIo: true }),
      "INCOMPATIBLE",
      "compact-built-in-only",
    );
    expect(() =>
      assertIoPointSource({ architecture: "COMPACT", sourceType: "BUILT_IN", cpuHasOnboardIo: true }),
    ).not.toThrow();
  });

  it("takes modular I/O from modules unless the CPU documents onboard I/O", () => {
    expect(() =>
      assertIoPointSource({ architecture: "MODULAR", sourceType: "MODULE", cpuHasOnboardIo: false }),
    ).not.toThrow();
    expectDomainError(
      () => assertIoPointSource({ architecture: "MODULAR", sourceType: "BUILT_IN", cpuHasOnboardIo: false }),
      "INCOMPATIBLE",
      "built-in-requires-onboard-io",
    );
    expect(() =>
      assertIoPointSource({ architecture: "MODULAR", sourceType: "BUILT_IN", cpuHasOnboardIo: true }),
    ).not.toThrow();
  });

  describe("module placement", () => {
    const placement = {
      cpuModelId: "cpu-a",
      rackSlotCount: 8,
      occupiedSlots: [0, 1],
      compatibility: [{ cpuModelId: "cpu-a", minSlot: 2, maxSlot: 6 }],
    };

    it("accepts a compatible module in a free slot inside its range", () => {
      expect(() => assertModulePlacement({ ...placement, slotIndex: 2 })).not.toThrow();
      expect(() => assertModulePlacement({ ...placement, slotIndex: 6 })).not.toThrow();
    });

    it("rejects a slot outside the rack", () => {
      expectDomainError(() => assertModulePlacement({ ...placement, slotIndex: 8 }), "VALIDATION", "slot-in-range");
      expectDomainError(() => assertModulePlacement({ ...placement, slotIndex: -1 }), "VALIDATION", "slot-in-range");
    });

    it("rejects an occupied slot", () => {
      expectDomainError(() => assertModulePlacement({ ...placement, slotIndex: 1 }), "OCCUPIED_ENDPOINT", "slot-free");
    });

    it("rejects a module from another CPU family", () => {
      expectDomainError(
        () => assertModulePlacement({ ...placement, cpuModelId: "cpu-b", slotIndex: 3 }),
        "INCOMPATIBLE",
        "module-cpu-compatible",
      );
    });

    it("enforces the module's slot range", () => {
      expectDomainError(
        () => assertModulePlacement({ ...placement, slotIndex: 7 }),
        "INCOMPATIBLE",
        "module-slot-range",
      );
    });

    it("treats a missing slot range as unrestricted", () => {
      const anySlot = { ...placement, compatibility: [{ cpuModelId: "cpu-a", minSlot: null, maxSlot: null }] };
      expect(() => assertModulePlacement({ ...anySlot, slotIndex: 7 })).not.toThrow();
    });
  });
});

describe("connection invariants", () => {
  const device = (id: string, categoryCode: string, requiresMotor = false) => ({
    id,
    factoryId: "factory-1",
    categoryCode,
    requiresMotor,
  });
  const base = { factoryId: "factory-1", sourceDrivesCount: 0, targetDrivenByCount: 0 };

  it("maps a device signal to the PLC point class that receives it", () => {
    expect(requiredIoPointType("OUTPUT", "ANALOG")).toBe("AI");
    expect(requiredIoPointType("INPUT", "ANALOG")).toBe("AO");
    expect(requiredIoPointType("OUTPUT", "DIGITAL")).toBe("DI");
    expect(requiredIoPointType("INPUT", "DIGITAL")).toBe("DO");
  });

  it("rejects wiring to the wrong point class", () => {
    expectDomainError(
      () =>
        assertSignalCompatible(
          { direction: "OUTPUT", ioType: "ANALOG", signalType: "CURRENT_4_20MA" },
          { ioType: "DI", signalType: "CURRENT_4_20MA" },
        ),
      "INCOMPATIBLE",
      "io-point-type",
    );
  });

  it("rejects an incompatible signal type on the right point class", () => {
    expectDomainError(
      () =>
        assertSignalCompatible(
          { direction: "OUTPUT", ioType: "ANALOG", signalType: "CURRENT_4_20MA" },
          { ioType: "AI", signalType: "VOLTAGE_0_10V" },
        ),
      "INCOMPATIBLE",
      "signal-type",
    );
    expect(() =>
      assertSignalCompatible(
        { direction: "OUTPUT", ioType: "ANALOG", signalType: "CURRENT_4_20MA" },
        { ioType: "AI", signalType: "CURRENT_4_20MA" },
      ),
    ).not.toThrow();
  });

  it("only wires free I/O points", () => {
    expect(() => assertIoPointAvailable({ logicalAddress: "%IW100", status: "FREE" })).not.toThrow();
    for (const status of ["OCCUPIED", "RESERVED", "DISABLED"] as const) {
      expectDomainError(
        () => assertIoPointAvailable({ logicalAddress: "%IW100", status }),
        "OCCUPIED_ENDPOINT",
        "io-point-free",
      );
    }
  });

  it("rejects a self connection and a cross-factory connection", () => {
    const vfd = device("a", "VFD");
    expectDomainError(
      () => assertConnectionAllowed({ ...base, relationship: "COMMUNICATES_WITH", source: vfd, target: vfd }),
      "VALIDATION",
      "distinct-devices",
    );
    expectDomainError(
      () =>
        assertConnectionAllowed({
          ...base,
          relationship: "COMMUNICATES_WITH",
          source: vfd,
          target: { ...device("b", "PLC"), factoryId: "factory-2" },
        }),
      "VALIDATION",
      "same-factory",
    );
  });

  it("lets a VFD drive exactly one motor", () => {
    const vfd = device("vfd", "VFD");
    const motor = device("motor", "MOTOR");
    expect(() =>
      assertConnectionAllowed({ ...base, relationship: "DRIVES", source: vfd, target: motor }),
    ).not.toThrow();
    expectDomainError(
      () =>
        assertConnectionAllowed({ ...base, relationship: "DRIVES", source: vfd, target: motor, sourceDrivesCount: 1 }),
      "INVARIANT",
      "one-motor-per-drive",
    );
    expectDomainError(
      () =>
        assertConnectionAllowed({
          ...base,
          relationship: "DRIVES",
          source: vfd,
          target: motor,
          targetDrivenByCount: 1,
        }),
      "INVARIANT",
      "one-drive-per-motor",
    );
  });

  it("restricts DRIVES to drive -> motor", () => {
    expectDomainError(
      () =>
        assertConnectionAllowed({
          ...base,
          relationship: "DRIVES",
          source: device("plc", "PLC"),
          target: device("motor", "MOTOR"),
        }),
      "INCOMPATIBLE",
      "drives-source",
    );
    expectDomainError(
      () =>
        assertConnectionAllowed({
          ...base,
          relationship: "DRIVES",
          source: device("vfd", "VFD"),
          target: device("pump", "PUMP", true),
        }),
      "INCOMPATIBLE",
      "drives-target",
    );
  });

  it("restricts MECHANICALLY_DRIVES to motor -> motor-driven equipment", () => {
    const motor = device("motor", "MOTOR");
    expect(() =>
      assertConnectionAllowed({
        ...base,
        relationship: "MECHANICALLY_DRIVES",
        source: motor,
        target: device("pump", "PUMP", true),
      }),
    ).not.toThrow();
    expectDomainError(
      () =>
        assertConnectionAllowed({
          ...base,
          relationship: "MECHANICALLY_DRIVES",
          source: device("vfd", "VFD"),
          target: device("pump", "PUMP", true),
        }),
      "INCOMPATIBLE",
      "mechanical-source",
    );
    expectDomainError(
      () =>
        assertConnectionAllowed({
          ...base,
          relationship: "MECHANICALLY_DRIVES",
          source: motor,
          target: device("sensor", "SENSOR"),
        }),
      "INCOMPATIBLE",
      "mechanical-target",
    );
  });
});

describe("tag invariants", () => {
  it("allows write access on command and setpoint tags only", () => {
    expect(() => assertTagAccess({ role: "COMMAND", accessMode: "READ_WRITE" })).not.toThrow();
    expect(() => assertTagAccess({ role: "SETPOINT", accessMode: "READ_WRITE" })).not.toThrow();
    for (const role of ["FEEDBACK", "STATUS", "ALARM", "PROCESS_VALUE"] as const) {
      expectDomainError(() => assertTagAccess({ role, accessMode: "READ_WRITE" }), "INVARIANT", "writable-role");
      expect(() => assertTagAccess({ role, accessMode: "READ_ONLY" })).not.toThrow();
    }
  });

  it("refuses write access in read-only Modbus areas", () => {
    expectDomainError(
      () => assertTagAccess({ role: "SETPOINT", accessMode: "READ_WRITE", protocolArea: "INPUT_REGISTER" }),
      "INCOMPATIBLE",
      "writable-area",
    );
    expect(() =>
      assertTagAccess({ role: "SETPOINT", accessMode: "READ_WRITE", protocolArea: "HOLDING_REGISTER" }),
    ).not.toThrow();
  });

  it("keeps BOOL in bit areas and numbers in register areas", () => {
    expect(() => assertTagArea({ dataType: "BOOL", protocolArea: "COIL" })).not.toThrow();
    expect(() => assertTagArea({ dataType: "FLOAT32", protocolArea: "HOLDING_REGISTER" })).not.toThrow();
    expectDomainError(
      () => assertTagArea({ dataType: "BOOL", protocolArea: "HOLDING_REGISTER" }),
      "INCOMPATIBLE",
      "data-type-area",
    );
    expectDomainError(
      () => assertTagArea({ dataType: "UINT16", protocolArea: "COIL" }),
      "INCOMPATIBLE",
      "data-type-area",
    );
  });

  it("detects overlapping multi-word register ranges", () => {
    const existing = [
      { name: "VFD01_FrequencySetpoint", protocolArea: "HOLDING_REGISTER", protocolAddress: 1, dataType: "FLOAT32" },
    ] as const;
    // FLOAT32 at 1 occupies registers 1–2.
    expectDomainError(
      () =>
        assertNoAddressOverlap(
          { name: "Other", protocolArea: "HOLDING_REGISTER", protocolAddress: 2, dataType: "UINT16" },
          existing,
        ),
      "CONFLICT",
      "address-overlap",
    );
    expect(() =>
      assertNoAddressOverlap(
        { name: "Other", protocolArea: "HOLDING_REGISTER", protocolAddress: 3, dataType: "UINT16" },
        existing,
      ),
    ).not.toThrow();
    // Same address in a different area does not collide.
    expect(() =>
      assertNoAddressOverlap(
        { name: "Other", protocolArea: "INPUT_REGISTER", protocolAddress: 1, dataType: "FLOAT32" },
        existing,
      ),
    ).not.toThrow();
  });
});

describe("input schemas", () => {
  it("accepts canonical private subnets", () => {
    for (const cidr of ["172.20.1.0/24", "10.0.0.0/16", "192.168.10.0/28"]) {
      expect(subnetCidrSchema.safeParse(cidr).success).toBe(true);
    }
  });

  it("rejects public ranges, host bits, bad octets and extreme prefixes", () => {
    for (const cidr of [
      "8.8.8.0/24",
      "172.20.1.5/24",
      "172.20.300.0/24",
      "10.0.0.0/8",
      "172.20.1.0/30",
      "not-a-cidr",
    ]) {
      expect(subnetCidrSchema.safeParse(cidr).success, cidr).toBe(false);
    }
  });

  it("validates factory input and trims text", () => {
    const parsed = factoryInputSchema.parse({
      name: "  Pump House Demo ",
      slug: "pump-house-demo",
      subnetCidr: "172.20.1.0/24",
    });
    expect(parsed.name).toBe("Pump House Demo");
    expect(factoryInputSchema.safeParse({ name: "", slug: "Bad Slug", subnetCidr: "172.20.1.0/24" }).success).toBe(
      false,
    );
  });

  it("accepts industrial instance names and rejects unsafe ones", () => {
    for (const name of ["VFD-01", "PT-101", "S7-1200-1214C-01", "gateway_01"]) {
      expect(deviceNameSchema.safeParse(name).success, name).toBe(true);
    }
    for (const name of ["", "-leading", "has space", "semi;colon", "../etc"]) {
      expect(deviceNameSchema.safeParse(name).success, name).toBe(false);
    }
  });

  it("requires a reference for non-device endpoints", () => {
    const id = "01a107ff-de99-71ec-adbb-40049a4cf552";
    const input = {
      factoryId: id,
      relationship: "MEASURES",
      source: { deviceId: id },
      target: { deviceId: id, endpointType: "PLC_IO_POINT" },
    };
    expect(connectionInputSchema.safeParse(input).success).toBe(false);
    expect(connectionInputSchema.safeParse({ ...input, target: { ...input.target, endpointRef: id } }).success).toBe(
      true,
    );
  });

  it("turns schema failures into VALIDATION domain errors with the field path", () => {
    try {
      parseInput(factoryInputSchema, { name: "x", slug: "ok", subnetCidr: "8.8.8.0/24" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe("VALIDATION");
      expect((error as DomainError).message).toMatch(/^subnetCidr: /);
    }
  });
});
