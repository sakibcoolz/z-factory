/**
 * The PLC engineering export (docs/plc-export.md): one normalized document from which
 * the printable report, the CSV schedules and the JSON file are all produced. Pure types.
 *
 * The document carries Z-Factory ids and engineering data only. It never holds container
 * ids, credentials, the Docker endpoint or host paths; `assertExportIsClean` enforces that.
 */

export const PLC_EXPORT_SCHEMA = "z-factory.plc-export";
export const PLC_EXPORT_SCHEMA_VERSION = 1;

export type ExportIoPoint = {
  /** `BUILT_IN` or the slot the module sits in. */
  source: "BUILT_IN" | "MODULE";
  slot: number | null;
  module: string | null;
  ioType: "DI" | "DO" | "AI" | "AO";
  channel: string;
  /** The vendor's own address, where its documentation prints one. */
  vendorAddress: string | null;
  /** Address the program uses in Z-Factory. */
  programAddress: string;
  signalTypes: string[];
  status: string;
  device: string | null;
  deviceTerminal: string | null;
  tag: string | null;
};

export type ExportTag = {
  name: string;
  role: string;
  dataType: string;
  direction: string;
  programAddress: string;
  modbusArea: string;
  /** Zero-based address within the area. */
  modbusAddress: number;
  /** One-based 5/6-digit notation, for people. */
  modbusDisplayAddress: string;
  wordCount: number;
  accessMode: string;
  byteOrder: string;
  wordOrder: string;
  scale: number;
  offset: number;
  unit: string | null;
  sourceDevice: string | null;
  sourceSignal: string | null;
  /** Who drives the tag (ADR-0015): PROGRAM_OUTPUT, PROGRAM_INPUT, SIMULATION_FEEDBACK, EXTERNAL_COMMAND or PROGRAM_INTERNAL. */
  authority: string;
};

/** One row of the connected-device schedule. */
export type ExportScheduleRow = {
  plcPoint: string;
  tag: string | null;
  device: string;
  model: string;
  relationship: string;
  signalOrProtocol: string;
  address: string | null;
  unit: string | null;
};

/** A process-module signal a tag of this PLC carries (docs/process-modules.md → Module PLC I/O Registry). */
export type ExportModuleSignal = {
  module: string;
  moduleType: string;
  signal: string;
  direction: string;
  tag: string;
  programAddress: string;
};

/** A PLC-to-PLC link this PLC takes part in (Phase 07, TASK-701). */
export type ExportPlcLink = {
  relationship: string;
  /** This PLC's protocol role on the link. */
  role: "client" | "server";
  peer: string;
  protocol: string;
  serverHost: string;
  serverPort: number;
  unitId: number;
  pollIntervalMs: number;
  enabled: boolean;
  configVersion: number;
};

export type PlcExportDocument = {
  schema: typeof PLC_EXPORT_SCHEMA;
  schemaVersion: typeof PLC_EXPORT_SCHEMA_VERSION;
  /** ISO-8601 time the export was produced. */
  generatedAt: string;
  revision: {
    /** Hash of the exported configuration; equal configurations give equal revisions. */
    configuration: string;
    ioMapping: number;
    modbusMapping: number;
    program: null | { version: number; language: string; checksum: string; status: string; createdAt: string };
    /** Configuration snapshot recorded at the last deployment, if any. */
    deployedSnapshot: null | { version: number; createdAt: string };
  };
  factory: { id: string; name: string; slug: string; subnetCidr: string };
  plc: {
    id: string;
    name: string;
    role: string | null;
    architecture: "COMPACT" | "MODULAR";
    runtime: string;
    runtimeNote: string;
    runtimeImage: string | null;
    runtimeVersion: string | null;
  };
  model: {
    manufacturer: string;
    family: string;
    modelName: string;
    sku: string | null;
    verificationStatus: string;
    source: null | { title: string | null; revision: string | null; url: string | null; verifiedAt: string | null };
    facts: Record<string, unknown>;
  };
  electrical: null | {
    supplyType: string | null;
    nominalVoltage: number | null;
    voltageMin: number | null;
    voltageMax: number | null;
  };
  ports: Array<{ name: string; physicalType: string; protocols: string[]; portCount: number }>;
  hardware: {
    channels: Array<{ ioType: string; count: number; occupied: number }>;
    rack: null | {
      name: string;
      slotCount: number;
      modules: Array<{
        slot: number;
        modelName: string;
        sku: string | null;
        moduleType: string;
        channels: number;
        occupied: number;
      }>;
    };
  };
  ioPoints: ExportIoPoint[];
  tags: ExportTag[];
  /** Process-module signals carried by tags of this PLC (TASK-605). */
  moduleSignals: ExportModuleSignal[];
  connectedDevices: ExportScheduleRow[];
  /** Relationships among the PLC and every device reachable from it. */
  relationships: Array<{ source: string; relationship: string; target: string; detail: string }>;
  network: {
    /** DNS name of the PLC inside its factory network. */
    serviceName: string | null;
    modbusEndpoint: null | { bindAddress: string; hostPort: number; containerPort: number };
    modbusConventions: { addressBase: string; byteOrder: string; wordOrder: string };
    protocolLinks: Array<{ device: string; protocol: string }>;
    /** Links to other PLCs of the factory (TASK-701). */
    plcLinks: ExportPlcLink[];
  };
  topology: {
    nodes: Array<{ id: string; name: string; kind: string; x: number; y: number }>;
    edges: Array<{ sourceId: string; targetId: string; relationship: string; label: string }>;
  };
  /** Present only when a runtime snapshot was requested. */
  runtime?: { state: string; note: string };
  notice: string;
};

export const EXPORT_NOTICE =
  "Simulation is an approximation for control-software testing. It is not an electrical, mechanical or process certification, and the PLC runs on OpenPLC, not on vendor firmware.";

/** The 15 report sections of docs/plc-export.md, in order. */
export const REPORT_SECTIONS = [
  "Factory & PLC identity",
  "Model, order number & architecture",
  "Process role & runtime",
  "Power & communication",
  "I/O structure",
  "Channel occupancy & terminal assignments",
  "Tag list",
  "Modbus register map",
  "Connected-device schedule",
  "Device relationships",
  "Network & protocol configuration",
  "Program, configuration & runtime versions",
  "Runtime status snapshot",
  "Topology diagram",
  "Export timestamp & configuration revision",
] as const;
