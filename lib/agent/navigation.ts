import { routes } from "@/lib/navigation/routes";

/**
 * Agent navigation (TASK-1004): how a user's intention maps to an engineering area, and
 * how the areas follow each other. One registry, keyed by the areas of the LLM Index,
 * from which the index renders its "Where to go" section and every page's LLM Context
 * gets its upstream and downstream links. `lib/agent/navigation.test.ts` fails when an
 * area has no guidance or guidance names an area that does not exist.
 */

/** The ids a page's route carries; what an area's entry route needs to be built. */
export type RouteIds = { factoryId?: string; plcId?: string; deviceId?: string; moduleId?: string };

export type AreaGuidance = {
  /** What a user wants, in their words, that this area is for. */
  intents: readonly string[];
  /** Areas usually visited before this one (keys of the LLM Index). */
  upstream: readonly string[];
  /** Areas usually visited after this one. */
  downstream: readonly string[];
  /** The area's entry route for the ids at hand; undefined when an id is missing. */
  open: (ids: RouteIds) => string | undefined;
};

const factory = (make: (factoryId: string) => string) => (ids: RouteIds) =>
  ids.factoryId ? make(ids.factoryId) : undefined;
const plc = (make: (factoryId: string, plcId: string) => string) => (ids: RouteIds) =>
  ids.factoryId && ids.plcId ? make(ids.factoryId, ids.plcId) : undefined;

export const AREA_GUIDANCE: Readonly<Record<string, AreaGuidance>> = {
  factories: {
    intents: [
      "open a factory",
      "create a factory",
      "see which factories exist and their state",
      "build the pump station demo",
    ],
    upstream: ["llm-index"],
    downstream: ["factory", "catalog"],
    open: () => routes.factories(),
  },
  catalog: {
    intents: [
      "find a model for a pump, valve, sensor, drive, motor or PLC",
      "compare vendor and generic models",
      "check what a model can do, its I/O and its sources",
      "see which peripherals a PLC can be wired to",
    ],
    upstream: ["factories", "factory"],
    downstream: ["designer", "devices"],
    open: () => routes.catalog(),
  },
  factory: {
    intents: [
      "understand the whole plant",
      "see every device of a factory",
      "rename a factory or change its subnet",
      "delete a factory",
    ],
    upstream: ["factories"],
    downstream: ["designer", "devices", "runtime", "export"],
    open: factory(routes.factory),
  },
  designer: {
    intents: [
      "add a pump, valve, sensor, drive or motor to the plant",
      "connect a sensor, drive, motor or pump to a PLC",
      "wire a device pin to pin",
      "remove a device or a connection",
      "rename a device or set its process role",
    ],
    upstream: ["catalog", "factory", "devices"],
    downstream: ["plc", "topology", "program"],
    open: factory(routes.designer),
  },
  topology: {
    intents: ["see the wiring and network without changing it", "show the plant in 3D"],
    upstream: ["designer"],
    downstream: ["designer", "runtime"],
    open: factory(routes.topology),
  },
  devices: {
    intents: [
      "create a PLC, compact or modular",
      "read or set a device's parameters",
      "see a device's registers, wires or protocol links",
    ],
    upstream: ["catalog", "factory"],
    downstream: ["designer", "plc"],
    open: factory((factoryId) => routes.newDevice(factoryId, "compact")),
  },
  plc: {
    intents: [
      "select or configure a PLC",
      "find available AI, DI, DO or AO channels",
      "install a module in a modular PLC",
      "read a channel's Modbus address and tag",
      "see what is wired to a PLC",
    ],
    upstream: ["designer", "devices"],
    downstream: ["program", "plc-communication", "runtime", "export"],
    open: plc(routes.plc),
  },
  program: {
    intents: [
      "write or change the control logic",
      "compile a program and read the findings",
      "select or roll back a program version",
      "deploy a program",
    ],
    upstream: ["plc"],
    downstream: ["runtime", "simulation", "export"],
    open: plc((factoryId, plcId) => routes.plcProgram(factoryId, plcId)),
  },
  "plc-communication": {
    intents: ["link two PLCs", "pass a value from one PLC to another"],
    upstream: ["plc"],
    downstream: ["program", "runtime"],
    open: plc(routes.plcCommunication),
  },
  modules: {
    intents: ["model a process such as a tank, heater or boiler", "bind a process signal to a PLC tag"],
    upstream: ["designer", "plc"],
    downstream: ["runtime", "simulation"],
    open: factory(routes.modules),
  },
  runtime: {
    intents: ["start or stop the factory", "start, deploy to, restart or stop one PLC", "see a PLC's real state"],
    upstream: ["program", "factory"],
    downstream: ["tags", "simulation", "events"],
    open: factory(routes.runtime),
  },
  simulation: {
    intents: [
      "test high temperature, a drive trip or a stuck valve",
      "inject or clear a device fault",
      "run a closed-loop scenario",
      "override a process value",
    ],
    upstream: ["runtime"],
    downstream: ["tags", "events"],
    open: factory(routes.simulator),
  },
  tags: {
    intents: ["read live values", "write a command or setpoint tag"],
    upstream: ["runtime"],
    downstream: ["events", "simulation"],
    open: factory(routes.tags),
  },
  events: {
    intents: [
      "find out why a device faulted",
      "see the active alarms",
      "acknowledge an alarm",
      "follow what a scenario did",
    ],
    upstream: ["runtime", "simulation", "tags"],
    downstream: ["runtime", "designer"],
    open: factory(routes.events),
  },
  gateways: {
    intents: [
      "expose PLC tags to an edge device",
      "open a Modbus TCP endpoint for an external client",
      "download a gateway's register map",
    ],
    upstream: ["plc", "runtime"],
    downstream: ["tags", "export"],
    open: factory(routes.gateways),
  },
  export: {
    intents: [
      "generate the Thin Client Agent configuration",
      "export a PLC's engineering snapshot",
      "print a PLC's report",
    ],
    upstream: ["plc", "program"],
    downstream: ["gateways"],
    open: plc(routes.plcExport),
  },
  "llm-index": {
    intents: ["understand the whole application before navigating"],
    upstream: [],
    downstream: ["factories", "catalog"],
    open: () => routes.llmIndex(),
  },
};

/** The ids a page's route carries, read from the route itself. */
export function routeIds(route: string): RouteIds {
  const path = route.split("?")[0] ?? "";
  const take = (segment: string) => path.match(new RegExp(`/${segment}/([^/]+)`))?.[1];
  const ids: RouteIds = {};
  const factoryId = take("factories");
  if (factoryId && factoryId !== "new") ids.factoryId = factoryId;
  const plcId = take("plcs");
  if (plcId) ids.plcId = plcId;
  const deviceId = take("devices");
  if (deviceId && deviceId !== "new") ids.deviceId = deviceId;
  const moduleId = take("modules");
  if (moduleId) ids.moduleId = moduleId;
  return ids;
}

export type CrossPageLink = {
  relation: "upstream" | "downstream";
  area: string;
  href?: string;
};

/** The areas before and after one area, with an entry route where the ids allow it. */
export function crossPageLinks(area: string, ids: RouteIds): CrossPageLink[] {
  const guidance = AREA_GUIDANCE[area];
  if (!guidance) return [];
  const link = (relation: CrossPageLink["relation"]) => (key: string) => ({
    relation,
    area: key,
    href: AREA_GUIDANCE[key]?.open(ids),
  });
  return [...guidance.upstream.map(link("upstream")), ...guidance.downstream.map(link("downstream"))];
}

/** Every intent with the area it leads to; what the LLM Index's "Where to go" lists. */
export function intentIndex(): Array<{ intent: string; area: string }> {
  return Object.entries(AREA_GUIDANCE).flatMap(([area, guidance]) =>
    guidance.intents.map((intent) => ({ intent, area })),
  );
}
