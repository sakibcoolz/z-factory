import "server-only";
import type Docker from "dockerode";
import {
  createRuntimeContainer,
  inspectRuntimeContainer,
  removeRuntimeContainer,
  restartRuntimeContainer,
  startRuntimeContainer,
  stopRuntimeContainer,
} from "@/lib/docker/containers";
import { LOOPBACK_ADDRESS, type RuntimePolicy } from "@/lib/docker/policy";
import { OPENPLC_IMAGE_KEY } from "@/lib/docker/runtime-images";
import { DomainError } from "@/lib/domain/errors";
import type { RuntimeState } from "@/lib/domain/runtime-state";
import type { ModbusArea } from "@/lib/domain/tag";
import { type ModbusEndpoint, readModbus, writeModbus } from "@/lib/protocols/modbus/client";
import { API_CONTAINER_PORT, composeProgramBundle, MODBUS_CONTAINER_PORT, zipBundle } from "./bundle";
import { OpenPlcClient, type PlcStatus } from "./client";
import { type CompileDiagnostic, compileStructuredText } from "./compiler";
import { runtimeCredentials } from "./credentials";

/**
 * Runtime adapter for OpenPLC Runtime v4 (ADR-0009).
 *
 * OpenPLC is the executable runtime of a virtual PLC. It is not the firmware of the
 * hardware profile a PLC instance carries: no vendor timing, electrical behaviour or
 * certification is implied, and real-time scheduling is not available in the container.
 */

export const OPENPLC_RUNTIME_NAME = "OpenPLC Runtime";

/** Where one PLC's runtime lives and how to reach it from the server. */
export type OpenPlcTarget = {
  factoryId: string;
  deviceId: string;
  networkName: string;
  /** DNS name of the PLC inside the factory network. */
  serviceName: string;
  /** Loopback host port of the runtime's management API. */
  apiHostPort: number;
  /** Host endpoint the Modbus TCP server is published on; may be a LAN address for gateways. */
  modbusHostPort: number;
  modbusBindAddress: string;
};

/** Address the server itself uses to reach a published port. */
function connectHost(bindAddress: string): string {
  return bindAddress === "0.0.0.0" ? LOOPBACK_ADDRESS : bindAddress;
}

export type DeployResult = {
  md5: string;
  compilerVersion: string;
  warnings: CompileDiagnostic[];
};

export type OpenPlcHealth = {
  state: RuntimeState;
  containerRunning: boolean;
  /** Program state reported by the runtime; undefined when its API does not answer. */
  plcStatus: PlcStatus | undefined;
  runtimeVersion: string | undefined;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function poll<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  intervalMs: number,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await probe().catch(() => undefined);
    if (result !== undefined) return result;
    if (Date.now() >= deadline) return undefined;
    await sleep(intervalMs);
  }
}

export function openPlcClient(target: OpenPlcTarget, runtimeSecret: string): OpenPlcClient {
  return new OpenPlcClient(
    { host: LOOPBACK_ADDRESS, port: target.apiHostPort },
    runtimeCredentials(runtimeSecret, target.deviceId),
  );
}

/** Creates the PLC's container from the allow-listed OpenPLC image. It is not started. */
export function createOpenPlcContainer(docker: Docker, policy: RuntimePolicy, target: OpenPlcTarget) {
  return createRuntimeContainer(
    docker,
    {
      factoryId: target.factoryId,
      deviceId: target.deviceId,
      networkName: target.networkName,
      serviceName: target.serviceName,
      image: OPENPLC_IMAGE_KEY,
      ports: [
        { containerPort: API_CONTAINER_PORT, hostPort: target.apiHostPort, bindAddress: LOOPBACK_ADDRESS },
        {
          containerPort: MODBUS_CONTAINER_PORT,
          hostPort: target.modbusHostPort,
          bindAddress: target.modbusBindAddress,
        },
      ],
    },
    policy,
  );
}

/** Starts the container and waits until the runtime API answers and has its API user. */
export async function startOpenPlc(
  docker: Docker,
  containerId: string,
  client: OpenPlcClient,
  timeoutMs = 90_000,
): Promise<{ runtimeVersion: string }> {
  await startRuntimeContainer(docker, containerId);
  const runtimeVersion = await poll(() => client.version(), timeoutMs, 1000);
  if (!runtimeVersion) {
    throw new DomainError("RUNTIME_FAILURE", "The OpenPLC runtime did not become ready in time.", {
      rule: "runtime-start-timeout",
    });
  }
  await client.ensureUser();
  return { runtimeVersion };
}

/**
 * Compiles a Structured Text program, uploads it and runs it. The container and its
 * image are untouched: the runtime rebuilds only the program library and reloads it.
 */
export async function deployProgram(
  client: OpenPlcClient,
  source: string,
  buildTimeoutMs = 240_000,
): Promise<DeployResult> {
  const compiled = await compileStructuredText(source);
  if (!compiled.success) {
    throw new DomainError("VALIDATION", "The program does not compile.", {
      rule: "program-compile",
      diagnostics: compiled.errors,
    });
  }

  const bundle = composeProgramBundle({ source, md5: compiled.md5, compiledFiles: compiled.files });
  await client.uploadProgram(zipBundle(bundle));

  const build = await poll(
    async () => {
      const status = await client.compilationStatus();
      return status.state === "COMPILING" ? undefined : status;
    },
    buildTimeoutMs,
    1000,
  );
  if (!build || build.state !== "SUCCESS") {
    // The build log can contain container paths; it stays in details for the server log.
    throw new DomainError("RUNTIME_FAILURE", "The OpenPLC runtime could not build the program.", {
      rule: build ? "runtime-build-failed" : "runtime-build-timeout",
      log: build?.logs.filter((line) => line.includes("ERROR")).slice(-10),
    });
  }

  await client.startPlc();
  const running = await poll(async () => ((await client.status()) === "RUNNING" ? true : undefined), 20_000, 500);
  if (!running) {
    throw new DomainError("RUNTIME_FAILURE", "The program was built but did not start running.", {
      rule: "program-start-failed",
    });
  }
  return { md5: compiled.md5, compilerVersion: compiled.compilerVersion, warnings: compiled.warnings };
}

/**
 * Combines container state with the program state the runtime reports. The runtime's
 * own answer wins over Docker's health probe, which stays "starting" for its first 90 s.
 */
export function healthState(containerState: RuntimeState, plcStatus: PlcStatus | undefined): RuntimeState {
  if (containerState !== "RUNNING" && containerState !== "STARTING") return containerState;
  switch (plcStatus) {
    case "RUNNING":
      return "RUNNING";
    case "ERROR":
      return "FAULTED";
    case "STOPPED":
    case "EMPTY":
      // The container is up but no program is executing.
      return "DEGRADED";
    default:
      // The API does not answer: still booting, or up but unresponsive.
      return containerState === "STARTING" ? "STARTING" : "DEGRADED";
  }
}

export async function openPlcHealth(
  docker: Docker,
  containerId: string,
  client: OpenPlcClient,
): Promise<OpenPlcHealth> {
  const container = await inspectRuntimeContainer(docker, containerId);
  if (!container.running) {
    return { state: container.state, containerRunning: false, plcStatus: undefined, runtimeVersion: undefined };
  }
  const runtimeVersion = await client.version().catch(() => undefined);
  const plcStatus = runtimeVersion ? await client.status().catch(() => undefined) : undefined;
  return { state: healthState(container.state, plcStatus), containerRunning: true, plcStatus, runtimeVersion };
}

export async function stopOpenPlc(docker: Docker, containerId: string): Promise<void> {
  await stopRuntimeContainer(docker, containerId);
}

export async function restartOpenPlc(docker: Docker, containerId: string, client: OpenPlcClient): Promise<void> {
  await restartRuntimeContainer(docker, containerId);
  const ready = await poll(() => client.version(), 90_000, 1000);
  if (!ready) {
    throw new DomainError("RUNTIME_FAILURE", "The OpenPLC runtime did not come back after the restart.", {
      rule: "runtime-start-timeout",
    });
  }
}

export function removeOpenPlc(docker: Docker, containerId: string): Promise<boolean> {
  return removeRuntimeContainer(docker, containerId);
}

/** How the server reaches a Modbus port published on `bindAddress`. */
export function publishedModbusEndpoint(bindAddress: string, hostPort: number): ModbusEndpoint {
  return { host: connectHost(bindAddress), port: hostPort };
}

/** Modbus endpoint of the running program as seen from the server. */
export function modbusEndpoint(target: OpenPlcTarget): ModbusEndpoint {
  return publishedModbusEndpoint(target.modbusBindAddress, target.modbusHostPort);
}

/** Reads raw Modbus values of the running program through its published port. */
export function readPlcValues(target: OpenPlcTarget, area: ModbusArea, address: number, count = 1) {
  return readModbus(modbusEndpoint(target), area, address, count);
}

/** Writes one coil or holding register of the running program. */
export function writePlcValue(target: OpenPlcTarget, area: ModbusArea, address: number, value: number | boolean) {
  return writeModbus(modbusEndpoint(target), area, address, value);
}
