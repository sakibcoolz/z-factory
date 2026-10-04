import "server-only";
import { createHash } from "node:crypto";
import type Docker from "dockerode";
import type { Actor } from "@/lib/auth/actor";
import { type PlcRecord, plcRepository } from "@/lib/db/repositories/plc-repository";
import { inspectRuntimeContainer } from "@/lib/docker/containers";
import { imageReference } from "@/lib/docker/images";
import { ensureFactoryNetwork } from "@/lib/docker/networks";
import type { RuntimePolicy } from "@/lib/docker/policy";
import { allocateHostPorts, listPublishedPorts } from "@/lib/docker/ports";
import { OPENPLC_IMAGE_KEY } from "@/lib/docker/runtime-images";
import { DomainError, isDomainError } from "@/lib/domain/errors";
import type { RuntimeState } from "@/lib/domain/runtime-state";
import type { ModbusArea } from "@/lib/domain/tag";
import type { PrismaClient } from "@/lib/generated/prisma/client";
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
import { MAX_SOURCE_BYTES } from "@/lib/runtimes/openplc/compiler";

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
};

const notFound = () => new DomainError("NOT_FOUND", "The PLC does not exist.");

async function loadPlc(db: PrismaClient, actor: Actor, plcId: string) {
  const device = await plcRepository.findForOwner(db, actor.ownerId, plcId);
  if (!device) throw notFound();
  if (!device.plcProfile || device.runtimeType !== "OPENPLC") {
    throw new DomainError("INCOMPATIBLE", "This device is not an OpenPLC-backed PLC.", { rule: "openplc-plc-only" });
  }
  return { device, profile: device.plcProfile };
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

function targetOf(device: PlcRecord, policy: RuntimePolicy): OpenPlcTarget | undefined {
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
    bindAddress: modbus.bindAddress || (policy.bindAddresses[0] ?? "127.0.0.1"),
  };
}

function requireTarget(device: PlcRecord, policy: RuntimePolicy): OpenPlcTarget & { containerId: string } {
  const target = targetOf(device, policy);
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

async function setDeviceState(db: PrismaClient, device: PlcRecord, runtimeStatus: RuntimeState): Promise<void> {
  await plcRepository.setDeviceRuntime(db, device.id, { runtimeStatus });
  const summary = summarizeRuntimeStates(await plcRepository.plcRuntimeStates(db, device.factoryId));
  await plcRepository.setFactoryRuntimeStatus(db, device.factoryId, summary);
}

/** A runtime failure becomes a FAULTED device and a critical event; the error is rethrown. */
async function failDevice(db: PrismaClient, device: PlcRecord, action: string, error: unknown): Promise<never> {
  await setDeviceState(db, device, "FAULTED");
  await plcRepository.recordEvent(db, {
    factoryId: device.factoryId,
    deviceId: device.id,
    type: "DEVICE_FAULTED",
    severity: "CRITICAL",
    payloadJson: {
      action,
      code: isDomainError(error) ? error.code : "RUNTIME_FAILURE",
      rule: isDomainError(error) && typeof error.details.rule === "string" ? error.details.rule : null,
    },
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

  await plcRepository.recordEvent(db, { factoryId: device.factoryId, deviceId: device.id, type: "DEVICE_STARTING" });
  await setDeviceState(db, device, "STARTING");

  try {
    await ensureFactoryNetwork(
      docker,
      { factoryId: device.factoryId, name: device.factory.dockerNetworkName, subnetCidr: device.factory.subnetCidr },
      policy,
    );

    let target = targetOf(device, policy);
    const exists =
      target && device.dockerContainerId
        ? await inspectRuntimeContainer(docker, device.dockerContainerId).then(
            () => true,
            (error: unknown) => (isDomainError(error, "NOT_FOUND") ? false : Promise.reject(error)),
          )
        : false;

    if (!target || !exists) {
      const [apiHostPort = 0, modbusHostPort = 0] = allocateHostPorts(2, await listPublishedPorts(docker), policy);
      const bindAddress = policy.bindAddresses[0] ?? "127.0.0.1";
      target = {
        factoryId: device.factoryId,
        deviceId: device.id,
        networkName: device.factory.dockerNetworkName,
        serviceName: serviceNameFor(device.name),
        apiHostPort,
        modbusHostPort,
        bindAddress,
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
        bindAddress,
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
    return failDevice(db, device, "start", error);
  }

  if (device.plcProfile?.programVersionId) {
    await deployProgramVersion(deps, actor, plcId);
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
  const { db, policy } = deps;
  const { device, profile } = await loadPlc(db, actor, plcId);
  const versionId = programVersionId ?? profile.programVersionId;
  if (!versionId)
    throw new DomainError("CONFLICT", "The PLC has no program version to deploy.", { rule: "program-required" });
  const programVersion = await plcRepository.findProgramVersion(db, device.id, versionId);
  if (!programVersion) throw new DomainError("NOT_FOUND", "The program version does not exist.");

  const target = requireTarget(device, policy);
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
          runtime: profile.runtimeVersion,
          runtimeImage: profile.runtimeImage,
          imageDigest: profile.imageDigest,
        },
      });
      await plcRepository.recordEvent(transaction, {
        factoryId: device.factoryId,
        deviceId: device.id,
        type: "PLC_PROGRAM_DEPLOYED",
        payloadJson: { version: programVersion.version, md5: deployed.md5, warnings: deployed.warnings.length },
      });
    });
    await setDeviceState(db, device, "RUNNING");
    return { version: programVersion.version };
  } catch (error) {
    await plcRepository.setProgramStatus(db, programVersion.id, "FAILED");
    const compileError = isDomainError(error, "VALIDATION");
    await plcRepository.recordEvent(db, {
      factoryId: device.factoryId,
      deviceId: device.id,
      type: "PLC_PROGRAM_DEPLOY_FAILED",
      severity: compileError ? "WARNING" : "CRITICAL",
      payloadJson: {
        version: programVersion.version,
        rule: isDomainError(error) && typeof error.details.rule === "string" ? error.details.rule : null,
      },
    });
    // A program that does not compile never reached the runtime: the PLC keeps running
    // what it had. Anything else leaves the runtime in an unknown state, so re-read it.
    if (!compileError) await refreshPlcState(deps, actor, plcId).catch(() => undefined);
    throw error;
  }
}

/** Reads the live state from the runtime and records it as the last known state. */
export async function refreshPlcState(
  deps: RuntimeDeps,
  actor: Actor,
  plcId: string,
): Promise<{ state: RuntimeState }> {
  const { db, docker, policy } = deps;
  const { device } = await loadPlc(db, actor, plcId);
  const target = targetOf(device, policy);
  if (!target || !device.dockerContainerId) {
    await setDeviceState(db, device, "STOPPED");
    return { state: "STOPPED" };
  }
  const health = await openPlcHealth(docker, device.dockerContainerId, openPlcClient(target, deps.runtimeSecret));
  if (health.state !== device.runtimeStatus) {
    await setDeviceState(db, device, health.state);
    await plcRepository.recordEvent(db, {
      factoryId: device.factoryId,
      deviceId: device.id,
      type:
        health.state === "RUNNING"
          ? "DEVICE_RUNNING"
          : health.state === "FAULTED"
            ? "DEVICE_FAULTED"
            : "DEVICE_STATE_CHANGED",
      severity: health.state === "FAULTED" ? "CRITICAL" : "INFO",
      payloadJson: { state: health.state, plcStatus: health.plcStatus ?? null },
    });
  }
  return { state: health.state };
}

export async function stopPlc(deps: RuntimeDeps, actor: Actor, plcId: string): Promise<void> {
  const { db, docker, policy } = deps;
  const { device } = await loadPlc(db, actor, plcId);
  const target = requireTarget(device, policy);
  try {
    await stopOpenPlc(docker, target.containerId);
  } catch (error) {
    await failDevice(db, device, "stop", error);
  }
  await setDeviceState(db, device, "STOPPED");
  await plcRepository.recordEvent(db, { factoryId: device.factoryId, deviceId: device.id, type: "DEVICE_STOPPED" });
}

/** Restarts the PLC's container. The runtime reloads the program it was running. */
export async function restartPlc(deps: RuntimeDeps, actor: Actor, plcId: string): Promise<{ state: RuntimeState }> {
  const { db, docker, policy } = deps;
  const { device } = await loadPlc(db, actor, plcId);
  const target = requireTarget(device, policy);
  await setDeviceState(db, device, "STARTING");
  try {
    await restartOpenPlc(docker, target.containerId, openPlcClient(target, deps.runtimeSecret));
  } catch (error) {
    await failDevice(db, device, "restart", error);
  }
  return refreshPlcState(deps, actor, plcId);
}

/** Removes the PLC's container and releases its host ports. Program versions are kept. */
export async function removePlcRuntime(deps: RuntimeDeps, actor: Actor, plcId: string): Promise<void> {
  const { db, docker } = deps;
  const { device } = await loadPlc(db, actor, plcId);
  if (device.dockerContainerId) {
    try {
      await removeOpenPlc(docker, device.dockerContainerId);
    } catch (error) {
      await failDevice(db, device, "remove", error);
    }
  }
  await plcRepository.setDeviceRuntime(db, device.id, { dockerContainerId: null });
  await plcRepository.setRuntimeMetadata(db, device.id, { apiHostPort: null });
  await plcRepository.replaceModbusPort(db, device.id, null);
  await setDeviceState(db, device, "STOPPED");
  await plcRepository.recordEvent(db, { factoryId: device.factoryId, deviceId: device.id, type: "DEVICE_STOPPED" });
}

/** Raw Modbus read of the running program. Typed tag access arrives with TASK-203. */
export async function readPlcRegisters(
  deps: RuntimeDeps,
  actor: Actor,
  plcId: string,
  request: { area: ModbusArea; address: number; count?: number },
) {
  const { device } = await loadPlc(deps.db, actor, plcId);
  return readPlcValues(requireTarget(device, deps.policy), request.area, request.address, request.count);
}

/** Raw Modbus write to a coil or holding register of the running program. */
export async function writePlcRegister(
  deps: RuntimeDeps,
  actor: Actor,
  plcId: string,
  request: { area: ModbusArea; address: number; value: number | boolean },
) {
  const { device } = await loadPlc(deps.db, actor, plcId);
  await writePlcValue(requireTarget(device, deps.policy), request.area, request.address, request.value);
}
