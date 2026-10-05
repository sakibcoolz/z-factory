import "server-only";
import { z } from "zod";
import type { Actor } from "@/lib/auth/actor";
import { plcRepository } from "@/lib/db/repositories/plc-repository";
import { tagRepository } from "@/lib/db/repositories/tag-repository";
import { isDomainError } from "@/lib/domain/errors";
import {
  type DeploymentView,
  eventDetail,
  type LocatedVariableView,
  type PlcProgramView,
  type PlcRuntimeView,
  type PlcVersionsView,
  type ProgramVersionView,
} from "@/lib/domain/plc-runtime-view";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { iecTypeFor, starterProgram } from "@/lib/plc/program-template";
import { MAX_SOURCE_BYTES } from "@/lib/runtimes/openplc/compiler";
import { loadPlc, refreshPlcState, type RuntimeDeps } from "./plc-runtime-service";

/**
 * Read models of the Program, Versions and Runtime screens of a stored PLC. They leave
 * out what the browser must not see: the container id and the runtime's management port.
 */

const RUNTIME_EVENT_COUNT = 12;

type VersionRecord = Awaited<ReturnType<typeof plcRepository.listProgramVersions>>[number];

function toVersionView(record: VersionRecord, selectedId: string | null): ProgramVersionView {
  return {
    id: record.id,
    version: record.version,
    status: record.status,
    checksum: record.checksum,
    createdAt: record.createdAt.toISOString(),
    selected: record.id === selectedId,
  };
}

async function locatedVariables(db: PrismaClient, plcId: string): Promise<LocatedVariableView[]> {
  return (await tagRepository.listWithSourceDevice(db, plcId)).flatMap((tag) =>
    tag.logicalAddress
      ? [
          {
            name: tag.name,
            address: tag.logicalAddress,
            type: iecTypeFor(tag.dataType),
            source: tag.sourceDevice && tag.sourceSignal ? `${tag.sourceDevice.name} · ${tag.sourceSignal}` : null,
          },
        ]
      : [],
  );
}

/**
 * The program editor's content: the requested version, else the selected one, else the
 * newest, else a starter program declaring the PLC's tags.
 */
export async function getPlcProgramView(
  db: PrismaClient,
  actor: Actor,
  plcId: string,
  options: { version?: number } = {},
): Promise<PlcProgramView> {
  const { device, profile } = await loadPlc(db, actor, plcId);
  const [records, variables] = await Promise.all([
    plcRepository.listProgramVersions(db, device.id),
    locatedVariables(db, device.id),
  ]);
  const opened =
    records.find((record) => record.version === options.version) ??
    records.find((record) => record.id === profile.programVersionId) ??
    records.at(-1);

  return {
    versions: records.map((record) => toVersionView(record, profile.programVersionId)).reverse(),
    source: opened?.sourceText ?? starterProgram(device.name, variables),
    sourceVersion: opened?.version ?? null,
    locatedVariables: variables,
    maxSourceBytes: MAX_SOURCE_BYTES,
  };
}

/** What a deployment snapshot records (see `deployProgramVersion`); every field is optional on read. */
const snapshotSchema = z.object({
  programVersion: z.number().nullish(),
  programChecksum: z.string().nullish(),
  compiler: z.string().nullish(),
  ioMappingVersion: z.number().nullish(),
  modbusMappingVersion: z.number().nullish(),
  runtime: z.string().nullish(),
  tags: z.array(z.unknown()).nullish(),
});

function toDeploymentView(record: { version: number; createdAt: Date; snapshotJson: unknown }): DeploymentView {
  const parsed = snapshotSchema.safeParse(record.snapshotJson);
  const snapshot = parsed.success ? parsed.data : {};
  return {
    version: record.version,
    createdAt: record.createdAt.toISOString(),
    programVersion: snapshot.programVersion ?? null,
    programChecksum: snapshot.programChecksum ?? null,
    compiler: snapshot.compiler ?? null,
    ioMappingVersion: snapshot.ioMappingVersion ?? null,
    modbusMappingVersion: snapshot.modbusMappingVersion ?? null,
    runtime: snapshot.runtime ?? null,
    tagCount: snapshot.tags?.length ?? null,
  };
}

export async function getPlcVersionsView(db: PrismaClient, actor: Actor, plcId: string): Promise<PlcVersionsView> {
  const { device, profile } = await loadPlc(db, actor, plcId);
  const [records, snapshots] = await Promise.all([
    plcRepository.listProgramVersions(db, device.id),
    plcRepository.listConfigurationVersions(db, device.factoryId, device.id),
  ]);
  return {
    versions: records.map((record) => toVersionView(record, profile.programVersionId)).reverse(),
    deployments: snapshots.map(toDeploymentView),
    runtimeCreated: Boolean(device.dockerContainerId),
  };
}

const TRANSITIONAL = new Set(["STARTING", "STOPPING"]);

/**
 * Reads the PLC's state from its runtime and stores it as the last known state, unless
 * it has no runtime or a start or stop is in progress. Never throws for a runtime that
 * cannot be asked: the reason is returned and the stored state stays as it was.
 */
export async function readLivePlcState(
  db: PrismaClient,
  resolveDeps: () => RuntimeDeps,
  actor: Actor,
  plcId: string,
): Promise<{ liveError: string | null }> {
  const { device } = await loadPlc(db, actor, plcId);
  if (!device.dockerContainerId || TRANSITIONAL.has(device.runtimeStatus)) return { liveError: null };
  try {
    await refreshPlcState(resolveDeps(), actor, plcId);
    return { liveError: null };
  } catch (error) {
    return { liveError: isDomainError(error) ? error.message : "The live state could not be read." };
  }
}

/** The runtime screen, from what Z-Factory has stored. `liveError` says why a live reading failed. */
export async function getPlcRuntimeView(
  db: PrismaClient,
  actor: Actor,
  plcId: string,
  options: { liveError?: string | null } = {},
): Promise<PlcRuntimeView> {
  const { device, profile } = await loadPlc(db, actor, plcId);
  const [versions, events] = await Promise.all([
    plcRepository.listProgramVersions(db, device.id),
    plcRepository.listDeviceEvents(db, device.id, RUNTIME_EVENT_COUNT),
  ]);
  const selected = versions.find((version) => version.id === profile.programVersionId);
  const deployed = versions.find((version) => version.status === "DEPLOYED");
  const modbus = device.runtimePorts.find((port) => port.protocol === "MODBUS_TCP" && port.hostPort);

  return {
    state: device.runtimeStatus,
    created: Boolean(device.dockerContainerId),
    serviceName: device.hostName,
    runtimeVersion: profile.runtimeVersion,
    image: profile.runtimeImage,
    modbus: modbus?.hostPort ? { bindAddress: modbus.bindAddress, hostPort: modbus.hostPort } : null,
    selectedProgram: selected ? { version: selected.version, status: selected.status } : null,
    deployedProgram: deployed ? { version: deployed.version } : null,
    events: events.map((event) => ({
      id: event.id,
      type: event.type,
      severity: event.severity,
      occurredAt: event.occurredAt.toISOString(),
      detail: eventDetail(event.payloadJson),
    })),
    liveError: options.liveError ?? null,
  };
}
