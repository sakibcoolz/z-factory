import { createLlmContext, type LlmContextDocument, type LlmContextItem } from "@/lib/agent/llm-context";
import { routePattern } from "@/lib/agent/llm-index";
import type { FactoryDeviceView } from "@/lib/domain/plc-config-view";
import { runtimeStateLabel } from "@/lib/domain/runtime-state";
import type { SimulationView } from "@/lib/domain/simulation-view";
import { routes } from "@/lib/navigation/routes";
import type { AlarmView, EventView } from "@/lib/services/event-service";
import type { FactoryView } from "@/lib/services/factory-service";
import type { LiveTagsView } from "@/lib/services/live-service";
import type { ActiveOverride } from "@/lib/services/scenario-service";
import type { SimulationState } from "@/lib/services/simulation-service";

/**
 * The LLM Contexts of the factory's operating screens (TASK-1003, PR B): runtime,
 * simulator, scenarios, live tags and events. Each builder takes what its screen loads.
 */

const STATE_TONE: Record<FactoryView["runtimeStatus"], LlmContextItem["tone"]> = {
  STOPPED: "info",
  STARTING: "info",
  RUNNING: "ok",
  STOPPING: "info",
  DEGRADED: "warn",
  FAULTED: "fault",
  DISCONNECTED: "warn",
};

const ASK = "Ask the user before changing what runs.";

/** The factory screens every operating screen links to, minus the screen itself. */
function factoryNavigation(factoryId: string, self: string): LlmContextItem[] {
  return [
    { label: "Factory overview", href: routes.factory(factoryId) },
    { label: "Runtime", href: routes.runtime(factoryId), detail: "Start and stop; each PLC's real state." },
    { label: "Simulator", href: routes.simulator(factoryId), detail: "The simulated field, faults and test inputs." },
    { label: "Scenarios", href: routes.scenarios(factoryId), detail: "Closed-loop tests, run and recorded." },
    { label: "Live tags", href: routes.tags(factoryId), detail: "Values the PLCs read and drive." },
    { label: "Events", href: routes.events(factoryId), detail: "Alarms and what happened." },
    { label: "Gateways", href: routes.gateways(factoryId), detail: "External edge access." },
    { label: "Process modules", href: routes.modules(factoryId) },
    { label: "Designer", href: routes.designer(factoryId), detail: "Add and wire devices." },
    { label: "LLM Index", href: routes.llmIndex() },
  ].filter((item) => item.href !== self);
}

// ---------------------------------------------------------------------------------------
// Runtime

export type FactoryRuntimeContextInput = {
  factory: FactoryView;
  /** Every device of the factory; the PLCs are those with an architecture. */
  devices: readonly FactoryDeviceView[];
  simulation: SimulationState;
  docker: { reachable: boolean; version?: string };
};

export function buildFactoryRuntimeContext({
  factory,
  devices,
  simulation,
  docker,
}: FactoryRuntimeContextInput): LlmContextDocument {
  const f = factory.id;
  const plcs = devices.filter((device) => device.architectureType !== null);
  const started = plcs.filter((plc) => plc.runtimeStatus !== "STOPPED");
  const stopped = factory.runtimeStatus === "STOPPED";
  const canStart = docker.reachable && plcs.length > 0;

  const validation: LlmContextItem[] = [];
  if (!docker.reachable)
    validation.push({ label: "Docker Engine unreachable", detail: "Nothing can be started.", tone: "fault" });
  if (plcs.length === 0) validation.push({ label: "No PLC to start", href: routes.designer(f), tone: "warn" });
  for (const plc of plcs.filter(
    (plc) =>
      plc.runtimeStatus === "FAULTED" || plc.runtimeStatus === "DEGRADED" || plc.runtimeStatus === "DISCONNECTED",
  ))
    validation.push({
      label: `${plc.name} is ${runtimeStateLabel(plc.runtimeStatus).toLowerCase()}`,
      href: routes.plcRuntime(f, plc.id),
      tone: STATE_TONE[plc.runtimeStatus],
    });
  if (simulation.running && simulation.lastError)
    validation.push({ label: "The simulation's last cycle failed", detail: simulation.lastError, tone: "warn" });
  if (!stopped && !simulation.running && plcs.length > 0)
    validation.push({
      label: "PLCs run without the device simulation",
      detail: "Their field inputs do not move; start it from the Simulator.",
      href: routes.simulator(f),
      tone: "warn",
    });

  return createLlmContext(
    {
      page: "Factory runtime",
      area: "runtime",
      route: routes.runtime(f),
      routePattern: routePattern(routes.runtime("factoryId")),
      subject: factory.name,
      summary:
        "Running the plant: every PLC's last stored state, the device simulation and the Docker host. Start factory brings up every PLC runtime, then the simulation, then the gateway endpoints; Stop factory takes them down in reverse.",
    },
    {
      context: [
        {
          label: "Factory state",
          value: runtimeStateLabel(factory.runtimeStatus),
          tone: STATE_TONE[factory.runtimeStatus],
        },
        { label: "PLC runtimes started", value: `${started.length}/${plcs.length}` },
        {
          label: "Device simulation",
          value: simulation.running
            ? `running · ${simulation.devices.length} devices · tick ${simulation.tickMs} ms`
            : "stopped",
          tone: simulation.running ? "ok" : "info",
        },
        {
          label: "Docker Engine",
          value: docker.reachable ? (docker.version ?? "reachable") : "unreachable",
          tone: docker.reachable ? "ok" : "fault",
        },
      ],
      objects: plcs.map((plc) => ({
        label: plc.name,
        value: `${plc.modelName} · ${runtimeStateLabel(plc.runtimeStatus)}`,
        href: routes.plcRuntime(f, plc.id),
        tone: STATE_TONE[plc.runtimeStatus],
      })),
      relationships: [
        {
          label: "Start order",
          value: "PLC runtimes → device simulation → gateway endpoints",
          detail: "A PLC that fails to start stops the sequence.",
        },
        {
          label: "Stop order",
          value: "simulation → PLC runtimes",
          detail: "The last device states are stored while the PLCs still answer; gateway endpoints stay open.",
        },
      ],
      capacity: [
        {
          label: "Containers",
          value: `${started.length} of ${plcs.length} PLC containers up`,
          detail: "One OpenPLC container per PLC on the factory's network.",
        },
      ],
      validation: { items: validation },
      actions: [
        {
          label: "Start factory",
          detail: canStart
            ? stopped
              ? `Starts every PLC runtime (can take minutes: image download, program build), then the simulation and the gateways. ${ASK}`
              : "Already started; starts what is not running."
            : "Disabled: needs a PLC and a reachable Docker Engine.",
          tone: canStart && stopped ? "warn" : "info",
        },
        {
          label: "Stop factory",
          detail: stopped
            ? "Nothing is running."
            : `Asks first. Stops the simulation, then every PLC; containers stay for the next start. ${ASK}`,
          tone: stopped ? "info" : "warn",
        },
        { label: "Open a PLC's runtime", detail: "Start, deploy, restart, stop or remove one PLC on its own screen." },
      ],
      constraints: [
        {
          label: "Containers are stopped, not removed",
          detail: "A stopped factory keeps its PLC containers, Modbus endpoints and history.",
        },
        { label: "The subnet cannot change while running" },
        {
          label: "The PLC program is the control authority",
          detail: "Starting runs the selected program version; nothing here forces outputs (ADR-0015).",
        },
      ],
      decisions: [
        ...(stopped && canStart
          ? [
              {
                label: "Start the plant?",
                decision: {
                  kind: "run-state" as const,
                  confirm: "required" as const,
                  enforced: "Start needs a PLC and a reachable Docker Engine; a failed PLC stops the sequence.",
                },
                detail: "Confirm with the user before starting; it creates containers and a network.",
              },
            ]
          : []),
        ...(!stopped
          ? [
              {
                label: "The plant is running",
                decision: { kind: "run-state" as const, confirm: "required" as const },
                detail: ASK,
              },
            ]
          : []),
      ],
      navigation: factoryNavigation(f, routes.runtime(f)),
    },
  );
}

// ---------------------------------------------------------------------------------------
// Simulator

export type SimulatorContextInput = { factory: FactoryView; view: SimulationView };

export function buildSimulatorContext({ factory, view }: SimulatorContextInput): LlmContextDocument {
  const f = factory.id;
  const faulted = view.devices.filter((device) => device.faulted);
  const bad = view.devices.filter((device) => device.quality === "BAD");
  const endpointsNotReady = view.plcs.filter((plc) => !plc.endpointReady);

  const validation: LlmContextItem[] = [];
  if (view.blocker) validation.push({ label: "The simulation cannot start", detail: view.blocker, tone: "warn" });
  if (view.lastError) validation.push({ label: "The last cycle failed", detail: view.lastError, tone: "warn" });
  for (const plc of endpointsNotReady)
    validation.push({
      label: `${plc.name}'s Modbus endpoint is not ready`,
      detail: "Start the PLC first; the simulation exchanges values through it.",
      href: routes.plcRuntime(f, plc.id),
      tone: "warn",
    });
  for (const device of faulted)
    validation.push({
      label: `${device.name} is faulted`,
      value:
        device.faults
          .filter((fault) => fault.active)
          .map((fault) => fault.name)
          .join(", ") || undefined,
      tone: "fault",
    });
  for (const device of bad.filter((device) => !device.faulted))
    validation.push({ label: `${device.name} reports bad quality`, tone: "warn" });
  for (const skipped of view.skipped)
    validation.push({ label: `${skipped.name} is not simulated`, detail: skipped.reason, tone: "info" });

  return createLlmContext(
    {
      page: "Simulator",
      area: "simulation",
      route: routes.simulator(f),
      routePattern: routePattern(routes.simulator("factoryId")),
      subject: factory.name,
      summary:
        "The simulated field: every device with the commands it takes from PLC logic, the feedback it gives, and its faults. Faults and test inputs are inputs to the plant; the PLC program still decides every output.",
    },
    {
      context: [
        {
          label: "Simulation",
          value: view.running
            ? `running since ${view.startedAt ?? "?"} · ${view.ticks ?? 0} ticks at ${view.tickMs ?? "?"} ms`
            : "stopped",
          tone: view.running ? "ok" : "info",
        },
        { label: "Simulated devices", value: String(view.devices.length) },
        { label: "Faulted", value: String(faulted.length), tone: faulted.length > 0 ? "fault" : "info" },
        { label: "PLC endpoints ready", value: `${view.plcs.length - endpointsNotReady.length}/${view.plcs.length}` },
      ],
      objects: view.devices.map((device) => ({
        label: device.name,
        value: `${device.type.toLowerCase()}${device.state ? ` · ${device.state}` : ""}`,
        href: routes.device(f, device.deviceId),
        detail: [
          device.inputs.length > 0
            ? `commands: ${device.inputs.map((signal) => `${signal.label}${signal.tag ? ` ← ${signal.tag}` : ""}`).join(", ")}`
            : null,
          device.outputs.length > 0
            ? `feedback: ${device.outputs.map((signal) => `${signal.label}${signal.tag ? ` → ${signal.tag}` : ""}`).join(", ")}`
            : null,
          device.faults.length > 0
            ? `faults: ${device.faults.map((fault) => `${fault.name}${fault.active ? " (active)" : ""}`).join(", ")}`
            : null,
        ]
          .filter(Boolean)
          .join(" · "),
        tone: device.faulted ? "fault" : device.quality === "BAD" ? "warn" : device.tripped ? "warn" : "info",
      })),
      relationships: view.devices.flatMap((device) => [
        ...device.inputs
          .filter((signal) => signal.tag)
          .map((signal) => ({
            label: `${device.name}.${signal.label} is driven by tag ${signal.tag}`,
            detail: "PLC logic writes the tag; the simulator reads it.",
          })),
        ...device.outputs
          .filter((signal) => signal.tag)
          .map((signal) => ({
            label: `${device.name}.${signal.label} feeds tag ${signal.tag}`,
            detail: "The simulator writes it; the PLC reads it.",
          })),
      ]),
      capacity: [
        { label: "Devices simulated", value: `${view.devices.length} simulated, ${view.skipped.length} skipped` },
      ],
      validation: { items: validation },
      actions: [
        view.running
          ? { label: "Stop simulation", detail: `Stores the last device states. ${ASK}`, tone: "warn" }
          : {
              label: "Start simulation",
              detail: view.blocker
                ? `Blocked: ${view.blocker}`
                : `Needs a started PLC with a ready Modbus endpoint. ${ASK}`,
              tone: view.blocker ? "info" : "warn",
            },
        {
          label: "Inject a fault",
          detail: view.running
            ? `Per device: inject:<code>, clear:<code>, reset. ${ASK}`
            : "Start the simulation first.",
        },
        { label: "Reset a device", detail: "Clears its faults and trips." },
      ],
      constraints: [
        {
          label: "Commands come from PLC logic only",
          detail:
            "The simulator never writes a PLC's local outputs; a fault is a field condition the program sees (ADR-0015).",
        },
        { label: "Command and feedback signals are distinct", detail: "Each is shown with the tag it is wired to." },
        { label: "Approximations are explicit", detail: "Documented behaviour per device type, not full physics." },
      ],
      decisions: [
        ...(view.running
          ? [
              {
                label: "Which fault, on which device?",
                decision: {
                  kind: "test-input" as const,
                  confirm: "required" as const,
                  enforced: "Only faults the device model declares; a fault is a field condition the program sees.",
                },
                detail: "A fault changes what the plant does; ask before injecting one.",
              },
            ]
          : []),
        ...(!view.running && !view.blocker
          ? [
              {
                label: "Start the simulation?",
                decision: {
                  kind: "run-state" as const,
                  confirm: "required" as const,
                  enforced: "Needs a started PLC with a ready Modbus endpoint.",
                },
                detail: ASK,
              },
            ]
          : []),
      ],
      navigation: factoryNavigation(f, routes.simulator(f)),
    },
  );
}

// ---------------------------------------------------------------------------------------
// Scenarios

export type ScenariosContextInput = {
  factory: FactoryView;
  /** Overrides out of AUTO; null when the simulation service does not answer. */
  active: readonly ActiveOverride[] | null;
  runs: readonly EventView[];
  /** The PLC the example scenario is written for, when the factory has one. */
  examplePlc: { name: string; command: string | null; expected: string | null } | null;
};

export function buildScenariosContext({
  factory,
  active,
  runs,
  examplePlc,
}: ScenariosContextInput): LlmContextDocument {
  const f = factory.id;
  const validation: LlmContextItem[] = [];
  if (active === null)
    validation.push({
      label: "The simulation service does not answer",
      detail: "Overrides cannot be listed or cleared.",
      tone: "warn",
    });
  if (active && active.length > 0)
    validation.push({
      label: `${active.length} override${active.length === 1 ? "" : "s"} out of AUTO`,
      detail: "A run always starts from AUTO; clear them or let the run do it.",
      tone: "warn",
    });
  if (!examplePlc)
    validation.push({
      label: "No PLC",
      detail: "A scenario needs a PLC with tags.",
      href: routes.designer(f),
      tone: "warn",
    });

  return createLlmContext(
    {
      page: "Scenarios",
      area: "simulation",
      route: routes.scenarios(f),
      routePattern: routePattern(routes.scenarios("factoryId")),
      subject: factory.name,
      summary:
        "Closed-loop test scenarios: steps that write command tags, inject faults or override process values, then expect outputs. A run starts from AUTO, ends in AUTO, and is recorded as SCENARIO events.",
    },
    {
      context: [
        {
          label: "Overrides out of AUTO",
          value: active === null ? "unknown" : String(active.length),
          tone: active && active.length > 0 ? "warn" : "info",
        },
        { label: "Recorded runs", value: String(runs.length), href: routes.events(f, { family: "SCENARIO" }) },
        ...(examplePlc
          ? [
              {
                label: "Example scenario",
                value: `${examplePlc.name}: ${examplePlc.command ?? "no command tag"} → ${examplePlc.expected ?? "no output tag"}`,
              },
            ]
          : []),
      ],
      objects: [
        ...(active ?? []).map((override) => ({
          label: override.target,
          value: `${override.kind.toLowerCase()} · ${override.mode}${override.value !== undefined ? ` · ${String(override.value)}` : ""}`,
          tone: "warn" as const,
        })),
        ...runs.map((run) => ({
          label: run.type,
          value: run.occurredAt,
          detail: typeof run.payload.name === "string" ? String(run.payload.name) : undefined,
          tone:
            run.severity === "CRITICAL"
              ? ("fault" as const)
              : run.severity === "WARNING"
                ? ("warn" as const)
                : ("info" as const),
        })),
      ],
      relationships: [
        {
          label: "A scenario drives the plant through its tags",
          detail:
            "Writes go to command and setpoint tags; expectations read status and feedback tags; the PLC program decides in between.",
        },
      ],
      capacity: [],
      validation: { items: validation },
      actions: [
        {
          label: "Run scenario",
          detail: `Runs the steps in the editor against the running plant. ${ASK}`,
          tone: "warn",
        },
        {
          label: "Clear all overrides",
          detail:
            active === null
              ? "Unavailable: the service does not answer."
              : "Returns every forced and process override to AUTO.",
        },
      ],
      constraints: [
        { label: "A run starts from AUTO and ends in AUTO" },
        {
          label: "Only externally writable tags can be written",
          detail: "Command and setpoint tags; never a PLC's own outputs (ADR-0015).",
        },
        {
          label: "Results are recorded as events",
          detail: "Passed, failed or refused, with the step that decided it.",
        },
      ],
      decisions: [
        {
          label: "Which scenario?",
          decision: {
            kind: "test-input" as const,
            confirm: "required" as const,
            enforced: "A run starts from AUTO, ends in AUTO, and writes only externally writable tags.",
          },
          detail: "Ask what the user wants to prove (a trip, an interlock, an alarm) before writing or running one.",
        },
      ],
      navigation: factoryNavigation(f, routes.scenarios(f)),
    },
  );
}

// ---------------------------------------------------------------------------------------
// Live tags

export type LiveTagsContextInput = {
  factory: FactoryView;
  view: LiveTagsView;
  /** The PLC the screen is narrowed to, when `?plc=` names one. */
  selectedPlcId?: string;
};

export function buildLiveTagsContext({ factory, view, selectedPlcId }: LiveTagsContextInput): LlmContextDocument {
  const f = factory.id;
  const selected = view.plcs.find((plc) => plc.id === selectedPlcId);
  const tags = selected ? view.tags.filter((tag) => tag.plcId === selected.id) : view.tags;
  const writable = tags.filter((tag) => tag.writable);
  const monitored = view.plcs.filter((plc) => plc.monitored);
  const stale = tags.filter((tag) => tag.reading.quality !== "GOOD" && tag.reading.readAt !== null);
  const never = tags.filter((tag) => tag.reading.readAt === null);

  const validation: LlmContextItem[] = [];
  if (monitored.length === 0)
    validation.push({
      label: "No PLC is started and monitored",
      detail: "Values appear once a PLC runs.",
      href: routes.runtime(f),
      tone: "warn",
    });
  if (stale.length > 0)
    validation.push({
      label: `${stale.length} tag${stale.length === 1 ? "" : "s"} not GOOD`,
      detail: `A value is stale after ${view.staleAfterMs} ms without a read.`,
      tone: "warn",
    });

  return createLlmContext(
    {
      page: "Live tags",
      area: "tags",
      route: selected ? routes.tags(f, selected.id) : routes.tags(f),
      routePattern: routePattern(routes.tags("factoryId")),
      subject: selected ? `${factory.name} · ${selected.name}` : factory.name,
      summary:
        "Every tag of the factory's PLCs with its current value from the running runtimes, and a write control on tags that are externally writable (command and setpoint memory).",
    },
    {
      context: [
        { label: "PLCs", value: `${monitored.length} of ${view.plcs.length} monitored` },
        {
          label: "Tags shown",
          value: String(tags.length),
          detail: selected ? `narrowed to ${selected.name} (?plc=)` : "all PLCs",
        },
        {
          label: "Writable",
          value: String(writable.length),
          detail: "Only external command memory; PLC logic, the field or a bridge produces the rest.",
        },
        { label: "Stale after", value: `${view.staleAfterMs} ms` },
        ...(never.length > 0 ? [{ label: "Never read", value: String(never.length) }] : []),
      ],
      objects: tags.slice(0, 60).map((tag) => ({
        label: `${tag.plcName}.${tag.name}`,
        value: `${tag.reading.value === null ? "—" : String(tag.reading.value)}${tag.unit ? ` ${tag.unit}` : ""} · ${tag.reading.quality.toLowerCase()}`,
        detail: `${tag.role.toLowerCase()} · ${tag.dataType} · ${tag.authority.toLowerCase().replace(/_/g, " ")}${tag.logicalAddress ? ` · ${tag.logicalAddress}` : ""}${tag.deviceName ? ` · ${tag.deviceName}` : ""}${tag.writable ? " · writable" : ""}`,
        tone: tag.reading.quality === "GOOD" ? "ok" : tag.reading.readAt === null ? "info" : "warn",
      })),
      relationships: view.plcs.map((plc) => ({
        label: `${plc.name} has ${plc.tagCount} tags`,
        value: `${runtimeStateLabel(plc.runtimeStatus)} · ${plc.monitored ? "monitored" : "not monitored"}`,
        href: routes.tags(f, plc.id),
      })),
      capacity: [
        {
          label: "Tags beyond the first 60 are on the page",
          value: tags.length > 60 ? `${tags.length - 60} more` : "none",
        },
      ],
      validation: { items: validation },
      actions: [
        {
          label: "Write a tag",
          detail:
            writable.length > 0
              ? `On the ${writable.length} writable tag${writable.length === 1 ? "" : "s"}: a BOOL takes on or off, a number its engineering value. ${ASK}`
              : "No writable tag here.",
          tone: writable.length > 0 ? "warn" : "info",
        },
        { label: "Narrow to one PLC", detail: "?plc=<plcId>." },
      ],
      constraints: [
        { label: "Live values come from the runtime, not the database" },
        {
          label: "A write reaches external command memory only",
          detail: "Feedback, status and alarm tags, and the program's own outputs, are read-only (ADR-0015).",
        },
        { label: "The write is recorded", detail: "Every write, and every refused one, is an event." },
      ],
      decisions: [
        {
          label: "Which value, and now?",
          decision: {
            kind: "write" as const,
            confirm: "required" as const,
            enforced: "Only external command memory is writable; a BOOL takes on or off, a number its exported range.",
          },
          detail: "A write changes a running plant; ask for the value and confirm before writing.",
        },
      ],
      navigation: factoryNavigation(f, routes.tags(f)),
    },
  );
}

// ---------------------------------------------------------------------------------------
// Events and alarms

export type EventsContextInput = {
  factory: FactoryView;
  alarms: readonly AlarmView[];
  events: readonly EventView[];
  counts: Readonly<Record<string, number>>;
  filter: { family?: string; severity?: string; deviceName?: string };
  /** How long events and telemetry are kept; absent when the deps do not say. */
  retention?: { telemetryMs: number; eventsMs: number };
};

export function buildEventsContext({
  factory,
  alarms,
  events,
  counts,
  filter,
  retention,
}: EventsContextInput): LlmContextDocument {
  const f = factory.id;
  const active = alarms.filter((alarm) => alarm.clearedAt === null);
  const unacknowledged = alarms.filter((alarm) => alarm.acknowledgedAt === null && alarm.clearedAt === null);
  const filters = [
    filter.family ? `family ${filter.family}` : null,
    filter.severity ? `severity ${filter.severity}` : null,
    filter.deviceName ? `device ${filter.deviceName}` : null,
  ].filter(Boolean);

  const validation: LlmContextItem[] = [
    ...active.map((alarm) => ({
      label: `${alarm.deviceName ?? "factory"}: ${alarm.message}`,
      value: alarm.state.toLowerCase().replace(/_/g, " "),
      detail: `${alarm.code} since ${alarm.startedAt}${alarm.tagName ? ` · tag ${alarm.tagName}` : ""}`,
      href: alarm.deviceId ? routes.events(f, { device: alarm.deviceId }) : undefined,
      tone: alarm.severity === "CRITICAL" ? ("fault" as const) : ("warn" as const),
    })),
  ];

  return createLlmContext(
    {
      page: "Events and alarms",
      area: "events",
      route: routes.events(f),
      routePattern: routePattern(routes.events("factoryId")),
      subject: factory.name,
      summary:
        "What happened: the active alarms with acknowledgement, and the recorded events (runtime, device, simulation, gateway, scenario) with filters by family, severity and device.",
    },
    {
      context: [
        { label: "Active alarms", value: String(active.length), tone: active.length > 0 ? "warn" : "ok" },
        {
          label: "Unacknowledged",
          value: String(unacknowledged.length),
          tone: unacknowledged.length > 0 ? "warn" : "info",
        },
        {
          label: "Events shown",
          value: String(events.length),
          detail: filters.length > 0 ? `filtered: ${filters.join(", ")}` : "unfiltered, newest first",
        },
        {
          label: "Last 24 h by severity",
          value:
            Object.entries(counts)
              .map(([severity, count]) => `${severity.toLowerCase()} ${count}`)
              .join(" · ") || "none",
        },
        {
          label: "Retention",
          value: retention
            ? `events ${Math.round(retention.eventsMs / 86_400_000)} days · telemetry ${Math.round(retention.telemetryMs / 3_600_000)} h`
            : "default",
        },
      ],
      objects: events.slice(0, 40).map((event) => ({
        label: event.type,
        value: event.occurredAt,
        detail: `${event.family.toLowerCase()}${event.deviceName ? ` · ${event.deviceName}` : ""}`,
        href: event.deviceId ? routes.events(f, { device: event.deviceId }) : undefined,
        tone: event.severity === "CRITICAL" ? "fault" : event.severity === "WARNING" ? "warn" : "info",
      })),
      relationships: [
        {
          label: "An alarm is raised by a PLC ALARM tag or by the runtime",
          detail: "It ends when the condition clears; acknowledging records who saw it.",
        },
      ],
      capacity: [
        {
          label: "Events beyond the first 40 are on the page",
          value: events.length > 40 ? `${events.length - 40} more` : "none",
        },
      ],
      validation: { items: validation },
      actions: [
        {
          label: "Acknowledge an alarm",
          detail:
            unacknowledged.length > 0
              ? `${unacknowledged.length} waiting. Acknowledging does not clear the condition.`
              : "Nothing to acknowledge.",
        },
        { label: "Filter", detail: "?family=, ?severity=, ?device=." },
      ],
      constraints: [
        {
          label: "Acknowledging changes nothing in the plant",
          detail: "The condition clears only when the PLC program or the runtime clears it.",
        },
        { label: "Events are versioned, append-only records" },
      ],
      decisions:
        unacknowledged.length > 0
          ? [
              {
                label: "Acknowledge on the user's behalf?",
                decision: {
                  kind: "write" as const,
                  confirm: "required" as const,
                  enforced: "Acknowledging never clears the condition.",
                },
                detail: "An acknowledgement is attributed; ask before recording one.",
              },
            ]
          : [],
      navigation: factoryNavigation(f, routes.events(f)),
    },
  );
}
