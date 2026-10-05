/**
 * Shapes the gateway service returns and the gateway screen renders
 * (docs/gateway-modbus.md). Pure types; importable anywhere.
 */
import type { RuntimeState } from "@/lib/domain/runtime-state";
import type { ModbusArea, TagDataType, TagRole } from "@/lib/domain/tag";

export type GatewayAccess = "READ" | "READ_WRITE";

/** A tag mapped to a gateway, at the address the gateway reads or writes it. */
export type GatewayRegisterView = {
  mappingId: string;
  tagId: string;
  tagName: string;
  /** The name the gateway knows the value by. */
  externalName: string;
  role: TagRole;
  dataType: TagDataType;
  area: ModbusArea;
  /** Zero-based address within its area. */
  address: number;
  /** `40001`-style address for people; never used by the protocol. */
  displayAddress: string;
  wordCount: number;
  access: GatewayAccess;
  unit: string | null;
};

export type GatewayEndpointView = {
  listening: boolean;
  /** Why the endpoint is not open, when it should be. */
  error: string | null;
  clients: number;
  requests: number;
  refused: number;
  lastRequestAt: string | null;
};

export type GatewayConnectionView = {
  id: string;
  plcId: string;
  plcName: string;
  /** Last stored state of the PLC runtime; a gateway reads nothing from a PLC that is not started. */
  plcState: RuntimeState;
  /** Address and port of this host the gateway connects to. */
  host: string;
  port: number;
  unitId: number;
  /** How often the gateway is expected to read, in milliseconds. */
  pollIntervalMs: number;
  enabled: boolean;
  endpoint: GatewayEndpointView;
  registers: GatewayRegisterView[];
  /** Tags of the PLC the gateway has not been given. */
  unmappedTags: Array<{ id: string; name: string; role: TagRole; dataType: TagDataType; writable: boolean }>;
};

export type GatewayView = {
  deviceId: string;
  name: string;
  modelName: string;
  connections: GatewayConnectionView[];
  /** PLCs of the factory this gateway is not connected to yet. */
  availablePlcs: Array<{ id: string; name: string }>;
};

export type GatewaysView = {
  factory: { id: string; name: string };
  gateways: GatewayView[];
  /** Addresses of this host an endpoint may listen on (`RUNTIME_BIND_ADDRESSES`). */
  bindAddresses: string[];
  portRange: { min: number; max: number };
  /** A port of the range nothing is configured on yet. */
  suggestedPort: number | null;
  hasPlc: boolean;
};

/** What an edge client is configured from: where to connect and what it may read and write. */
export type GatewayMapDocument = {
  schema: "z-factory.gateway-map";
  schemaVersion: 1;
  gateway: string;
  plc: string;
  endpoint: { protocol: "MODBUS_TCP"; host: string; port: number; unitId: number };
  pollIntervalMs: number;
  conventions: { addressing: "zero-based"; byteOrder: "BIG_ENDIAN"; wordOrder: "HIGH_WORD_FIRST" };
  registers: Array<{
    name: string;
    tag: string;
    role: TagRole;
    dataType: TagDataType;
    area: ModbusArea;
    address: number;
    displayAddress: string;
    wordCount: number;
    access: GatewayAccess;
    scale: number;
    offset: number;
    unit: string | null;
  }>;
};
