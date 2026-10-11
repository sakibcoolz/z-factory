import { createLlmContext, type LlmContextDocument, type LlmContextItem } from "@/lib/agent/llm-context";
import { routePattern } from "@/lib/agent/llm-index";
import type { GatewaysView } from "@/lib/domain/gateway-view";
import type { ModuleDesignerView, ModulesScreenView } from "@/lib/domain/module-designer-view";
import { runtimeStateLabel } from "@/lib/domain/runtime-state";
import { routes } from "@/lib/navigation/routes";

/**
 * The LLM Contexts of the factory's engineering screens beyond the designer (TASK-1003,
 * PR B): external gateways, the process modules list and the module editor.
 */

const ASK = "Ask the user before changing what runs.";

// ---------------------------------------------------------------------------------------
// Gateways

export function buildGatewaysContext(view: GatewaysView): LlmContextDocument {
  const f = view.factory.id;
  const connections = view.gateways.flatMap((gateway) =>
    gateway.connections.map((connection) => ({ gateway, connection })),
  );
  const open = connections.filter(({ connection }) => connection.endpoint.listening);
  const failed = connections.filter(({ connection }) => connection.enabled && !connection.endpoint.listening);

  const validation: LlmContextItem[] = [];
  if (!view.hasPlc)
    validation.push({
      label: "No PLC",
      detail: "A gateway connects to a PLC's tags.",
      href: routes.designer(f),
      tone: "warn",
    });
  if (view.gateways.length === 0)
    validation.push({
      label: "No gateway device",
      detail: "Add a gateway from the catalog in the designer, then connect it to a PLC.",
      href: routes.designer(f),
      tone: "info",
    });
  for (const { gateway, connection } of failed)
    validation.push({
      label: `${gateway.name} → ${connection.plcName}: endpoint not open`,
      detail: connection.endpoint.error ?? "The endpoint is enabled but not listening.",
      tone: "fault",
    });
  for (const { gateway, connection } of connections.filter(({ connection }) => connection.unmappedTags.length > 0))
    validation.push({
      label: `${gateway.name} → ${connection.plcName}: ${connection.unmappedTags.length} tag${connection.unmappedTags.length === 1 ? "" : "s"} not mapped`,
      detail: "Map them to expose them to the edge client.",
      tone: "info",
    });

  return createLlmContext(
    {
      page: "External gateways",
      area: "gateways",
      route: routes.gateways(f),
      routePattern: routePattern(routes.gateways("factoryId")),
      subject: view.factory.name,
      summary:
        "How an external edge device reaches the PLCs: each gateway device's connections, the host endpoint each opens over Modbus TCP, and the PLC tags it exposes as registers, with READ or READ_WRITE access.",
    },
    {
      context: [
        { label: "Gateways", value: String(view.gateways.length) },
        {
          label: "Connections",
          value: `${connections.length} configured · ${open.length} listening`,
          tone: failed.length > 0 ? "fault" : "info",
        },
        {
          label: "Host ports allowed",
          value: `${view.portRange.min}–${view.portRange.max}`,
          detail: `on ${view.bindAddresses.join(", ")}`,
        },
        {
          label: "Next free port",
          value: view.suggestedPort === null ? "none left" : String(view.suggestedPort),
          tone: view.suggestedPort === null ? "warn" : "info",
        },
      ],
      objects: [
        ...view.gateways.map((gateway) => ({
          label: gateway.name,
          value: gateway.modelName,
          href: routes.device(f, gateway.deviceId),
          detail: `${gateway.connections.length} connection${gateway.connections.length === 1 ? "" : "s"}; can connect to ${gateway.availablePlcs.map((plc) => plc.name).join(", ") || "no further PLC"}`,
        })),
        ...connections.map(({ gateway, connection }) => ({
          label: `${gateway.name} → ${connection.plcName}`,
          value: `${connection.host}:${connection.port} unit ${connection.unitId} · ${connection.enabled ? "enabled" : "disabled"} · ${connection.endpoint.listening ? "listening" : "not open"}`,
          detail: `${connection.registers.length} registers (${connection.registers.filter((register) => register.access === "READ_WRITE").length} writable) · ${connection.endpoint.clients} clients · ${connection.endpoint.requests} requests, ${connection.endpoint.refused} refused · poll ${connection.pollIntervalMs} ms · PLC ${runtimeStateLabel(connection.plcState)}`,
          href: routes.gatewayMap(f, connection.id),
          tone: connection.endpoint.listening
            ? ("ok" as const)
            : connection.enabled
              ? ("fault" as const)
              : ("info" as const),
        })),
      ],
      relationships: connections.flatMap(({ gateway, connection }) =>
        connection.registers.slice(0, 20).map((register) => ({
          label: `${gateway.name} exposes ${connection.plcName}.${register.tagName} as ${register.externalName}`,
          value: `${register.area} ${register.displayAddress} · ${register.access}`,
          detail: `${register.role.toLowerCase()} · ${register.dataType}${register.unit ? ` · ${register.unit}` : ""}`,
        })),
      ),
      capacity: [
        {
          label: "Registers mapped",
          value: String(connections.reduce((sum, { connection }) => sum + connection.registers.length, 0)),
        },
        {
          label: "Tags not yet mapped",
          value: String(connections.reduce((sum, { connection }) => sum + connection.unmappedTags.length, 0)),
        },
      ],
      validation: { items: validation },
      actions: [
        { label: "Add gateway", detail: "A catalog gateway model as a new device of the factory." },
        {
          label: "Connect a gateway to a PLC",
          detail: "Host address from the allowed ones, a free port in the range, a unit id and a poll interval.",
        },
        {
          label: "Map a tag",
          detail: "Exposes one PLC tag as a register; writable only for command and setpoint tags.",
        },
        { label: "Map all tags", detail: "Every tag of the PLC at once." },
        { label: "Enable, disable or remove a connection", detail: `Opens or closes the host endpoint. ${ASK}` },
        {
          label: "Download map.json",
          detail: "What an edge client is configured from: endpoint, conventions and registers.",
        },
      ],
      constraints: [
        {
          label: "A gateway writes PLC command and setpoint tags only",
          detail: "It never changes a simulator or a PLC's own outputs; feedback is read (ADR-0013, ADR-0015).",
        },
        {
          label: "Endpoints bind to allowed addresses and the port range",
          detail: "Ports already used by a container or another gateway are refused.",
        },
        { label: "Addressing is zero-based, big-endian, high word first" },
      ],
      decisions: [
        ...(view.gateways.length > 0
          ? [
              {
                label: "Which host address and port?",
                decision: {
                  kind: "endpoint" as const,
                  confirm: "optional" as const,
                  defaultChoice: "the next free port on 127.0.0.1, as the form suggests",
                  enforced:
                    "Only allowed bind addresses and a free port in the range; ports held by a container or another gateway are refused.",
                },
                detail: "Ask what the edge device can reach before opening an endpoint.",
              },
            ]
          : []),
        {
          label: "Which tags may an external client write?",
          decision: {
            kind: "write" as const,
            confirm: "required" as const,
            defaultChoice: "READ for every tag; READ_WRITE only for the command and setpoint tags the user names",
            enforced: "Feedback, status and alarm tags and the program's outputs are never writable.",
          },
          detail: "Exposing a command or setpoint tag as writable is the user's decision.",
        },
      ],
      navigation: [
        { label: "Factory overview", href: routes.factory(f) },
        { label: "Runtime", href: routes.runtime(f), detail: "Endpoints open when the factory starts." },
        { label: "Live tags", href: routes.tags(f), detail: "The values behind the registers." },
        { label: "Designer", href: routes.designer(f), detail: "Add a gateway device." },
        { label: "LLM Index", href: routes.llmIndex() },
      ],
    },
  );
}

// ---------------------------------------------------------------------------------------
// Process modules

export function buildModulesContext(view: ModulesScreenView): LlmContextDocument {
  const f = view.factory.id;
  const running = view.modules.filter((module) => module.status === "RUNNING");
  const incomplete = view.modules.filter((module) => !module.complete);

  return createLlmContext(
    {
      page: "Process modules",
      area: "modules",
      route: routes.modules(f),
      routePattern: routePattern(routes.modules("factoryId")),
      subject: view.factory.name,
      summary:
        "The factory's process modules: process behaviour (a tank, a heater, a boiler) composed from existing devices in roles, with signals bound to PLC tags, and run by the Go process simulation service. Create one from a module type and profile.",
    },
    {
      context: [
        {
          label: "Modules",
          value: `${view.modules.length} · ${running.length} running · ${incomplete.length} incomplete`,
        },
        {
          label: "Module types available",
          value: view.types.map((type) => `${type.name} v${type.version}`).join(", ") || "none",
        },
      ],
      objects: view.modules.map((module) => ({
        label: module.name,
        value: `${module.type.name}${module.profile ? ` · ${module.profile}` : ""} · ${runtimeStateLabel(module.status)}`,
        href: routes.module(f, module.id),
        detail: `${module.deviceCount} devices · ${module.complete ? "complete" : `${module.issues.length} issue${module.issues.length === 1 ? "" : "s"}`}${module.location ? ` · ${module.location}` : ""}`,
        tone: module.status === "RUNNING" ? "ok" : module.complete ? "info" : "warn",
      })),
      relationships: view.modules.flatMap((module) =>
        module.roles.flatMap((role) =>
          role.devices.map((device) => ({
            label: `${device.name} is the ${role.name} of ${module.name}`,
            href: routes.module(f, module.id),
          })),
        ),
      ),
      capacity: view.types.map((type) => ({
        label: type.name,
        value: `${type.roleCount} roles · profiles ${type.profiles.join(", ") || "default"}`,
        detail: type.simulatorModelType
          ? `simulated by ${type.simulatorModelType}`
          : "no process model yet: configuration only",
        tone: type.simulatorModelType ? ("info" as const) : ("warn" as const),
      })),
      validation: {
        items: incomplete.flatMap((module) =>
          module.issues.map((issue) => ({
            label: `${module.name}: ${issue.message}`,
            detail: `${issue.rule} · ${issue.subject}`,
            href: routes.module(f, module.id),
            tone: "warn" as const,
          })),
        ),
      },
      actions: [
        {
          label: "Create module",
          detail: "Name, type, profile and its configuration fields; devices and bindings come after, in the editor.",
        },
        { label: "Open a module", detail: "Its devices, signals, interlocks, PLC I/O bindings and runtime." },
      ],
      constraints: [
        {
          label: "A module composes existing factory devices",
          detail: "It never redefines vendor hardware; a device keeps its own identity (docs/rules.md 37).",
        },
        {
          label: "Signals bind through normal PLC tag rules",
          detail: "Compatibility, occupancy and Modbus addressing as for any wiring (docs/rules.md 38).",
        },
        {
          label: "The process model computes response only",
          detail: "PLC logic stays the control, interlock and PID authority (docs/rules.md 41).",
        },
      ],
      decisions: [
        {
          label: "Which process, and which devices play which role?",
          decision: {
            kind: "scope" as const,
            confirm: "required" as const,
            enforced: "A role accepts only devices of its categories; a required role must be filled.",
          },
          detail: "Ask before creating a module or assigning devices.",
        },
      ],
      navigation: [
        { label: "Factory overview", href: routes.factory(f) },
        { label: "Designer", href: routes.designer(f), detail: "The devices a module is made of." },
        { label: "Simulator", href: routes.simulator(f) },
        { label: "Runtime", href: routes.runtime(f), detail: "The process bridge starts with the factory." },
        { label: "LLM Index", href: routes.llmIndex() },
      ],
    },
  );
}

export function buildModuleEditorContext(view: ModuleDesignerView): LlmContextDocument {
  const f = view.factory.id;
  const { module, type, registry, runtime } = view;
  const emptyRequired = type.roles.filter(
    (role) => role.required && !module.roles.find((filled) => filled.key === role.key)?.devices.length,
  );
  const blocking = registry.rows.filter((row) => row.blocking);
  const invalid = registry.rows.filter((row) => row.issue);

  const validation: LlmContextItem[] = [
    ...module.issues.map((issue) => ({
      label: issue.message,
      detail: `${issue.rule} · ${issue.subject}`,
      tone: "warn" as const,
    })),
    ...blocking.map((row) => ({
      label: `Required signal ${row.signal.name} is not bound`,
      detail: "The module cannot run until it is.",
      tone: "warn" as const,
    })),
    ...invalid.map((row) => ({
      label: `${row.signal.name}: ${row.issue!.message}`,
      detail: row.issue!.rule,
      tone: "warn" as const,
    })),
    ...(runtime.error
      ? [{ label: "The process bridge reports an error", detail: runtime.error, tone: "fault" as const }]
      : []),
    ...(runtime.serviceNote
      ? [{ label: "Process simulation service", detail: runtime.serviceNote, tone: "info" as const }]
      : []),
    ...runtime.alarms.map((alarm) => ({ label: `Alarm: ${alarm}`, tone: "warn" as const })),
  ];

  return createLlmContext(
    {
      page: "Process module",
      area: "modules",
      route: routes.module(f, module.id),
      routePattern: routePattern(routes.module("factoryId", "moduleId")),
      subject: `${module.name} (${view.factory.name})`,
      summary:
        "One process module: its devices by role, the signals of its profile bound to PLC tags (the I/O registry), its interlocks, and its runtime in the process bridge with test inputs and overrides.",
    },
    {
      context: [
        {
          label: "Type",
          value: `${type.name} v${type.version}${module.profile ? ` · profile ${module.profile}` : ""}`,
          detail: type.simulatorModelType
            ? `simulated by ${type.simulatorModelType}`
            : "no process model: configuration only",
        },
        { label: "State", value: runtimeStateLabel(module.status), tone: module.status === "RUNNING" ? "ok" : "info" },
        { label: "Complete", value: module.complete ? "yes" : "no", tone: module.complete ? "ok" : "warn" },
        {
          label: "Ready to run",
          value: registry.readyToRun ? "yes" : "no",
          detail: "Complete, every required signal bound, and a process model.",
          tone: registry.readyToRun ? "ok" : "warn",
        },
        {
          label: "Process bridge",
          value: runtime.bridgeRunning
            ? `running · ${runtime.status ?? "?"} · quality ${runtime.quality ?? "?"} · t=${runtime.timeS}s`
            : "stopped",
          tone: runtime.bridgeRunning ? "ok" : "info",
        },
        {
          label: "Configuration",
          value:
            Object.entries(module.config)
              .map(([key, value]) => `${key}=${String(value)}`)
              .join(", ") || "defaults",
        },
      ],
      objects: [
        ...module.roles.flatMap((role) =>
          role.devices.map((device) => ({
            label: device.name,
            value: `${role.name} · ${device.categoryName} · ${device.modelName}`,
            href: routes.device(f, device.deviceId),
          })),
        ),
        ...registry.rows.map((row) => ({
          label: `Signal ${row.signal.name}`,
          value: `${row.signal.direction.toLowerCase()} · ${row.signal.dataType}${row.signal.unit ? ` ${row.signal.unit}` : ""} · ${row.state.toLowerCase()}`,
          detail: row.binding
            ? `bound to ${row.binding.plcName}.${row.binding.tagName}`
            : row.signal.required
              ? "required, not bound"
              : "optional, not bound",
          tone: row.issue
            ? ("warn" as const)
            : row.blocking
              ? ("warn" as const)
              : row.binding
                ? ("ok" as const)
                : ("info" as const),
        })),
        ...module.interlocks.map((interlock) => ({
          label: `Interlock ${interlock.name}`,
          value: `${interlock.severity.toLowerCase()} · ${interlock.enabled ? "enabled" : "disabled"}`,
          detail: interlock.description ?? undefined,
        })),
        ...runtime.testInputs.map((input) => ({
          label: `Test input ${input.name}`,
          value: `${input.mode} · effective ${input.effective}${input.unit ? ` ${input.unit}` : ""}`,
          detail: input.tag ? `tag ${input.tag}` : undefined,
          tone: input.mode === "AUTO" ? ("info" as const) : ("warn" as const),
        })),
      ],
      relationships: [
        ...module.roles.flatMap((role) =>
          role.devices.map((device) => ({
            label: `${device.name} fills role ${role.name}`,
            detail: role.required ? "required role" : "optional role",
          })),
        ),
        ...registry.plcs.map((plc) => ({
          label: `${module.name} uses ${plc.plcName}`,
          value: `${plc.inputs} inputs · ${plc.outputs} outputs · ${plc.alarms} alarms`,
          href: routes.plc(f, plc.plcId),
        })),
      ],
      capacity: [
        ...type.roles.map((role) => {
          const filled = module.roles.find((candidate) => candidate.key === role.key)?.devices.length ?? 0;
          return {
            label: `Role ${role.name}`,
            value: `${filled}/${role.maxDevices}${role.required ? " (required)" : ""}`,
            detail:
              role.deviceCategoryCodes.length > 0
                ? `accepts ${role.deviceCategoryCodes.join(", ")}`
                : "accepts any device",
            tone: role.required && filled === 0 ? ("warn" as const) : ("info" as const),
          };
        }),
        ...Object.entries(registry.counts).map(([direction, count]) => ({
          label: `${direction} signals`,
          value: `${count.bound}/${count.total} bound · ${count.requiredUnbound} required unbound · ${count.invalid} invalid`,
          tone: count.requiredUnbound > 0 || count.invalid > 0 ? ("warn" as const) : ("info" as const),
        })),
      ],
      validation: { items: validation },
      actions: [
        { label: "Rename, relocate or change the configuration" },
        { label: "Assign or remove a device in a role", detail: "Only devices of the categories the role accepts." },
        { label: "Bind a signal to a PLC tag", detail: "Candidates with a refusal say why they cannot be used." },
        { label: "Add, enable, disable or remove an interlock" },
        { label: "Import module-io.json", detail: "Bindings by name, from another module's export." },
        {
          label: runtime.bridgeRunning ? "Stop the process bridge" : "Start the process bridge",
          detail: registry.readyToRun ? ASK : "Needs a ready module and a started factory.",
          tone: registry.readyToRun ? "warn" : "info",
        },
        {
          label: "Override a test input",
          detail: `AUTO, MANUAL_OVERRIDE or SCENARIO on a measured process value. ${ASK}`,
          tone: "warn",
        },
        { label: "Delete module", detail: "Asks for confirmation.", tone: "warn" },
      ],
      constraints: [
        { label: "A required role needs a device of an accepted category" },
        {
          label: "Bindings follow the PLC tag rules",
          detail:
            "Program-driven tags only as commands, feedback into %M memory, type and unit compatibility, no overlap, one module per tag (docs/process-modules.md).",
        },
        {
          label: "The process model computes response only",
          detail: "PLC logic stays the control, interlock and PID authority (docs/rules.md 41).",
        },
        {
          label: "Overrides never set a PLC's local outputs",
          detail: "They force measured process values (ADR-0015).",
        },
      ],
      decisions: [
        ...emptyRequired.map((role) => ({
          label: `Which device for ${role.name}?`,
          decision: {
            kind: "relationship" as const,
            confirm: "required" as const,
            enforced: "Only devices of the categories the role accepts.",
          },
          detail: `Required; accepts ${role.deviceCategoryCodes.join(", ") || "any category"}.`,
        })),
        ...(blocking.length > 0
          ? [
              {
                label: "Which PLC tags carry the required signals?",
                decision: {
                  kind: "channel" as const,
                  confirm: "required" as const,
                  enforced: "Candidates with a refusal cannot be bound; one module per tag; type and unit must match.",
                },
                detail: "Ask which PLC and which channels before binding.",
              },
            ]
          : []),
        ...(runtime.bridgeRunning
          ? [
              {
                label: "The bridge is running",
                decision: { kind: "run-state" as const, confirm: "required" as const },
                detail: ASK,
              },
            ]
          : []),
      ],
      navigation: [
        { label: "Process modules", href: routes.modules(f) },
        { label: "Factory overview", href: routes.factory(f) },
        { label: "Designer", href: routes.designer(f), detail: "The devices and their wiring." },
        ...registry.plcs.map((plc) => ({
          label: `${plc.plcName} I/O mapping`,
          href: routes.plcIoMapping(f, plc.plcId),
        })),
        { label: "Download module-io.json", href: routes.moduleIoFile(f, module.id) },
        { label: "LLM Index", href: routes.llmIndex() },
      ],
    },
  );
}
