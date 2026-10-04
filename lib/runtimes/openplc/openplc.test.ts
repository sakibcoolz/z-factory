// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { DomainError, type DomainErrorCode } from "@/lib/domain/errors";
import { readModbus, writeModbus } from "@/lib/protocols/modbus/client";
import { serviceNameFor, summarizeRuntimeStates } from "@/lib/services/plc-runtime-service";
import { healthState } from "./adapter";
import { composeProgramBundle, modbusSlaveConfig, zipBundle } from "./bundle";
import { OpenPlcClient } from "./client";
import { compileStructuredText } from "./compiler";
import { resolveRuntimeSecret, runtimeCredentials } from "./credentials";

const PROGRAM = `PROGRAM main
  VAR
    Start AT %QX0.0 : BOOL;
    Setpoint AT %QW0 : INT;
  END_VAR
  IF Start THEN
    Setpoint := 45;
  ELSE
    Setpoint := 0;
  END_IF;
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#50ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : main;
  END_RESOURCE
END_CONFIGURATION
`;

async function expectDomainError(action: Promise<unknown> | (() => unknown), code: DomainErrorCode, rule?: string) {
  const error = await Promise.resolve()
    .then(() => (typeof action === "function" ? action() : action))
    .then(
      () => undefined,
      (reason: unknown) => reason,
    );
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe(code);
  if (rule) expect((error as DomainError).details.rule).toBe(rule);
}

describe("server-only boundary", () => {
  it.each(["lib/runtimes/openplc", "lib/protocols/modbus"])("marks every module in %s as server-only", (relative) => {
    const directory = join(process.cwd(), relative);
    const modules = readdirSync(directory).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
    expect(modules.length).toBeGreaterThan(0);
    for (const file of modules) {
      expect(readFileSync(join(directory, file), "utf8").split("\n")[0], file).toBe('import "server-only";');
    }
  });

  it("keeps the GPL compiler out of the server process", () => {
    const directory = join(process.cwd(), "lib/runtimes/openplc");
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
      // Only the stand-alone worker script may import STruC++.
      expect(readFileSync(join(directory, file), "utf8"), file).not.toMatch(/from "strucpp"|import\("strucpp"\)/);
    }
  });
});

describe("structured text compiler", () => {
  it("compiles a program into the sources and headers the runtime builds", async () => {
    const result = await compileStructuredText(PROGRAM);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.compilerVersion).toBe("0.7.0");
    expect(result.md5).toMatch(/^[0-9a-f]{32}$/);
    const names = Object.keys(result.files);
    expect(names).toEqual(expect.arrayContaining(["generated.hpp", "generated_debug.cpp", "debug-map.json"]));
    expect(names.some((name) => name.endsWith(".cpp") && name !== "generated_debug.cpp")).toBe(true);
    expect(names.filter((name) => name.startsWith("strucpp_runtime/include/")).length).toBeGreaterThan(10);
  }, 60_000);

  it("reports diagnostics with positions for a program that does not compile", async () => {
    const result = await compileStructuredText(PROGRAM.replace("Setpoint := 45;", "Setpoint := Unknown_Tag + ;"));

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatchObject({ severity: "error" });
    expect(result.errors[0]?.line).toBeGreaterThan(0);
  }, 60_000);

  it("refuses an oversized source before starting the compiler", async () => {
    await expectDomainError(compileStructuredText("x".repeat(1024 * 1024 + 1)), "VALIDATION", "program-size");
  });
});

describe("program bundle", () => {
  const compiledFiles = {
    "pou_MAIN.cpp": "// pou",
    "generated.hpp": "// header",
    "generated_debug.cpp": "// debug tables",
    "strucpp_runtime/include/iec_types.hpp": "// runtime header",
  };

  it("lays out the bundle the way the runtime expects", () => {
    const bundle = composeProgramBundle({ source: PROGRAM, md5: "abc123", compiledFiles });

    expect(Object.keys(bundle).sort()).toEqual(
      [
        "c_blocks.h",
        "conf/modbus_slave.json",
        "defines.h",
        "generated.hpp",
        "generated_debug.cpp",
        "pou_MAIN.cpp",
        "program.st",
        "strucpp_runtime/include/iec_types.hpp",
      ].sort(),
    );
    expect(bundle["program.st"]).toBe(PROGRAM);
    expect(bundle["defines.h"]).toContain('#define PROGRAM_MD5 "abc123"');
  });

  it("refuses a bundle the runtime could build but not load", () => {
    const { "generated_debug.cpp": _debug, ...withoutDebug } = compiledFiles;
    expectDomainError(
      () => composeProgramBundle({ source: PROGRAM, md5: "abc", compiledFiles: withoutDebug }),
      "INVARIANT",
      "bundle-complete",
    );
    const { "strucpp_runtime/include/iec_types.hpp": _header, ...withoutHeaders } = compiledFiles;
    expectDomainError(
      () => composeProgramBundle({ source: PROGRAM, md5: "abc", compiledFiles: withoutHeaders }),
      "INVARIANT",
      "bundle-complete",
    );
  });

  it("enables the Modbus server on port 502 with the fixed located-variable mapping", () => {
    const config = JSON.parse(modbusSlaveConfig());
    expect(config.network_configuration).toEqual({ host: "0.0.0.0", port: 502 });
    expect(config.buffer_mapping.coils.qx_bits).toBe(8192);
    expect(config.buffer_mapping.holding_registers.qw_count).toBe(1024);
    expect(config.word_order).toBe("high_word_first");
  });

  it("zips the bundle losslessly", () => {
    const bundle = composeProgramBundle({ source: PROGRAM, md5: "abc", compiledFiles });
    const unzipped = unzipSync(zipBundle(bundle));
    expect(Object.keys(unzipped).sort()).toEqual(Object.keys(bundle).sort());
    expect(new TextDecoder().decode(unzipped["program.st"])).toBe(PROGRAM);
  });
});

describe("runtime credentials", () => {
  const secret = "a-server-secret-with-enough-length-000";

  it("derives a stable, device-specific password without storing anything", () => {
    const first = runtimeCredentials(secret, "device-a");
    expect(first).toEqual(runtimeCredentials(secret, "device-a"));
    expect(first.password).not.toBe(runtimeCredentials(secret, "device-b").password);
    expect(first.password).not.toBe(runtimeCredentials("another-secret-with-enough-length-000", "device-a").password);
    expect(first.password.length).toBeGreaterThanOrEqual(40);
    expect(first.password).not.toContain(secret);
  });

  it("uses a development secret outside production and requires one in production", () => {
    expect(resolveRuntimeSecret({ nodeEnv: "production", runtimeSecret: secret })).toBe(secret);
    expect(resolveRuntimeSecret({ nodeEnv: "development", runtimeSecret: undefined })).toMatch(/development/);
    expectDomainError(
      () => resolveRuntimeSecret({ nodeEnv: "production", runtimeSecret: undefined }),
      "RUNTIME_FAILURE",
      "runtime-secret-required",
    );
  });
});

describe("runtime API client", () => {
  it("only talks to a loopback address", () => {
    const credentials = { username: "zfactory", password: "x" };
    expect(() => new OpenPlcClient({ host: "127.0.0.1", port: 15000 }, credentials)).not.toThrow();
    for (const host of ["0.0.0.0", "192.168.1.10", "example.com", "172.20.1.10"]) {
      expectDomainError(() => new OpenPlcClient({ host, port: 15000 }, credentials), "INVARIANT", "api-loopback-only");
    }
  });

  it("reports an unreachable runtime as a runtime failure", async () => {
    const client = new OpenPlcClient({ host: "127.0.0.1", port: 9 }, { username: "zfactory", password: "x" });
    await expectDomainError(client.version(), "RUNTIME_FAILURE", "runtime-unreachable");
  });
});

describe("runtime state", () => {
  it("lets the program state refine a running container", () => {
    expect(healthState("RUNNING", "RUNNING")).toBe("RUNNING");
    expect(healthState("RUNNING", "EMPTY")).toBe("DEGRADED");
    expect(healthState("RUNNING", "STOPPED")).toBe("DEGRADED");
    expect(healthState("RUNNING", "ERROR")).toBe("FAULTED");
    expect(healthState("RUNNING", undefined)).toBe("DEGRADED");
    // Docker's health probe still says "starting", but the runtime already answers.
    expect(healthState("STARTING", "RUNNING")).toBe("RUNNING");
    expect(healthState("STARTING", undefined)).toBe("STARTING");
    expect(healthState("FAULTED", "RUNNING")).toBe("FAULTED");
    expect(healthState("STOPPED", undefined)).toBe("STOPPED");
  });

  it("summarizes a factory from its PLC runtimes", () => {
    expect(summarizeRuntimeStates([])).toBe("STOPPED");
    expect(summarizeRuntimeStates(["STOPPED", "STOPPED"])).toBe("STOPPED");
    expect(summarizeRuntimeStates(["RUNNING", "RUNNING"])).toBe("RUNNING");
    expect(summarizeRuntimeStates(["RUNNING", "STARTING"])).toBe("STARTING");
    expect(summarizeRuntimeStates(["RUNNING", "FAULTED"])).toBe("DEGRADED");
    expect(summarizeRuntimeStates(["RUNNING", "STOPPED"])).toBe("DEGRADED");
  });

  it("turns instance names into DNS service names", () => {
    expect(serviceNameFor("S7-1200-1214C-01")).toBe("s7-1200-1214c-01");
    expect(serviceNameFor("PLC_01.main")).toBe("plc-01-main");
    expectDomainError(() => serviceNameFor("___"), "VALIDATION");
  });
});

describe("modbus tcp client", () => {
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  /** A one-shot Modbus TCP server that answers every request with `respond(requestPdu)`. */
  async function fakeServer(respond: (pdu: Buffer) => Buffer) {
    const requests: Buffer[] = [];
    server = createServer((socket) => {
      socket.on("data", (data: Buffer) => {
        const pdu = data.subarray(7);
        requests.push(pdu);
        const response = respond(pdu);
        const header = Buffer.from(data.subarray(0, 7));
        header.writeUInt16BE(response.length + 1, 4);
        socket.end(Buffer.concat([header, response]));
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { endpoint: { host: "127.0.0.1", port }, requests };
  }

  it("reads holding registers as 16-bit words", async () => {
    const { endpoint, requests } = await fakeServer(() => Buffer.from([0x03, 0x04, 0x00, 0x2d, 0x04, 0xd2]));

    expect(await readModbus(endpoint, "HOLDING_REGISTER", 10, 2)).toEqual([45, 1234]);
    expect(requests[0]).toEqual(Buffer.from([0x03, 0x00, 0x0a, 0x00, 0x02]));
  });

  it("reads coils as booleans, least significant bit first", async () => {
    const { endpoint, requests } = await fakeServer(() => Buffer.from([0x01, 0x01, 0b0000_0101]));

    expect(await readModbus(endpoint, "COIL", 0, 3)).toEqual([true, false, true]);
    expect(requests[0]?.[0]).toBe(0x01);
  });

  it("writes a coil and a holding register with the single-write functions", async () => {
    const { endpoint, requests } = await fakeServer((pdu) => pdu);

    await writeModbus(endpoint, "COIL", 3, true);
    await writeModbus(endpoint, "HOLDING_REGISTER", 7, 1234);
    expect(requests[0]).toEqual(Buffer.from([0x05, 0x00, 0x03, 0xff, 0x00]));
    expect(requests[1]).toEqual(Buffer.from([0x06, 0x00, 0x07, 0x04, 0xd2]));
  });

  it("never sends a write to a read-only area", async () => {
    const { endpoint, requests } = await fakeServer((pdu) => pdu);

    await expectDomainError(writeModbus(endpoint, "INPUT_REGISTER", 0, 1), "INCOMPATIBLE", "writable-area");
    await expectDomainError(writeModbus(endpoint, "DISCRETE_INPUT", 0, true), "INCOMPATIBLE", "writable-area");
    expect(requests).toEqual([]);
  });

  it("validates ranges and values before connecting", async () => {
    const endpoint = { host: "127.0.0.1", port: 9 };
    await expectDomainError(readModbus(endpoint, "HOLDING_REGISTER", -1), "VALIDATION", "modbus-range");
    await expectDomainError(readModbus(endpoint, "HOLDING_REGISTER", 0, 126), "VALIDATION", "modbus-range");
    await expectDomainError(readModbus(endpoint, "COIL", 65535, 2), "VALIDATION", "modbus-range");
    await expectDomainError(writeModbus(endpoint, "HOLDING_REGISTER", 0, 70000), "VALIDATION", "modbus-value");
  });

  it("surfaces a Modbus exception and an unreachable server as runtime failures", async () => {
    const { endpoint } = await fakeServer(() => Buffer.from([0x83, 0x02]));
    await expectDomainError(readModbus(endpoint, "HOLDING_REGISTER", 0), "RUNTIME_FAILURE", "modbus-exception");
    await expectDomainError(
      readModbus({ host: "127.0.0.1", port: 9 }, "HOLDING_REGISTER", 0),
      "RUNTIME_FAILURE",
      "modbus-unreachable",
    );
  });
});
