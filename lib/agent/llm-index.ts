import { LLM_CONTEXT_AREAS } from "@/lib/agent/contexts/registry";
import { ACTIVITIES, type ActivityKey } from "@/lib/navigation/activities";
import { routes } from "@/lib/navigation/routes";

/**
 * The LLM Index (TASK-1001): what an external browser or coding agent reads first to
 * understand Z-Factory Engineering before it navigates. It is one registry, rendered as the
 * `/llm-index` page and as `/llm-index.md`. Every entry names the route builder it covers,
 * and `lib/agent/llm-index.test.ts` fails when a builder in `routes` is not listed, so the
 * index cannot drift from the screens that exist.
 *
 * There is no embedded model and no MCP (Phase 10): the agent uses the normal UI and its
 * validation, and asks the user for the decisions listed here.
 */

type RouteKey = keyof typeof routes;

export type AreaScope = "workspace" | "factory" | "plc" | "device" | "module";

export type AreaRoute = {
  /** The builder in `lib/navigation/routes.ts` this pattern comes from. */
  key: RouteKey;
  /** The URL pattern, with `[factoryId]`-style placeholders. */
  pattern: string;
  /** What the page is, when the area has more than one. */
  note?: string;
};

export type EngineeringArea = {
  key: string;
  label: string;
  scope: AreaScope;
  /** The activity-bar entry the area opens under; none when it is reached from another page. */
  activity?: ActivityKey;
  routes: readonly AreaRoute[];
  /** What the area is for. */
  purpose: string;
  /** The tasks an agent brings here. */
  tasks: readonly string[];
  /** The decisions the agent asks the user for here, instead of guessing. */
  decisions: readonly string[];
  /** Whether its pages have an LLM Context panel (TASK-1002, TASK-1003); from `LLM_CONTEXT_AREAS`. */
  llmContext: boolean;
};

type AreaDefinition = Omit<EngineeringArea, "llmContext">;

export type AgentFile = {
  key: RouteKey;
  pattern: string;
  purpose: string;
};

export type WorkflowStep = {
  /** The area the step happens in. */
  area: string;
  text: string;
};

export type AgentRule = {
  title: string;
  text: string;
  /** Where the rule is decided: `docs/rules.md` numbers, ADRs. */
  source: string;
};

export type LlmIndex = {
  product: {
    name: string;
    purpose: string;
    model: readonly string[];
    /** What runs for real and what is simulated. */
    reality: readonly string[];
  };
  activities: ReadonlyArray<{ key: ActivityKey; short: string; label: string; factoryScoped: boolean }>;
  areas: readonly EngineeringArea[];
  files: readonly AgentFile[];
  workflow: readonly WorkflowStep[];
  rules: readonly AgentRule[];
  /** The `[placeholder]` names used in patterns and what they are. */
  placeholders: ReadonlyArray<{ name: string; meaning: string }>;
};

// The builders take ids; these stand in and are turned back into `[name]` placeholders.
const F = "factoryId";
const P = "plcId";
const D = "deviceId";
const M = "moduleId";
const C = "connectionId";
const L = "linkId";
const A = "assetId";
const PLACEHOLDER = /\/(factoryId|plcId|deviceId|moduleId|connectionId|linkId|assetId)(?=\/|$)/g;

/** A route builder's result with its ids as `[name]` placeholders and no query string. */
export function routePattern(path: string): string {
  return path.split("?")[0]!.replace(PLACEHOLDER, "/[$1]");
}

const route = (key: RouteKey, path: string, note?: string): AreaRoute => ({ key, pattern: routePattern(path), note });

const AREAS: readonly AreaDefinition[] = [
  {
    key: "factories",
    label: "Factories",
    scope: "workspace",
    activity: "factories",
    routes: [
      route("factories", routes.factories(), "the factories of the workspace, with their runtime state"),
      route("newFactory", routes.newFactory(), "create a factory; also builds the pump station demo"),
    ],
    purpose: "The entry point: the list of factories, their state, and where a factory is created.",
    tasks: ["open an existing factory", "create a factory", "build the pump station demo to learn the product"],
    decisions: ["the factory's name and slug", "its subnet, when the suggested free one is not wanted"],
  },
  {
    key: "catalog",
    label: "Device catalog",
    scope: "workspace",
    activity: "catalog",
    routes: [route("catalog", routes.catalog(), "`?model=` opens one model, `?type=` narrows to one category")],
    purpose:
      "The reusable models every factory device is created from: PLCs, modules, drives, motors, pumps, sensors and more, with provenance and 3D asset state.",
    tasks: [
      "find a model for a device the user wants (pump, VFD, sensor, PLC)",
      "check what a model can do before placing it",
      "see which peripherals are compatible with a PLC",
    ],
    decisions: [
      "which model: a vendor model (a hardware profile with sources, never vendor firmware) or a generic simulated one",
    ],
  },
  {
    key: "factory",
    label: "Factory overview and settings",
    scope: "factory",
    routes: [
      route(
        "factory",
        routes.factory(F),
        "the factory's devices as a hierarchy, and the way into every factory screen",
      ),
      route("editFactory", routes.editFactory(F), "name, description and subnet; delete"),
    ],
    purpose: "One factory: what it contains and its settings. Reached with Open on the Factories page.",
    tasks: [
      "understand a whole plant",
      "rename a factory or change its subnet while it is stopped",
      "delete a factory",
    ],
    decisions: ["deleting a factory, which removes its devices, programs and history"],
  },
  {
    key: "designer",
    label: "Designer",
    scope: "factory",
    activity: "designer",
    routes: [route("designer", routes.designer(F))],
    purpose:
      "Where devices are added from the catalog and wired. Drawing a connection creates the relationship the two devices allow; wiring picks free, compatible PLC channels and makes the tags.",
    tasks: [
      "add a device (drag a palette item or press its +)",
      "connect a sensor, drive, motor or pump to a PLC or to another device",
      "rename a device or set its process role",
      "remove a device or a connection",
    ],
    decisions: [
      "which relationship, when the canvas asks because more than one applies",
      "which device to wire to, when several PLCs or channels are compatible",
    ],
  },
  {
    key: "topology",
    label: "Topology and 3D view",
    scope: "factory",
    activity: "designer",
    routes: [
      route("topology", routes.topology(F), "the designer's canvas, read-only"),
      route("view3d", routes.view3d(F), "the factory in 3D with live runtime state"),
    ],
    purpose: "Read-only views of the same factory: the wiring and network topology, and the 3D scene.",
    tasks: ["read the wiring without changing it", "show the plant in 3D"],
    decisions: [],
  },
  {
    key: "devices",
    label: "Device configuration",
    scope: "device",
    activity: "designer",
    routes: [
      route("newDevice", routes.newDevice(F, "compact"), "create a compact PLC from a catalog model"),
      route("newDevice", routes.newDevice(F, "modular"), "create a modular PLC from a catalog model"),
      route("device", routes.device(F, D), "a device that is not a controller: its overview"),
      route("deviceConnections", routes.deviceConnections(F, D), "its wires, read from the factory's wiring"),
      route("deviceParameters", routes.deviceParameters(F, D), "its parameters, when the model has them"),
      route("deviceRegisters", routes.deviceRegisters(F, D), "its registers, when the model talks a protocol"),
      route("deviceCommunications", routes.deviceCommunications(F, D), "its protocol links"),
    ],
    purpose:
      "A single device's screens, assembled from what its catalog model can do. A PLC is created here; everything else is created in the designer.",
    tasks: [
      "create a PLC (compact or modular) in a factory",
      "read or set a device's parameters",
      "see a device's registers and protocol links",
    ],
    decisions: [
      "compact or modular PLC, and which model",
      "the instance name, when the next numbered name is not wanted",
      "parameter values that change how the machine behaves",
    ],
  },
  {
    key: "plc",
    label: "PLC hardware and I/O",
    scope: "plc",
    activity: "designer",
    routes: [
      route("plc", routes.plc(F, P), "the PLC's overview and its screens"),
      route(
        "plcHardware",
        routes.plcHardware(F, P),
        "the pin view; `?pin=` selects one point; modules and slots of a modular PLC",
      ),
      route("plcConnections", routes.plcConnections(F, P), "the devices wired to the PLC, read-only"),
      route(
        "plcIoMapping",
        routes.plcIoMapping(F, P),
        "every channel with program address, Modbus address, tag and device",
      ),
    ],
    purpose: "The PLC as hardware: its I/O points, installed modules, and how each channel maps to addresses and tags.",
    tasks: [
      "find free AI, DI, DO or AO channels before wiring",
      "install a module in a modular PLC's rack",
      "read the Modbus address and tag of a channel",
    ],
    decisions: ["which module to install, and in which slot"],
  },
  {
    key: "program",
    label: "PLC program and versions",
    scope: "plc",
    activity: "designer",
    routes: [
      route("plcProgram", routes.plcProgram(F, P), "the Structured Text editor; `?version=` opens a stored version"),
      route("plcVersions", routes.plcVersions(F, P), "every version, which one runs next, deploy now"),
    ],
    purpose:
      "The control logic of a PLC: edit, Check (compile), Save version, Save & deploy. A new PLC opens with a starter program that declares its tags.",
    tasks: ["write or change the control logic", "compile and read the findings", "select or roll back a version"],
    decisions: ["the control strategy, setpoints and interlocks: these are the user's engineering choices"],
  },
  {
    key: "plc-communication",
    label: "PLC-to-PLC communication",
    scope: "plc",
    activity: "designer",
    routes: [route("plcCommunication", routes.plcCommunication(F, P), "links to other PLCs and the values they carry")],
    purpose: "Modbus TCP links between PLCs of one factory, with their tag-to-tag mappings and link health.",
    tasks: ["link two PLCs", "map a value from one PLC into another"],
    decisions: ["which PLC is client and which is server", "which values cross the link"],
  },
  {
    key: "modules",
    label: "Process modules",
    scope: "module",
    activity: "designer",
    routes: [
      route("modules", routes.modules(F), "the factory's process modules"),
      route("module", routes.module(F, M), "one module's editor: its devices, signals and PLC I/O bindings"),
    ],
    purpose:
      "Process behaviour (a tank, a boiler) composed from the factory's devices and bound to PLC I/O; run by the Go process simulation service.",
    tasks: ["model a process around existing devices", "bind a module's signals to PLC tags"],
    decisions: ["which devices play which role in the module", "which PLC tags carry its signals"],
  },
  {
    key: "runtime",
    label: "Runtime",
    scope: "factory",
    activity: "runtime",
    routes: [
      route(
        "runtime",
        routes.runtime(F),
        "the factory's PLCs, simulation and Docker host; Start factory and Stop factory",
      ),
      route(
        "plcRuntime",
        routes.plcRuntime(F, P),
        "one PLC's runtime: Start, Deploy, Restart, Stop, Remove, Refresh state",
      ),
    ],
    purpose:
      "Running the plant. A PLC runs as an OpenPLC runtime in its own container on the factory's isolated network; the simulation and the gateway endpoints follow.",
    tasks: ["start or stop the factory", "start, deploy to, restart or stop one PLC", "read a runtime's real state"],
    decisions: ["starting or stopping anything that is running: say what will happen and ask first"],
  },
  {
    key: "simulation",
    label: "Simulator and scenarios",
    scope: "factory",
    activity: "runtime",
    routes: [
      route(
        "simulator",
        routes.simulator(F),
        "every simulated device: commands from PLC logic, feedback, faults, test inputs",
      ),
      route("scenarios", routes.scenarios(F), "closed-loop test scenarios, run and recorded"),
    ],
    purpose:
      "The simulated field: sensors, drives, motors, pumps and valves react to the PLC's outputs. Faults and overrides are test inputs; the PLC program still decides every output.",
    tasks: [
      "test high temperature, a drive trip or a stuck valve",
      "inject, clear and reset a device fault",
      "run a closed-loop scenario",
    ],
    decisions: ["which faults or overrides to apply to a running plant"],
  },
  {
    key: "tags",
    label: "Live tags",
    scope: "factory",
    activity: "tags",
    routes: [route("tags", routes.tags(F), "`?plc=` narrows to one PLC")],
    purpose: "The live values of every tag, read from the running PLCs, with writes to command and setpoint tags.",
    tasks: ["read what the PLC sees and drives", "write a command or setpoint tag that is externally writable"],
    decisions: ["the value to write, and whether to write at all while the plant runs"],
  },
  {
    key: "events",
    label: "Events and alarms",
    scope: "factory",
    activity: "events",
    routes: [route("events", routes.events(F), "`?device=`, `?family=`, `?severity=` filter")],
    purpose: "What happened: runtime events, device state changes, alarms and their history.",
    tasks: ["find out why a device faulted", "see the active alarms", "follow what a scenario did"],
    decisions: [],
  },
  {
    key: "gateways",
    label: "External gateways",
    scope: "factory",
    routes: [
      route("gateways", routes.gateways(F), "host endpoints an edge device connects to, and the tags they expose"),
    ],
    purpose:
      "How an external edge device or cloud reaches the PLCs: validated host endpoints over Modbus TCP that write command and setpoint tags and read feedback.",
    tasks: [
      "expose a PLC's command and feedback tags to an edge device",
      "download the register map an edge client uses",
    ],
    decisions: ["which host address and port to publish", "which tags an external client may write"],
  },
  {
    key: "export",
    label: "PLC engineering export",
    scope: "plc",
    activity: "export",
    routes: [
      route("plcExport", routes.plcExport(F, P), "the report preview and the downloads"),
      route(
        "plcExportReport",
        routes.plcExportReport(F, P),
        "the report alone, for printing; `?runtime=1` adds the stored runtime state",
      ),
    ],
    purpose:
      "The engineering snapshot of a PLC: specs, I/O, tags, Modbus map, connected devices, versions and topology, as a report and as files.",
    tasks: ["hand the design to a person or another tool", "generate the Thin Client Agent's deployment file"],
    decisions: [],
  },
  {
    key: "llm-index",
    label: "LLM Index",
    scope: "workspace",
    activity: "llm",
    routes: [route("llmIndex", routes.llmIndex(), "this guide")],
    purpose: "This guide: the product, its areas and routes, the agent workflow and the rules.",
    tasks: ["understand the whole application before navigating"],
    decisions: [],
  },
];

/** Files an agent can fetch; they are not screens. */
const FILES: readonly AgentFile[] = [
  { key: "llmIndexMarkdown", pattern: routePattern(routes.llmIndexMarkdown()), purpose: "this index as Markdown" },
  {
    key: "plcExportFile",
    pattern: routePattern(routes.plcExportFile(F, P, "plc.json")).replace("plc.json", "[file]"),
    purpose: "an export file: `plc.json`, `io.csv`, `tags.csv` or `devices.csv`",
  },
  {
    key: "plcEdgeDeployment",
    pattern: routePattern(routes.plcEdgeDeployment(F, P)),
    purpose: "the PLC's edge deployment for the Thin Client Agent",
  },
  {
    key: "gatewayMap",
    pattern: routePattern(routes.gatewayMap(F, C)),
    purpose: "a gateway's register map, what an edge client is configured from",
  },
  {
    key: "moduleIoFile",
    pattern: routePattern(routes.moduleIoFile(F, M)),
    purpose: "a process module's bindings by name, importable into another module",
  },
  {
    key: "plcLinkFile",
    pattern: routePattern(routes.plcLinkFile(F, P, L)),
    purpose: "a PLC-to-PLC link with its mappings",
  },
  {
    key: "stream",
    pattern: routePattern(routes.stream(F)),
    purpose: "the factory's live channel (server-sent events), used by the pages themselves",
  },
  { key: "modelAsset", pattern: routePattern(routes.modelAsset(A)), purpose: "a catalog model's 3D asset (GLB)" },
];

const WORKFLOW: readonly WorkflowStep[] = [
  { area: "llm-index", text: "Read this index. Fetch it as Markdown when you are not rendering pages." },
  {
    area: "factories",
    text: "Open the factory the user means, or create one with the name and subnet the user confirms. The pump station demo is the quickest way to see a complete plant.",
  },
  {
    area: "catalog",
    text: "Choose models with the user. Say whether a model is a vendor hardware profile or a generic simulated device; never present either as vendor firmware.",
  },
  {
    area: "designer",
    text: "Add the devices and draw the connections. The canvas validates each one; read its refusal reason and change the design, do not work around it.",
  },
  {
    area: "plc",
    text: "Confirm the PLC has the free channels the devices need, then check the I/O mapping the wiring produced.",
  },
  {
    area: "program",
    text: "Write the control logic with the user's strategy, Check it, Save a version, and deploy it when a runtime is started.",
  },
  { area: "runtime", text: "Start the factory when the user agrees. Read Live tags and Events to see it run." },
  {
    area: "simulation",
    text: "Test with faults, test inputs and scenarios; the PLC program's response is what you are testing.",
  },
  { area: "export", text: "Export the PLC's engineering snapshot, or its edge deployment, and report what was built." },
];

const RULES: readonly AgentRule[] = [
  {
    title: "Use the normal Z-Factory UI and its validation",
    text: "Every change goes through the pages and controls a person uses. The application validates and saves each one; a refused change is refused for an engineering reason, which the page shows.",
    source: "docs/rules.md 1, 7, 17",
  },
  {
    title: "No direct database manipulation",
    text: "Never read or write PostgreSQL, run Prisma, or edit stored rows to reach a result. The database is the application's, and live state is not in it anyway.",
    source: "docs/rules.md 20, 21; ADR-0007",
  },
  {
    title: "No hidden runtime writes",
    text: "Never talk to Docker, a PLC runtime container, or a Modbus endpoint behind the application's back. Commands and setpoints reach a PLC only through its command and setpoint tags, from the pages that offer them.",
    source: "docs/rules.md 6, 18, 19; ADR-0013",
  },
  {
    title: "Never force a physical output",
    text: "The PLC program is the control authority. Its local outputs follow its scan cycle; nothing outside the program sets a coil or an output register. Simulation faults and test inputs are inputs to the plant, not outputs.",
    source: "ADR-0015; docs/rules.md 41",
  },
  {
    title: "Ask before material engineering decisions",
    text: "Model choice, PLC architecture, wiring targets when several are compatible, control strategy, setpoints, interlocks, and anything that starts, stops or writes to a running plant are the user's decisions. Recommend a default and say why; apply it only when the user confirms.",
    source: "Phase 10, external browser agent boundary",
  },
  {
    title: "Never invent vendor facts",
    text: "I/O counts, pinouts, parameters and register maps come from the catalog, which carries their sources. Do not fill gaps from memory.",
    source: "docs/rules.md 12, 27",
  },
  {
    title: "Report what you did",
    text: "Name the pages used, the changes made, and what validation said, so the user can check the design.",
    source: "Phase 10, external browser agent boundary",
  },
];

export function buildLlmIndex(): LlmIndex {
  return {
    product: {
      name: "Z-Factory Engineering",
      purpose:
        "A browser-first virtual industrial factory: design PLC-controlled systems from a device catalog, run real PLC programs on OpenPLC runtimes in Docker, wire and simulate the field devices in a closed loop, watch live state and alarms, connect an external edge gateway, and export each PLC's engineering snapshot.",
      model: [
        "Sensor → PLC input tag → PLC logic → VFD, valve or output → motor, pump, process → feedback sensor tag → PLC.",
        "Remote command: cloud or UI → edge gateway → Modbus TCP → PLC command tag → PLC logic → VFD, motor, pump, valve.",
        "A factory is isolated on its own Docker network. Its PLCs are OpenPLC runtimes, one container each; its other devices are simulated by a shared simulator.",
        "Catalog model ≠ factory device: a device instance is created from a reusable catalog model and has a unique name within its factory.",
        "Command and setpoint tags are distinct from feedback, status and alarm tags. The wiring made in the designer is the single source of every channel, tag and Modbus mapping.",
      ],
      reality: [
        "Real: the PLC program, compiled and run by OpenPLC; its Modbus TCP server; the factory network and containers.",
        "Simulated: sensors, switches, valves, drives, motors, pumps and process modules, with explicit, documented behaviour. Approximations are not presented as full physics.",
        "Vendor PLC and device models are hardware profiles with source provenance. Z-Factory never runs or emulates vendor firmware.",
        "Live values come from the runtime and the simulator; the database holds configuration, versions, events, alarms and selected telemetry.",
      ],
    },
    activities: ACTIVITIES.map((activity) => ({
      key: activity.key,
      short: activity.short,
      label: activity.label,
      factoryScoped: activity.href(undefined) === undefined,
    })),
    areas: AREAS.map((area) => ({ ...area, llmContext: LLM_CONTEXT_AREAS.has(area.key) })),
    files: FILES,
    workflow: WORKFLOW,
    rules: RULES,
    placeholders: [
      { name: "factoryId", meaning: "a factory's id, from the Factories page" },
      { name: "plcId", meaning: "a PLC device's id, from the factory overview" },
      { name: "deviceId", meaning: "a non-controller device's id, from the factory overview" },
      { name: "moduleId", meaning: "a process module's id" },
      { name: "connectionId", meaning: "a gateway connection's id" },
      { name: "linkId", meaning: "a PLC-to-PLC link's id" },
      { name: "assetId", meaning: "a catalog 3D asset version's id" },
    ],
  };
}

/** The areas whose pages have an LLM Context tab today. */
export function areasWithLlmContext(index: LlmIndex): readonly EngineeringArea[] {
  return index.areas.filter((area) => area.llmContext);
}
