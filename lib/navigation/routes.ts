/** URL builders for every screen. IDs are Z-Factory IDs, never Docker IDs. */

export const PLC_ARCHITECTURE_SLUGS = ["compact", "modular"] as const;

export type PlcArchitectureSlug = (typeof PLC_ARCHITECTURE_SLUGS)[number];

export const PLC_EXPORT_FILES = ["plc.json", "io.csv", "tags.csv", "devices.csv"] as const;
export type PlcExportFile = (typeof PLC_EXPORT_FILES)[number];

const factory = (factoryId: string) => `/factories/${encodeURIComponent(factoryId)}`;
const plc = (factoryId: string, plcId: string) => `${factory(factoryId)}/plcs/${encodeURIComponent(plcId)}`;

export const routes = {
  factories: () => "/factories",
  newFactory: () => "/factories/new",
  /** The catalog, optionally on one model and/or narrowed to one device category. */
  catalog: (query: { model?: string; type?: string } = {}) => {
    const search = new URLSearchParams(Object.entries(query).filter(([, value]) => Boolean(value)));
    return search.size > 0 ? `/catalog?${search}` : "/catalog";
  },
  /** The GLB of one catalog 3D asset version. Its content never changes. */
  modelAsset: (assetId: string) => `/assets/models/${encodeURIComponent(assetId)}/model.glb`,
  factory,
  editFactory: (factoryId: string) => `${factory(factoryId)}/edit`,
  designer: (factoryId: string) => `${factory(factoryId)}/designer`,
  topology: (factoryId: string) => `${factory(factoryId)}/topology`,
  view3d: (factoryId: string) => `${factory(factoryId)}/view-3d`,
  newDevice: (factoryId: string, architecture: PlcArchitectureSlug) =>
    `${factory(factoryId)}/devices/new/${architecture}`,
  simulator: (factoryId: string) => `${factory(factoryId)}/simulator`,
  runtime: (factoryId: string) => `${factory(factoryId)}/runtime`,
  /** External gateways of the factory: their endpoints and the tags they are given. */
  gateways: (factoryId: string) => `${factory(factoryId)}/gateways`,
  /** What an edge device is configured from, as a JSON download. */
  gatewayMap: (factoryId: string, connectionId: string) =>
    `${factory(factoryId)}/gateways/${encodeURIComponent(connectionId)}/map.json`,
  /** Live tags; `plc` narrows the list to one PLC. */
  tags: (factoryId: string, plc?: string) =>
    `${factory(factoryId)}/tags${plc ? `?plc=${encodeURIComponent(plc)}` : ""}`,
  /** Alarms and recorded events, optionally filtered. */
  events: (factoryId: string, query: { device?: string; family?: string; severity?: string } = {}) => {
    const search = new URLSearchParams(Object.entries(query).filter(([, value]) => Boolean(value)));
    return `${factory(factoryId)}/events${search.size > 0 ? `?${search}` : ""}`;
  },
  /** Process modules of the factory (TASK-604), and one module's editor. */
  modules: (factoryId: string) => `${factory(factoryId)}/modules`,
  module: (factoryId: string, moduleId: string) => `${factory(factoryId)}/modules/${encodeURIComponent(moduleId)}`,
  /** The module's bindings by names, as a JSON download that `importModuleIo` reads. */
  moduleIoFile: (factoryId: string, moduleId: string) =>
    `${factory(factoryId)}/modules/${encodeURIComponent(moduleId)}/export/module-io.json`,
  /** Server-sent events: the factory's live channel. */
  stream: (factoryId: string) => `${factory(factoryId)}/stream`,
  plc,
  /** Pin view; `pin` selects one I/O point. */
  /** A device that is not a controller: its screens are assembled from the model's capabilities (TASK-308). */
  device: (factoryId: string, deviceId: string) => `${factory(factoryId)}/devices/${deviceId}`,
  deviceConnections: (factoryId: string, deviceId: string) => `${factory(factoryId)}/devices/${deviceId}/connections`,
  deviceParameters: (factoryId: string, deviceId: string) => `${factory(factoryId)}/devices/${deviceId}/parameters`,
  deviceRegisters: (factoryId: string, deviceId: string) => `${factory(factoryId)}/devices/${deviceId}/registers`,
  deviceCommunications: (factoryId: string, deviceId: string) =>
    `${factory(factoryId)}/devices/${deviceId}/communications`,
  plcHardware: (factoryId: string, plcId: string, pin?: string) =>
    `${plc(factoryId, plcId)}/hardware${pin ? `?pin=${encodeURIComponent(pin)}` : ""}`,
  /** The devices wired to the PLC, read from the factory's wiring. */
  plcConnections: (factoryId: string, plcId: string) => `${plc(factoryId, plcId)}/connections`,
  /** Program editor; `version` opens a stored version instead of the selected one. */
  plcProgram: (factoryId: string, plcId: string, version?: number) =>
    `${plc(factoryId, plcId)}/program${version ? `?version=${version}` : ""}`,
  plcVersions: (factoryId: string, plcId: string) => `${plc(factoryId, plcId)}/versions`,
  plcRuntime: (factoryId: string, plcId: string) => `${plc(factoryId, plcId)}/runtime`,
  plcIoMapping: (factoryId: string, plcId: string) => `${plc(factoryId, plcId)}/io-mapping`,
  plcExport: (factoryId: string, plcId: string) => `${plc(factoryId, plcId)}/export`,
  /** The PLC's links to other PLCs and the values they carry (Phase 07). */
  plcCommunication: (factoryId: string, plcId: string) => `${plc(factoryId, plcId)}/communication`,
  /** A link with its mappings as a JSON download (`z-factory.plc-link`). */
  plcLinkFile: (factoryId: string, plcId: string, linkId: string) =>
    `${plc(factoryId, plcId)}/communication/${encodeURIComponent(linkId)}/link.json`,
  /** The report alone, for printing. `runtime` adds the stored runtime state. */
  plcExportReport: (factoryId: string, plcId: string, runtime = false) =>
    `${plc(factoryId, plcId)}/export/report${runtime ? "?runtime=1" : ""}`,
  /** A download: `plc.json`, `io.csv`, `tags.csv` or `devices.csv`. */
  plcExportFile: (factoryId: string, plcId: string, file: PlcExportFile) =>
    `${plc(factoryId, plcId)}/export/files/${file}`,
} as const;
