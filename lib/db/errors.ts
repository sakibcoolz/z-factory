import "server-only";
import { DomainError, type DomainErrorCode } from "@/lib/domain/errors";

/**
 * Translates database constraint failures into domain errors so that callers never see
 * (or leak) driver messages. Anything unrecognized is rethrown unchanged.
 */

type ConstraintRule = { code: DomainErrorCode; message: string };

const CONSTRAINTS: Record<string, ConstraintRule> = {
  Factory_slug_key: { code: "CONFLICT", message: "A factory with this slug already exists." },
  Factory_ownerId_name_key: { code: "CONFLICT", message: "You already have a factory with this name." },
  Factory_subnetCidr_key: { code: "CONFLICT", message: "This subnet is already used by another factory." },
  Factory_subnet_no_overlap: { code: "CONFLICT", message: "This subnet overlaps the network of another factory." },
  Factory_dockerNetworkName_key: { code: "CONFLICT", message: "This Docker network name is already in use." },
  Factory_slug_check: { code: "VALIDATION", message: "Slug must be lowercase letters, digits and single hyphens." },
  Factory_name_check: { code: "VALIDATION", message: "Factory name must not be blank." },
  DeviceInstance_factoryId_name_key: {
    code: "CONFLICT",
    message: "A device with this name already exists in the factory.",
  },
  DeviceInstance_name_check: { code: "VALIDATION", message: "Device name must not be blank." },
  DeviceConnection_one_motor_per_drive: {
    code: "INVARIANT",
    message: "This drive already has its primary motor (one VFD drives one motor).",
  },
  DeviceConnection_one_drive_per_motor: {
    code: "INVARIANT",
    message: "This motor is already driven by another drive.",
  },
  DeviceConnection_source_io_point_once: { code: "OCCUPIED_ENDPOINT", message: "This I/O point is already wired." },
  DeviceConnection_target_io_point_once: { code: "OCCUPIED_ENDPOINT", message: "This I/O point is already wired." },
  DeviceConnection_distinct_devices_check: {
    code: "VALIDATION",
    message: "A device cannot be connected to itself.",
  },
  PlcIoPoint_source_check: {
    code: "INVARIANT",
    message: "An I/O point comes from a built-in channel or from a module channel, never both.",
  },
  PlcIoPoint_plcInstanceId_logicalAddress_key: {
    code: "CONFLICT",
    message: "This logical address is already assigned on the PLC.",
  },
  Tag_plcInstanceId_name_key: { code: "CONFLICT", message: "A tag with this name already exists on the PLC." },
  Tag_plcIoPointId_key: { code: "OCCUPIED_ENDPOINT", message: "This I/O point already has a tag." },
  Tag_plcInstanceId_protocol_protocolArea_protocolAddress_key: {
    code: "CONFLICT",
    message: "This protocol address is already mapped on the PLC.",
  },
  Tag_writable_role_check: {
    code: "INVARIANT",
    message: "Only COMMAND and SETPOINT tags may be writable.",
  },
  Tag_writable_area_check: { code: "INCOMPATIBLE", message: "This Modbus area is read-only." },
  Tag_io_point_read_only_check: {
    code: "INVARIANT",
    message: "A tag on a PLC I/O point is the program's local I/O and is never externally writable.",
  },
  FactoryModule_factoryRackId_slotIndex_key: {
    code: "OCCUPIED_ENDPOINT",
    message: "This slot already holds a module.",
  },
  RuntimePort_bindAddress_hostPort_key: { code: "CONFLICT", message: "This host port is already published." },
  ProcessModuleType_code_version_key: {
    code: "CONFLICT",
    message: "This version of the module type already exists. Publish the change as a new version.",
  },
  ProcessModuleInstance_factoryId_name_key: {
    code: "CONFLICT",
    message: "A process module with this name already exists in the factory.",
  },
  ProcessModuleInstance_name_check: { code: "VALIDATION", message: "Module name must not be blank." },
  ModuleDevice_processModuleInstanceId_moduleRoleDefinitionId_key: {
    code: "CONFLICT",
    message: "This device already has this role in the module.",
  },
  ModuleInterlock_processModuleInstanceId_code_key: {
    code: "CONFLICT",
    message: "The module already has an interlock with this code.",
  },
  PlcCommunicationConnection_sourcePlcInstanceId_targetPlcInstanceId_protocol_key: {
    code: "CONFLICT",
    message: "These two PLCs already have a link over this protocol in this direction.",
  },
  PlcCommunicationConnection_distinct_plcs_check: { code: "VALIDATION", message: "A PLC cannot be linked to itself." },
  PlcCommunicationConnection_roles_check: {
    code: "INVARIANT",
    message: "The client and the server of a link are its two PLCs, one each.",
  },
  PlcCommunicationConnection_endpoint_check: {
    code: "VALIDATION",
    message: "Port, unit id or poll interval of the link is out of range.",
  },
  PlcCommunicationMapping_one_reader_per_local_tag: {
    code: "OCCUPIED_ENDPOINT",
    message: "This tag is already filled by another PLC link.",
  },
  PlcCommunicationMapping_one_writer_per_remote_tag: {
    code: "OCCUPIED_ENDPOINT",
    message: "This command tag is already written by another PLC link.",
  },
  PlcCommunicationMapping_plcCommunicationConnectionId_localTagId_remoteTagId_key: {
    code: "CONFLICT",
    message: "This link already carries these two tags.",
  },
  PlcCommunicationMapping_distinct_tags_check: { code: "VALIDATION", message: "A mapping joins two different tags." },
  PlcCommunicationMapping_interval_check: {
    code: "VALIDATION",
    message: "The update interval is out of range (50–60000 ms).",
  },
  ModulePlcIoMapping_tagId_key: {
    code: "OCCUPIED_ENDPOINT",
    message: "This tag already carries a module signal.",
  },
  ModulePlcIoMapping_processModuleInstanceId_moduleSignalDefinitionId_key: {
    code: "CONFLICT",
    message: "This signal is already bound; release or rebind it.",
  },
  ModuleSignalDefinition_direction_role_check: {
    code: "INVARIANT",
    message: "An OUTPUT signal is a command or a setpoint, and only an OUTPUT is.",
  },
};

type DriverCause = {
  originalCode?: string;
  originalMessage?: string;
  constraint?: { index?: string };
};

type PrismaRequestError = {
  code: string;
  meta?: { driverAdapterError?: { cause?: DriverCause } };
};

function isPrismaRequestError(error: unknown): error is PrismaRequestError {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string" &&
    /^P\d{4}$/.test((error as { code: string }).code)
  );
}

function constraintName(cause: DriverCause | undefined): string | undefined {
  if (cause?.constraint?.index) return cause.constraint.index;
  // CHECK and EXCLUDE violations only name the constraint inside the driver message.
  return cause?.originalMessage?.match(/constraint "([^"]+)"/)?.[1];
}

export function toDomainError(error: unknown): DomainError | undefined {
  if (!isPrismaRequestError(error)) return undefined;
  const cause = error.meta?.driverAdapterError?.cause;
  const constraint = constraintName(cause);
  const known = constraint ? CONSTRAINTS[constraint] : undefined;
  if (known) return new DomainError(known.code, known.message, { constraint });

  switch (error.code) {
    case "P2002":
      return new DomainError("CONFLICT", "A record with these values already exists.", { constraint });
    case "P2025":
      return new DomainError("NOT_FOUND", "The record was not found.");
    case "P2003":
      return cause?.originalMessage?.startsWith("update or delete")
        ? new DomainError("CONFLICT", "The record is still referenced and cannot be removed.", { constraint })
        : new DomainError("NOT_FOUND", "A referenced record does not exist.", { constraint });
    default:
      if (cause?.originalCode === "23514") {
        return new DomainError("VALIDATION", "The values violate a data rule.", { constraint });
      }
      if (cause?.originalCode === "23P01") {
        return new DomainError("CONFLICT", "The values conflict with an existing record.", { constraint });
      }
      return undefined;
  }
}

/** Runs a database operation, rethrowing constraint failures as domain errors. */
export async function withDomainErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toDomainError(error) ?? error;
  }
}
