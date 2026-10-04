/** URL builders for every screen. IDs are Z-Factory IDs, never Docker IDs. */

export const PLC_ARCHITECTURE_SLUGS = ["compact", "modular"] as const;

export type PlcArchitectureSlug = (typeof PLC_ARCHITECTURE_SLUGS)[number];

const factory = (factoryId: string) => `/factories/${encodeURIComponent(factoryId)}`;
const plc = (factoryId: string, plcId: string) => `${factory(factoryId)}/plcs/${encodeURIComponent(plcId)}`;

export const routes = {
  factories: () => "/factories",
  newFactory: () => "/factories/new",
  welcome: () => "/welcome",
  catalog: () => "/catalog",
  designer: (factoryId: string) => `${factory(factoryId)}/designer`,
  topology: (factoryId: string) => `${factory(factoryId)}/topology`,
  view3d: (factoryId: string) => `${factory(factoryId)}/view-3d`,
  newDevice: (factoryId: string, architecture: PlcArchitectureSlug) =>
    `${factory(factoryId)}/devices/new/${architecture}`,
  simulator: (factoryId: string) => `${factory(factoryId)}/simulator`,
  runtime: (factoryId: string) => `${factory(factoryId)}/runtime`,
  tags: (factoryId: string) => `${factory(factoryId)}/tags`,
  events: (factoryId: string) => `${factory(factoryId)}/events`,
  plc,
  plcProgram: (factoryId: string, plcId: string) => `${plc(factoryId, plcId)}/program`,
  plcIoMapping: (factoryId: string, plcId: string) => `${plc(factoryId, plcId)}/io-mapping`,
  plcExport: (factoryId: string, plcId: string) => `${plc(factoryId, plcId)}/export`,
} as const;
