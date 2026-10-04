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

const REQUIRED_FILES = ["generated.hpp", "generated_debug.cpp"];

export function composeProgramBundle(input: {
  source: string;
  md5: string;
  /** Output of the STruC++ compile: generated sources plus `strucpp_runtime/include/*`. */
  compiledFiles: Record<string, string>;
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
  };
}

export function zipBundle(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) entries[name] = strToU8(content);
  return zipSync(entries, { level: 6 });
}
