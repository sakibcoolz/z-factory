import { describe, expect, it } from "vitest";
import { GENERIC_CATEGORIES } from "@/lib/catalog/generic-categories";
import * as prismaEnums from "@/lib/generated/prisma/enums";
import {
  CONNECTION_RELATIONSHIPS,
  DRIVE_CATEGORY_CODES,
  ENDPOINT_TYPES,
  IO_DIRECTIONS,
  IO_POINT_SOURCES,
  IO_POINT_STATUSES,
  IO_POINT_TYPES,
  IO_SIGNAL_CLASSES,
  MOTOR_CATEGORY_CODE,
  MOTOR_CATEGORY_CODES,
  PLC_ARCHITECTURES,
  PLC_CATEGORY_CODE,
} from "./device";
import { PROGRAM_VERSION_STATUSES } from "./plc-runtime-view";
import { MODULE_SIGNAL_DIRECTIONS } from "./process-module";
import { RUNTIME_STATES } from "./runtime-state";
import { ACCESS_MODES, MODBUS_AREAS, TAG_DATA_TYPES, TAG_QUALITIES, TAG_ROLES } from "./tag";

const sorted = (values: readonly string[]) => [...values].sort();

/** The domain vocabulary and the database enums must not drift apart. */
describe("domain enums match the database schema", () => {
  it.each([
    ["PlcArchitecture", PLC_ARCHITECTURES, prismaEnums.PlcArchitecture],
    ["IoPointType", IO_POINT_TYPES, prismaEnums.IoPointType],
    ["IoDirection", IO_DIRECTIONS, prismaEnums.IoDirection],
    ["IoSignalClass", IO_SIGNAL_CLASSES, prismaEnums.IoSignalClass],
    ["IoPointSource", IO_POINT_SOURCES, prismaEnums.IoPointSource],
    ["IoPointStatus", IO_POINT_STATUSES, prismaEnums.IoPointStatus],
    ["ConnectionRelationship", CONNECTION_RELATIONSHIPS, prismaEnums.ConnectionRelationship],
    ["EndpointType", ENDPOINT_TYPES, prismaEnums.EndpointType],
    ["RuntimeState", RUNTIME_STATES, prismaEnums.RuntimeState],
    ["ProgramVersionStatus", PROGRAM_VERSION_STATUSES, prismaEnums.ProgramVersionStatus],
    ["TagRole", TAG_ROLES, prismaEnums.TagRole],
    ["TagQuality", TAG_QUALITIES, prismaEnums.TagQuality],
    ["TagDataType", TAG_DATA_TYPES, prismaEnums.TagDataType],
    ["AccessMode", ACCESS_MODES, prismaEnums.AccessMode],
    ["ModbusArea", MODBUS_AREAS, prismaEnums.ModbusArea],
    ["ModuleSignalDirection", MODULE_SIGNAL_DIRECTIONS, prismaEnums.ModuleSignalDirection],
  ] as const)("%s", (_name, domainValues, prismaEnum) => {
    expect(sorted(domainValues)).toEqual(sorted(Object.values(prismaEnum)));
  });
});

describe("generic category seed", () => {
  const codes = GENERIC_CATEGORIES.map((category) => category.code);

  it("has unique codes and still covers the original categories", () => {
    expect(new Set(codes).size).toBe(codes.length);
    // The full list, including controllers and intermediate devices, is checked in lib/catalog/catalog.test.ts.
    expect(codes).toEqual(
      expect.arrayContaining([
        "PLC",
        "VFD",
        "MOTOR",
        "PUMP",
        "FAN",
        "BLOWER",
        "CONVEYOR",
        "MIXER",
        "COMPRESSOR",
        "VALVE",
        "SENSOR",
        "SWITCH",
        "RELAY",
        "CONTACTOR",
        "ENCODER",
        "REMOTE_IO",
        "GATEWAY",
      ]),
    );
  });

  it("contains the categories the domain rules refer to", () => {
    for (const code of [PLC_CATEGORY_CODE, MOTOR_CATEGORY_CODE, ...MOTOR_CATEGORY_CODES, ...DRIVE_CATEGORY_CODES]) {
      expect(codes).toContain(code);
    }
  });

  it("marks only driven equipment as requiring a motor", () => {
    const requiresMotor = GENERIC_CATEGORIES.filter((category) => category.requiresMotor).map((c) => c.code);
    expect(sorted(requiresMotor)).toEqual(sorted(["PUMP", "FAN", "BLOWER", "CONVEYOR", "MIXER", "COMPRESSOR"]));
  });
});
