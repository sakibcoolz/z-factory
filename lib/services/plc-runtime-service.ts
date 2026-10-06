import "server-only";
import { createHash } from "node:crypto";
import type Docker from "dockerode";
import type { Actor } from "@/lib/auth/actor";
import { type PlcRecord, plcRepository } from "@/lib/db/repositories/plc-repository";
import { tagRepository } from "@/lib/db/repositories/tag-repository";
import { inspectRuntimeContainer } from "@/lib/docker/containers";
import { imageReference } from "@/lib/docker/images";
import { ensureFactoryNetwork } from "@/lib/docker/networks";
import { LOOPBACK_ADDRESS, type RuntimePolicy } from "@/lib/docker/policy";
import { allocateHostPorts, assertPortBindings, listPublishedPorts } from "@/lib/docker/ports";
import { OPENPLC_IMAGE_KEY } from "@/lib/docker/runtime-images";
import { programSupport } from "@/lib/domain/device-capabilities";
import { DomainError, isDomainError } from "@/lib/domain/errors";
import type { EventSeverity } from "@/lib/domain/events";
import type { RuntimeState } from "@/lib/domain/runtime-state";
import type { ModbusArea } from "@/lib/domain/tag";
import type { EventBus } from "@/lib/events/bus";
import type { PrismaClient, ProgramLanguage } from "@/lib/generated/prisma/client";
import {
  createOpenPlcContainer,
  deployProgram,
  OPENPLC_RUNTIME_NAME,
  openPlcClient,
  openPlcHealth,
  type OpenPlcTarget,
  readPlcValues,
  removeOpenPlc,
  restartOpenPlc,
  startOpenPlc,
  stopOpenPlc,
  writePlcValue,
} from "@/lib/runtimes/openplc/adapter";
import { MODBUS_CONTAINER_PORT } from "@/lib/runtimes/openplc/bundle";
import { type CompileDiagnostic, compileStructuredText, MAX_SOURCE_BYTES } from "@/lib/runtimes/openplc/compiler";
import { parseInput } from "@/lib/validation/parse";
import { modbusEndpointInputSchema } from "@/lib/validation/schemas";
import { recordEvent } from "./event-service";

/**
 * Lifecycle of a PLC instance's OpenPLC runtime: versioned programs, start, deploy,
 * stop, remove. The database records configuration, versions, the last known runtime
 * state and events; the running container is the live authority (ADR-0005).
 */

export type RuntimeDeps = {
  db: PrismaClient;
  docker: Docker;
  policy: RuntimePolicy;
  /** Secret the per-container API credentials are derived from. */
  runtimeSecret: string;
  /** Live listeners (SSE) receive every event that is recorded. */
  bus?: EventBus;
};

const notFound = () => new DomainError("NOT_FOUND", "The PLC does not exist.");

export async function loadPlc(db: PrismaClient, actor: Actor, plcId: string) {
  const device = await plcRepository.findForOwner(db, actor.ownerId, plcId);
  if (!device) throw notFound();
  if (!device.plcProfile || device.runtimeType !== "OPENPLC") {
    throw new DomainError("INCOMPATIBLE", "This device is not an OpenPLC-backed PLC.", { rule: "openplc-plc-only" });
  }
  return { device, profile: device.plcProfile };
}

/**
 * The program workflow runs only for a model that is programmable in an IEC 61131-3
 * language on the OpenPLC adapter, and only for a program in the language that adapter
 * compiles. Checked before anything is compiled, stored or deployed (TASK-308).
 */
function assertProgrammable(device: PlcRecord, language: ProgramLanguage = "ST"): void {
  const support = programSupport(device.deviceModel);
  if (!support.supported) {
    throw new DomainError("INCOMPATIBLE", support.reason, { rule: "program-capability" });
  }
  if (language !== support.language) {
    throw new DomainError(
      "INCOMPATIBLE",
      `The OpenPLC adapter compiles Structured Text; this program is ${language}.`,
      {
        rule: "program-language",
        language,
      },
    );
  }
}

/** DNS name of the PLC inside its factory network, e.g. `S7-1200-1214C-01` → `s7-1200-1214c-01`. */
export function serviceNameFor(deviceName: string): string {
  const name = deviceName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  if (!name) throw new DomainError("VALIDATION", "The device name cannot be used as a service name.");
  return name;
}

function targetOf(device: PlcRecord): OpenPlcTarget | undefined {
  const modbus = device.runtimePorts.find((port) => port.protocol === "MODBUS_TCP");
  const apiHostPort = device.plcProfile?.apiHostPort;
  if (!device.dockerContainerId || !apiHostPort || !modbus?.hostPort || !device.hostName) return undefined;
  return {
    factoryId: device.factoryId,
    deviceId: device.id,
    networkName: device.factory.dockerNetworkName,
    serviceName: device.hostName,
    apiHostPort,
    modbusHostPort: modbus.hostPort,
    modbusBindAddress: modbus.bindAddress,
  };
}

/** The running PLC's endpoints; a conflict when its runtime has not been started. */
export function requireTarget(device: PlcRecord): OpenPlcTarget & { containerId: string } {
  const target = targetOf(device);
  if (!target || !device.dockerContainerId) {
    throw new DomainError("CONFLICT", "The PLC runtime has not been started.", { rule: "runtime-required" });
  }
  return { ...target, containerId: device.dockerContainerId };
}

/** Factory-level summary of its PLC runtimes. */
export function summarizeRuntimeStates(states: readonly RuntimeState[]): RuntimeState {
  const active = states.filter((state) => state !== "STOPPED");
  if (active.length === 0) return "STOPPED";
  if (states.some((state) => state === "FAULTED" || state === "DEGRADED" || state === "DISCONNECTED"))
    return "DEGRADED";
  if (states.some((state) => state === "STARTING")) return "STARTING";
  if (states.some((state) => state === "STOPPING")) return "STOPPING";
  // Some PLCs run while others are stopped: the factory is only partly up.
  return active.length === states.length ? "RUNNING" : "DEGRADED";
}

/** Records an event of this PLC and publishes it to live listeners. */
function emit(
  deps: Pick<RuntimeDeps, "db" | "bus">,
  device: PlcRecord,
  type: string,
  severity: EventSeverity = "INFO",
  payload: Record<string, unknown> = {},
) {
  return recordEvent(deps, { type, factoryId: device.factoryId, deviceId: device.id, severity, payload });
}

async function setDeviceState(db: PrismaClient, device: PlcRecord, runtimeStatus: RuntimeState): Promise<void> {
  await plcRepository.setDeviceRuntime(db, device.id, { runtimeStatus });
  const summary = summarizeRuntimeStates(await plcRepository.plcRuntimeStates(db, device.factoryId));
  await plcRepository.setFactoryRuntimeStatus(db, device.factoryId, summary);
}

/** A runtime failure becomes a FAULTED device and a critical event; the error is rethrown. */
async function failDevice(
  deps: Pick<RuntimeDeps, "db" | "bus">,
  device: PlcRecord,
  action: string,
  error: unknown,
): Promise<never> {
  await setDeviceState(deps.db, device, "FAULTED");
  await emit(deps, device, "DEVICE_FAULTED", "CRITICAL", {
    action,
    code: isDomainError(error) ? error.code : "RUNTIME_FAILURE",
    rule: isDomainError(error) && typeof error.details.rule === "string" ? error.details.rule : null,
  });
  throw error;
}

/** Saves a new, immutable program version and selects it for the next deployment. */
export async function createProgramVersion(
  db: PrismaClient,
  actor: Actor,
  plcId: string,
  input: { sourceText: string },
) {
  const { device } = await loadPlc(db, actor, plcId);
  assertProgrammable(device);
  const sourceText = input.sourceText;
  if (typeof sourceText !== "string" || sourceText.trim() === "") {
    throw new DomainError("VALIDATION", "The program source is empty.", { rule: "program-source" });
  }
  if (Buffer.byteLength(sourceText, "utf8") > MAX_SOURCE_BYTES) {
    throw new DomainError("VALIDATION", "The program source is too large.", { rule: "program-size" });
  }

  return db.$transaction(async (transaction) => {
    const version = await plcRepository.nextProgramVersion(transaction, device.id);
    const created = await plcRepository.createProgramVersion(transaction, {
      plcInstanceId: device.id,
      version,
      sourceText,
      checksum: createHash("sha256").update(sourceText).digest("hex"),
    });
    await plcRepository.selectProgramVersion(transaction, device.id, created.id);
    return created;
  });
}

/**
 * Compiles a program without saving or deploying it. Nothing reaches the runtime; the
 * compiler runs in its own process on the server.
 */
export async function checkProgram(
  db: PrismaClient,
  actor: Actor,
  plcId: string,
  input: { sourceText: string },
): Promise<{ success: boolean; errors: CompileDiagnostic[]; warnings: CompileDiagnostic[] }> {
  assertProgrammable((await loadPlc(db, actor, plcId)).device);
  if (typeof input.sourceText !== "string" || input.sourceText.trim() === "") {
    throw new DomainError("VALIDATION", "The program source is empty.", { rule: "program-source" });
  }
  const compiled = await compileStructuredText(input.sourceText);
  return { success: compiled.success, errors: compiled.success ? [] : compiled.errors, warnings: compiled.warnings };
}

/** Selects an existing version for the next start or deploy, e.g. to go back to an earlier one. */
export async function selectProgramVersion(
  db: PrismaClient,
  actor: Actor,
  plcId: string,
  programVersionId: string,
): Promise<{ version: number }> {
  const { device } = await loadPlc(db, actor, plcId);
  const programVersion = await plcRepository.findProgramVersion(db, device.id, programVersionId);
  if (!programVersion) throw new DomainError("NOT_FOUND", "The program version does not exist.");
  await plcRepository.selectProgramVersion(db, device.id, programVersion.id);
  return { version: programVersion.version };
}

export async function listProgramVersions(db: PrismaClient, actor: Actor, plcId: string) {
  const { device } = await loadPlc(db, actor, plcId);
  return plcRepository.listProgramVersions(db, device.id);
}

/**
 * Starts the PLC's runtime: factory network, container from the allow-listed image,
 * readiness, then the selected program version (when there is one).
 */
export async function startPlc(deps: RuntimeDeps, actor: Actor, plcId: string): Promise<{ state: RuntimeState }> {
  const { db, docker, policy } = deps;
  let { device } = await loadPlc(db, actor, plcId);

  await emit(deps, device, "DEVICE_STARTING");
  await setDeviceState(db, device, "STARTING");

  try {
    await ensureFactoryNetwork(
      docker,
      { factoryId: device.factoryId, name: device.factory.dockerNetworkName, subnetCidr: device.factory.subnetCidr },
      policy,
    );

    const existingTarget = targetOf(device);
    let target: OpenPlcTarget;
    const exists =
      existingTarget && device.dockerContainerId
        ? await inspectRuntimeContainer(docker, device.dockerContainerId).then(
            () => true,
            (error: unknown) => (isDomainError(error, "NOT_FOUND") ? false : Promise.reject(error)),
          )
        : false;

    if (existingTarget && exists) {
      target = existingTarget;
    } else {
      // Ports claimed on the Docker host plus those other devices have reserved in the database.
      const taken = [
        ...(await listPublishedPorts(docker)),
        ...(await plcRepository.listReservedHostPorts(db, device.id)),
      ];
      // The Modbus endpoint is stable configuration: reuse it when the PLC already has one.
      const configured = device.runtimePorts.find((port) => port.protocol === "MODBUS_TCP" && port.hostPort);
      const modbusBindAddress = configured?.bindAddress ?? LOOPBACK_ADDRESS;
      let modbusHostPort = configured?.hostPort ?? 0;
      if (configured?.hostPort) {
        assertPortBindings(
          [{ containerPort: MODBUS_CONTAINER_PORT, hostPort: configured.hostPort, bindAddress: modbusBindAddress }],
          taken,
          policy,
        );
      } else {
        [modbusHostPort = 0] = allocateHostPorts(1, taken, policy);
      }
      const [apiHostPort = 0] = allocateHostPorts(
        1,
        [...taken, { hostPort: modbusHostPort, bindAddress: modbusBindAddress }],
        policy,
      );
      target = {
        factoryId: device.factoryId,
        deviceId: device.id,
        networkName: device.factory.dockerNetworkName,
        serviceName: serviceNameFor(device.name),
        apiHostPort,
        modbusHostPort,
        modbusBindAddress,
      };
      const created = await createOpenPlcContainer(docker, policy, target);
      const image = policy.images.find((candidate) => candidate.key === OPENPLC_IMAGE_KEY);

      await plcRepository.setDeviceRuntime(db, device.id, {
        dockerContainerId: created.containerId,
        hostName: target.serviceName,
      });
      await plcRepository.setRuntimeMetadata(db, device.id, {
        apiHostPort,
        runtimeImage: image ? imageReference(image) : null,
        imageDigest: created.imageId,
      });
      await plcRepository.replaceModbusPort(db, device.id, {
        containerPort: MODBUS_CONTAINER_PORT,
        hostPort: modbusHostPort,
        bindAddress: modbusBindAddress,
      });
      device = (await loadPlc(db, actor, plcId)).device;
    }

    const containerId = device.dockerContainerId;
    if (!containerId) throw new DomainError("INVARIANT", "The PLC container was not recorded.");
    const { runtimeVersion } = await startOpenPlc(docker, containerId, openPlcClient(target, deps.runtimeSecret));
    await plcRepository.setRuntimeMetadata(db, device.id, {
      runtimeVersion: `${OPENPLC_RUNTIME_NAME} ${runtimeVersion}`,
    });
  } catch (error) {
    return failDevice(deps, device, "start", error);
  }

  if (device.plcProfile?.programVersionId) {
    try {
      await deployProgramVersion(deps, actor, plcId);
    } catch (error) {
      // The container is up without this program: store what the runtime reports, not STARTING.
      await refreshPlcState(deps, actor, plcId).catch(() => undefined);
      throw error;
    }
  }
  return refreshPlcState(deps, actor, plcId);
}

/**
 * Deploys a program version (the selected one by default) to the running PLC. Only the
 * program is rebuilt and reloaded; the container and its image stay as they are.
 */
export async function deployProgramVersion(
  deps: RuntimeDeps,
  actor: Actor,
  plcId: string,
  programVersionId?: string,
): Promise<{ version: number }> {
  const { db } = deps;
  const { device, profile } = await loadPlc(db, actor, plcId);
  const versionId = programVersionId ?? profile.programVersionId;
  if (!versionId)
    throw new DomainError("CONFLICT", "The PLC has no program version to deploy.", { rule: "program-required" });
  const programVersion = await plcRepository.findProgramVersion(db, device.id, versionId);
  if (!programVersion) throw new DomainError("NOT_FOUND", "The program version does not exist.");
  assertProgrammable(device, programVersion.language);

  const target = requireTarget(device);
  const client = openPlcClient(target, deps.runtimeSecret);

  try {
    const deployed = await deployProgram(client, programVersion.sourceText);

    await db.$transaction(async (transaction) => {
      await plcRepository.retireDeployedPrograms(transaction, device.id, programVersion.id);
      await plcRepository.setProgramStatus(transaction, programVersion.id, "DEPLOYED", `md5:${deployed.md5}`);
      await plcRepository.selectProgramVersion(transaction, device.id, programVersion.id);
      // The deployed configuration as one immutable snapshot, for exports and audits.
      await plcRepository.recordConfigurationSnapshot(transaction, {
        factoryId: device.factoryId,
        deviceId: device.id,
        createdBy: actor.ownerId,
        snapshotJson: {
          programVersion: programVersion.version,
          programChecksum: programVersion.checksum,
          programMd5: deployed.md5,
          compiler: `STruC++ ${deployed.compilerVersion}`,
          ioMappingVersion: profile.ioMappingVersion,
          modbusMappingVersion: profile.modbusMappingVersion,
          // The tag map as deployed, so an export can be reproduced from this snapshot alone.
          tags: (await tagRepository.listByPlc(transaction, device.id)).map((tag) => ({
            name: tag.name,
            dataType: tag.dataType,
            role: tag.role,
            accessMode: tag.accessMode,
            logicalAddress: tag.logicalAddress,
            area: tag.protocolArea,
            address: tag.protocolAddress,
            wordCount: tag.wordCount,
            scale: tag.scale,
            offset: tag.offset,
            unit: tag.unit,
          })),
          runtime: profile.runtimeVersion,
          runtimeImage: profile.runtimeImage,
          imageDigest: profile.imageDigest,
        },
      });
    });
    await emit(deps, device, "PLC_PROGRAM_DEPLOYED", "INFO", {
      version: programVersion.version,
      md5: deployed.md5,
      warnings: deployed.warnings.length,
    });
    await setDeviceState(db, device, "RUNNING");
    return { version: programVersion.version };
  } catch (error) {
    await plcRepository.setProgramStatus(db, programVersion.id, "FAILED");
    const compileError = isDomainError(error, "VALIDATION");
    await emit(deps, device, "PLC_PROGRAM_DEPLOY_FAILED", compileError ? "WARNING" : "CRITICAL", {
      version: programVersion.version,
      rule: isDomainError(error) && typeof error.details.rule === "string" ? error.details.rule : null,
    });
    // A program that does not compile never reached the runtime: the PLC keeps running
    // what it had. Anything else leaves the runtime in an unknown state, so re-read it.
    if (!compileError) await refreshPlcState(deps, actor, plcId).catch(() => undefined);
    throw error;
  }
}

/**
 * Saves the source as a new version and deploys it. Source identical to the selected
 * version is not saved again: that version is deployed.
 */
export async function saveAndDeployProgram(
  deps: RuntimeDeps,
  actor: Actor,
  plcId: string,
  input: { sourceText: string },
): Promise<{ version: number; saved: boolean }> {
  const { device, profile } = await loadPlc(deps.db, actor, plcId);
  requireTarget(device);
  const selected = profile.programVersion;
  if (selected && selected.sourceText === input.sourceText) {
    return { ...(await deployProgramVersion(deps, actor, plcId, selected.id)), saved: false };
  }
  const created = await createProgramVersion(deps.db, actor, plcId, input);
  try {
    return { ...(await deployProgramVersion(deps, actor, plcId, created.id)), saved: true };
  } catch (error) {
    // The new version stays stored as FAILED, but the next start must not pick it up.
    if (selected) await plcRepository.selectProgramVersion(deps.db, device.id, selected.id);
    throw error;
  }
}

/** Reads the live state from the runtime and records it as the last known state. */
export async function refreshPlcState(
  deps: RuntimeDeps,
  actor: Actor,
  plcId: string,
): Promise<{ state: RuntimeState }> {
  const { db, docker } = deps;
  const { device } = await loadPlc(db, actor, plcId);
  const target = targetOf(device);
  if (!target || !device.dockerContainerId) {
    await setDeviceState(db, device, "STOPPED");
    return { state: "STOPPED" };
  }
  const health = await openPlcHealth(docker, device.dockerContainerId, openPlcClient(target, deps.runtimeSecret));
  // A runtime Z-Factory stopped stays stopped: its container ends with the stop signal's
  // exit code, which is not a fault of the PLC.
  const state = device.runtimeStatus === "STOPPED" && !health.containerRunning ? "STOPPED" : health.state;
  if (state !== device.runtimeStatus) {
    await setDeviceState(db, device, state);
    await emit(
      deps,
      device,
      state === "RUNNING" ? "DEVICE_RUNNING" : state === "FAULTED" ? "DEVICE_FAULTED" : "DEVICE_STATE_CHANGED",
      state === "FAULTED" ? "CRITICAL" : "INFO",
      { state, plcStatus: health.plcStatus ?? null },
    );
  }
  return { state };
}

export async function stopPlc(deps: RuntimeDeps, actor: Actor, plcId: string): Promise<void> {
  const { db, docker } = deps;
  const { device } = await loadPlc(db, actor, plcId);
  const target = requireTarget(device);
  // On its way down: nothing should read the stopping container as a failed one.
  await setDeviceState(db, device, "STOPPING");
  try {
    await stopOpenPlc(docker, target.containerId);
  } catch (error) {
    await failDevice(deps, device, "stop", error);
  }
  await setDeviceState(db, device, "STOPPED");
  await emit(deps, device, "DEVICE_STOPPED");
}

/** Restarts the PLC's container. The runtime reloads the program it was running. */
export async function restartPlc(deps: RuntimeDeps, actor: Actor, plcId: string): Promise<{ state: RuntimeState }> {
  const { db, docker } = deps;
  const { device } = await loadPlc(db, actor, plcId);
  const target = requireTarget(device);
  await setDeviceState(db, device, "STARTING");
  try {
    await restartOpenPlc(docker, target.containerId, openPlcClient(target, deps.runtimeSecret));
  } catch (error) {
    await failDevice(deps, device, "restart", error);
  }
  return refreshPlcState(deps, actor, plcId);
}

/** Removes the PLC's container. Program versions and the Modbus endpoint are kept. */
export async function removePlcRuntime(deps: RuntimeDeps, actor: Actor, plcId: string): Promise<void> {
  const { db, docker } = deps;
  const { device } = await loadPlc(db, actor, plcId);
  if (device.dockerContainerId) {
    try {
      await removeOpenPlc(docker, device.dockerContainerId);
    } catch (error) {
      await failDevice(deps, device, "remove", error);
    }
  }
  await plcRepository.setDeviceRuntime(db, device.id, { dockerContainerId: null });
  // The management port is released; the Modbus endpoint is configuration and is kept,
  // so external clients find the PLC at the same address after it is recreated.
  await plcRepository.setRuntimeMetadata(db, device.id, { apiHostPort: null });
  await setDeviceState(db, device, "STOPPED");
  await emit(deps, device, "DEVICE_STOPPED", "INFO", { removed: true });
}

/**
 * Sets the host endpoint the PLC's Modbus TCP server is published on, e.g. a LAN address
 * for an external gateway. Port bindings are fixed when a container is created, so the
 * runtime must be removed first; the endpoint takes effect on the next start.
 */
export async function configureModbusEndpoint(
  deps: RuntimeDeps,
  actor: Actor,
  plcId: string,
  input: unknown,
): Promise<{ bindAddress: string; hostPort: number }> {
  const { db, docker, policy } = deps;
  const endpoint = parseInput(modbusEndpointInputSchema, input);
  const { device } = await loadPlc(db, actor, plcId);
  if (device.dockerContainerId) {
    throw new DomainError("CONFLICT", "Remove the PLC runtime before changing its Modbus endpoint.", {
      rule: "runtime-recreate-required",
    });
  }
  const taken = [...(await listPublishedPorts(docker)), ...(await plcRepository.listReservedHostPorts(db, device.id))];
  assertPortBindings([{ containerPort: MODBUS_CONTAINER_PORT, ...endpoint }], taken, policy);
  await plcRepository.replaceModbusPort(db, device.id, { containerPort: MODBUS_CONTAINER_PORT, ...endpoint });
  return endpoint;
}

/** Raw Modbus read of the running program; typed access is in the tag service. */
export async function readPlcRegisters(
  deps: RuntimeDeps,
  actor: Actor,
  plcId: string,
  request: { area: ModbusArea; address: number; count?: number },
) {
  const { device } = await loadPlc(deps.db, actor, plcId);
  return readPlcValues(requireTarget(device), request.area, request.address, request.count);
}

/** Raw Modbus write to a coil or holding register of the running program. */
export async function writePlcRegister(
  deps: RuntimeDeps,
  actor: Actor,
  plcId: string,
  request: { area: ModbusArea; address: number; value: number | boolean },
) {
  const { device } = await loadPlc(deps.db, actor, plcId);
  await writePlcValue(requireTarget(device), request.area, request.address, request.value);
}
