import "server-only";
import { strToU8, zipSync } from "fflate";
import { DomainError } from "@/lib/domain/errors";

/**
 * The upload bundle of the OpenPLC Runtime v4, composed the way the OpenPLC Editor does
 * (`composeRuntimeV4Bundle`). The runtime extracts it into `core/generated/`, builds a
 * shared library from the sources and enables the plugins that have a file under `conf/`.
 */

/** Port the Modbus TCP server listens on inside the container. */
export const MODBUS_CONTAINER_PORT = 502;
/** Port of the runtime's HTTPS REST API inside the container. */
export const API_CONTAINER_PORT = 8443;

/**
 * Modbus slave plugin configuration. The address mapping is fixed by the runtime:
 * %QX → coils, %IX → discrete inputs, %IW → input registers, %QW → holding registers,
 * followed by the %MW, %MD and %ML memory segments in the holding registers.
 */
export function modbusSlaveConfig(): string {
  return JSON.stringify(
    {
      network_configuration: { host: "0.0.0.0", port: MODBUS_CONTAINER_PORT },
      buffer_mapping: {
        holding_registers: { qw_count: 1024, mw_count: 1024, md_count: 1024, ml_count: 1024 },
        coils: { qx_bits: 8192, mx_bits: 8192 },
        discrete_inputs: { ix_bits: 8192 },
        input_registers: { iw_count: 1024 },
      },
      word_order: "high_word_first",
    },
    null,
    2,
  );
}

/** Modbus function codes the runtime's master uses per Modbus area (reads) and per kind of write. */
const READ_FUNCTION = { COIL: 1, DISCRETE_INPUT: 2, HOLDING_REGISTER: 3, INPUT_REGISTER: 4 } as const;

/** One value the PLC exchanges as a Modbus master with a peer (TASK-703). */
export type ModbusMasterPoint = {
  operation: "READ" | "WRITE";
  /** The peer's area and zero-based address. */
  remoteArea: keyof typeof READ_FUNCTION;
  remoteAddress: number;
  /** Where the value sits in this PLC: `%IX10.0`, `%MW20`, `%QX101.0`… */
  localAddress: string;
  cycleTimeMs: number;
};

/** One peer server the PLC talks to: its name on the factory network, port and unit id. */
export type ModbusMasterDevice = {
  name: string;
  host: string;
  port: number;
  unitId: number;
  timeoutMs: number;
  points: ModbusMasterPoint[];
};

/**
 * Modbus master plugin configuration (TASK-703): the PLC's own runtime is the client of a
 * PLC-to-PLC link. Each point copies raw bits or words between the peer's registers and this
 * PLC's image every `cycle_time_ms`; a READ that fails leaves the last value in place.
 */
export function modbusMasterConfig(devices: readonly ModbusMasterDevice[]): string {
  return JSON.stringify(
    devices.map((device) => ({
      name: device.name,
      protocol: "MODBUS",
      config: {
        type: "SLAVE",
        transport: "tcp",
        host: device.host,
        port: device.port,
        slave_id: device.unitId,
        timeout_ms: device.timeoutMs,
        io_points: device.points.map((point) => ({
          fc: point.operation === "READ" ? READ_FUNCTION[point.remoteArea] : point.remoteArea === "COIL" ? 5 : 6,
          offset: String(point.remoteAddress),
          iec_location: point.localAddress,
          len: 1,
          cycle_time_ms: point.cycleTimeMs,
          error_handling: "keep-last-value",
        })),
      },
    })),
    null,
    2,
  );
}

const REQUIRED_FILES = ["generated.hpp", "generated_debug.cpp"];

export function composeProgramBundle(input: {
  source: string;
  md5: string;
  /** Output of the STruC++ compile: generated sources plus `strucpp_runtime/include/*`. */
  compiledFiles: Record<string, string>;
  /** The PLC's links as a Modbus master (TASK-703); the plugin is enabled only when there is one. */
  modbusMaster?: readonly ModbusMasterDevice[];
}): Record<string, string> {
  for (const required of REQUIRED_FILES) {
    if (!(required in input.compiledFiles)) {
      // Without the debug tables the runtime builds the library but cannot load it.
      throw new DomainError("INVARIANT", `The compiled program is missing ${required}.`, { rule: "bundle-complete" });
    }
  }
  if (!Object.keys(input.compiledFiles).some((name) => name.startsWith("strucpp_runtime/include/"))) {
    throw new DomainError("INVARIANT", "The compiled program is missing the runtime headers.", {
      rule: "bundle-complete",
    });
  }

  return {
    "program.st": input.source,
    ...input.compiledFiles,
    "defines.h": `#pragma once\n// Program MD5\n#define PROGRAM_MD5 "${input.md5}"\n`,
    // No C/C++ function blocks: the editor ships this stub in that case.
    "c_blocks.h": "// Empty file\n",
    "conf/modbus_slave.json": modbusSlaveConfig(),
    ...(input.modbusMaster && input.modbusMaster.length > 0
      ? { "conf/modbus_master.json": modbusMasterConfig(input.modbusMaster) }
      : {}),
  };
}

export function zipBundle(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) entries[name] = strToU8(content);
  return zipSync(entries, { level: 6 });
}
