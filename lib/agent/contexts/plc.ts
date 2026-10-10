import { createLlmContext, type LlmContextDocument, type LlmContextItem } from "@/lib/agent/llm-context";
import { routePattern } from "@/lib/agent/llm-index";
import type { PlcCommunicationView } from "@/lib/domain/plc-communication-view";
import type { InstallableModuleView, PlcConfigurationView } from "@/lib/domain/plc-config-view";
import type { PlcProgramView, PlcRuntimeView, PlcVersionsView } from "@/lib/domain/plc-runtime-view";
import { runtimeStateLabel } from "@/lib/domain/runtime-state";
import type { PlcExportDocument } from "@/lib/export/plc-export";
import { routes } from "@/lib/navigation/routes";

/** The screens of a stored PLC (`StoredPlcSection` in components/plc/stored-plc-shell.tsx). */
export type PlcContextSection =
  | "overview"
  | "hardware"
  | "connections"
  | "communication"
  | "program"
  | "io-mapping"
  | "versions"
  | "runtime"
  | "export";

export type PlcContextInput = {
  factory: { id: string; name: string };
  view: PlcConfigurationView;
  section: PlcContextSection;
  /** What the section's screen loaded besides the configuration, when it loads more. */
  installable?: readonly InstallableModuleView[];
  program?: PlcProgramView;
  versions?: PlcVersionsView;
  runtime?: PlcRuntimeView;
  communication?: PlcCommunicationView;
  exportDocument?: PlcExportDocument;
};

type SectionMeta = { page: string; area: string; route: (factoryId: string, plcId: string) => string; summary: string };

const SECTIONS: Record<PlcContextSection, SectionMeta> = {
  overview: {
    page: "PLC overview",
    area: "plc",
    route: routes.plc,
    summary:
      "The PLC as configured: its model, I/O occupancy, ports and the devices wired to it; the way into its other screens.",
  },
  hardware: {
    page: "PLC hardware",
    area: "plc",
    route: (f, p) => routes.plcHardware(f, p),
    summary:
      "The PLC's I/O points as pins, with each point's signal, program address, tag and device; a modular PLC's rack, installed modules and the form to install one.",
  },
  connections: {
    page: "PLC connections",
    area: "plc",
    route: routes.plcConnections,
    summary:
      "The devices wired to this PLC, terminal by terminal: channel, address and tag. Read-only; wires are made in the designer.",
  },
  "io-mapping": {
    page: "PLC I/O mapping",
    area: "plc",
    route: routes.plcIoMapping,
    summary:
      "Every channel of the PLC with its program address, Modbus address, tag and device. Read-only; it follows the wiring.",
  },
  program: {
    page: "PLC program",
    area: "program",
    route: (f, p) => routes.plcProgram(f, p),
    summary:
      "The PLC's Structured Text program: Check compiles it, Save version stores it, Save & deploy runs it on a started runtime.",
  },
  versions: {
    page: "PLC versions",
    area: "program",
    route: routes.plcVersions,
    summary:
      "Every stored program version, which one the next start uses, and the configuration recorded at each deployment.",
  },
  runtime: {
    page: "PLC runtime",
    area: "runtime",
    route: routes.plcRuntime,
    summary:
      "The PLC's OpenPLC runtime: its real state, program, Modbus endpoint and the operations Start, Deploy, Restart, Stop, Remove and Refresh state.",
  },
  communication: {
    page: "PLC communication",
    area: "plc-communication",
    route: routes.plcCommunication,
    summary:
      "Modbus TCP links between this PLC and other PLCs of the factory, their tag-to-tag mappings and their live health.",
  },
  export: {
    page: "PLC export",
    area: "export",
    route: routes.plcExport,
    summary:
      "The PLC's engineering snapshot: the report, the downloads (JSON and CSV schedules) and the edge deployment file.",
  },
};

const STATE_TONE: Record<PlcConfigurationView["plc"]["runtimeStatus"], LlmContextItem["tone"]> = {
  STOPPED: "info",
  STARTING: "info",
  RUNNING: "ok",
  STOPPING: "info",
  DEGRADED: "warn",
  FAULTED: "fault",
  DISCONNECTED: "warn",
};

const ASK_BEFORE_RUNTIME = "Ask the user before changing what runs.";

/** The LLM Context of a stored PLC's screen, from what the screen renders. */
export function buildPlcContext(input: PlcContextInput): LlmContextDocument {
  const { factory, view, section } = input;
  const { plc, model, occupancy, peripherals, banks, rack, ports } = view;
  const meta = SECTIONS[section];
  const f = factory.id;
  const p = plc.id;
  const modular = plc.architectureType === "MODULAR";
  const free = occupancy.total - occupancy.occupied;
  const running = plc.runtimeStatus !== "STOPPED";
  const freeSlots = rack ? rack.slots.filter((slot) => slot.module === null).length : 0;

  const context: LlmContextItem[] = [
    { label: "Factory", value: factory.name, href: routes.factory(f) },
    {
      label: "Model",
      value: `${model.manufacturer} ${model.modelName}`,
      href: routes.catalog({ model: model.id }),
      detail: `${model.verificationStatus.toLowerCase()} catalog record · ${model.categoryCode}`,
    },
    {
      label: "Architecture",
      value: modular ? "modular" : "compact",
      detail: rack ? `${rack.name}, ${rack.slotCount} slots` : undefined,
    },
    {
      label: "Runtime",
      value: model.runtimeSupport === "OPENPLC" ? "OpenPLC" : "none",
      detail: "The program runs on OpenPLC; the vendor model is a hardware profile.",
    },
    { label: "Runtime state", value: runtimeStateLabel(plc.runtimeStatus), tone: STATE_TONE[plc.runtimeStatus] },
    { label: "Role", value: plc.role ?? "none" },
    {
      label: "I/O",
      value: `${occupancy.occupied}/${occupancy.total} channels used`,
      detail: `I/O mapping v${plc.ioMappingVersion} · Modbus mapping v${plc.modbusMappingVersion}`,
    },
  ];

  const objects: LlmContextItem[] = [
    ...peripherals.map((device) => ({
      label: device.name,
      value: `${device.categoryName} · ${device.modelName}`,
      href: routes.device(f, device.deviceId),
      detail:
        device.connection === "DIRECT_IO"
          ? `${device.wires.length} wire${device.wires.length === 1 ? "" : "s"}${device.role ? ` · ${device.role}` : ""}`
          : `over ${device.protocols.join(", ") || "a protocol"}${device.role ? ` · ${device.role}` : ""}`,
    })),
    ...(rack
      ? rack.slots
          .filter((slot) => slot.module)
          .map((slot) => ({
            label: `Slot ${slot.slotIndex}: ${slot.module!.modelName}`,
            value: `${slot.module!.moduleType} · ${slot.module!.occupiedCount}/${slot.module!.pointCount} points used`,
            href: routes.plcHardware(f, p),
          }))
      : []),
    ...ports.map((port) => ({
      label: `Port ${port.name}`,
      value: `${port.physicalType} · ${port.protocols.join(", ") || "no protocol"}`,
    })),
  ];

  const relationships: LlmContextItem[] = peripherals.map((device) =>
    device.connection === "DIRECT_IO"
      ? {
          label: `${device.name} is wired to ${plc.name}`,
          value: device.wires
            .map((wire) => `${wire.terminalLabel ?? "?"} → ${wire.pointLabel} (${wire.logicalAddress})`)
            .join("; "),
          href: routes.plcConnections(f, p),
        }
      : {
          label: `${device.name} communicates with ${plc.name}`,
          value: device.protocols.join(", "),
          href: routes.plcConnections(f, p),
        },
  );

  const capacity: LlmContextItem[] = [
    {
      label: "All channels",
      value: `${free} of ${occupancy.total} free`,
      tone: occupancy.total > 0 && free === 0 ? "warn" : "info",
    },
    ...banks.map((bank) => {
      const bankFree = bank.points.filter((point) => point.status === "FREE").length;
      return {
        label: bank.label,
        value: `${bankFree} of ${bank.points.length} ${bank.ioType} free`,
        href: routes.plcHardware(f, p),
        tone: bank.points.length > 0 && bankFree === 0 ? ("warn" as const) : ("info" as const),
      };
    }),
    ...(rack
      ? [{ label: "Rack slots", value: `${freeSlots} of ${rack.slotCount} free`, href: routes.plcHardware(f, p) }]
      : []),
  ];

  const validation: LlmContextItem[] = [];
  if (plc.runtimeStatus === "FAULTED" || plc.runtimeStatus === "DEGRADED" || plc.runtimeStatus === "DISCONNECTED")
    validation.push({
      label: `Runtime is ${runtimeStateLabel(plc.runtimeStatus).toLowerCase()}`,
      href: routes.plcRuntime(f, p),
      tone: STATE_TONE[plc.runtimeStatus],
    });
  if (peripherals.length === 0)
    validation.push({
      label: "Nothing is wired to this PLC",
      href: routes.designer(f),
      detail: "Connect devices in the designer.",
      tone: "warn",
    });
  if (occupancy.total > 0 && free === 0)
    validation.push({
      label: "No free channel",
      detail: modular ? "Install a module with free points." : "A compact PLC cannot grow.",
      tone: "warn",
    });

  const actions: LlmContextItem[] = [];
  const constraints: LlmContextItem[] = [
    {
      label: "Wires are made in the designer only",
      detail: "The connections and I/O mapping screens show the wiring; they do not change it (TASK-307).",
    },
    {
      label: "A channel takes one compatible signal",
      detail: "Occupied, incompatible or wrong-type channels are refused.",
    },
    {
      label: "The program owns the PLC's local outputs",
      detail: "Nothing outside it sets a coil or an output register (ADR-0015).",
    },
    {
      label: "Modbus addresses are stable configuration",
      detail: "External clients keep the same address after a restart.",
    },
    ...(modular
      ? [{ label: "A module needs a free, compatible slot", detail: "The install form offers only those." }]
      : [{ label: "A compact PLC has no rack", detail: "Its I/O is what the model has." }]),
  ];
  const decisions: LlmContextItem[] = [];
  if (peripherals.length === 0)
    decisions.push({
      label: "What should this PLC control?",
      detail: "Ask which devices to wire before adding any.",
      href: routes.designer(f),
    });
  if (modular && freeSlots > 0)
    decisions.push({
      label: "Which modules?",
      detail: "Ask what signals the plant needs before installing modules.",
      href: routes.plcHardware(f, p),
    });
  if (running) decisions.push({ label: "The runtime is running", detail: ASK_BEFORE_RUNTIME });

  const sectionItems = applySection(input, { actions, validation, decisions, context, objects, relationships });

  const navigation: LlmContextItem[] = [
    { label: "Overview", href: routes.plc(f, p) },
    { label: "Hardware", href: routes.plcHardware(f, p), detail: modular ? "Pins, rack and modules." : "Pins." },
    { label: "Connections", href: routes.plcConnections(f, p), detail: "What is wired, read-only." },
    { label: "Communication", href: routes.plcCommunication(f, p), detail: "Links to other PLCs." },
    { label: "Program", href: routes.plcProgram(f, p), detail: "Edit, check, save, deploy." },
    { label: "I/O mapping", href: routes.plcIoMapping(f, p) },
    { label: "Versions", href: routes.plcVersions(f, p) },
    { label: "Runtime", href: routes.plcRuntime(f, p), detail: "Start, stop, real state." },
    { label: "Export", href: routes.plcExport(f, p) },
    { label: "Designer", href: routes.designer(f), detail: "Wire devices to this PLC." },
    { label: "Simulator", href: routes.simulator(f), detail: "The simulated field this PLC drives." },
    { label: "Live tags", href: routes.tags(f, p), detail: "This PLC's live values." },
    { label: "Events", href: routes.events(f, { device: p }), detail: "This PLC's events." },
    { label: "Factory overview", href: routes.factory(f) },
  ].filter((item) => item.href !== meta.route(f, p));

  return createLlmContext(
    {
      page: meta.page,
      area: meta.area,
      route: meta.route(f, p),
      routePattern: routePattern(meta.route("factoryId", "plcId")),
      subject: `${plc.name} (${factory.name})`,
      summary: meta.summary,
    },
    {
      context: sectionItems.context,
      objects: sectionItems.objects,
      relationships: sectionItems.relationships,
      capacity,
      validation: { items: sectionItems.validation },
      actions: sectionItems.actions,
      constraints,
      decisions: sectionItems.decisions,
      navigation,
    },
  );
}

type Lists = Record<"actions" | "validation" | "decisions" | "context" | "objects" | "relationships", LlmContextItem[]>;

/** What each screen adds to the common PLC context: its own data, actions and issues. */
function applySection(input: PlcContextInput, lists: Lists): Lists {
  const { factory, view, section } = input;
  const f = factory.id;
  const p = view.plc.id;
  const running = view.plc.runtimeStatus !== "STOPPED";
  const { actions, validation, decisions, context, objects, relationships } = lists;

  switch (section) {
    case "overview":
      actions.push(
        {
          label: "Delete PLC",
          detail: "Asks for confirmation. Removes the PLC, its wiring, tags and program.",
          tone: "warn",
        },
        { label: "Open hardware", href: routes.plcHardware(f, p) },
        { label: "Open the catalog record", href: routes.catalog({ model: view.model.id }) },
      );
      break;
    case "hardware": {
      const installable = input.installable ?? [];
      if (view.rack) {
        for (const candidate of installable)
          objects.push({
            label: `Installable: ${candidate.modelName}`,
            value: `${candidate.moduleType} · ${candidate.channels.map((c) => `${c.count} ${c.ioType}`).join(", ")}`,
          });
        actions.push(
          {
            label: "Install module",
            detail:
              installable.length > 0
                ? `${installable.length} compatible module model${installable.length === 1 ? "" : "s"} offered, into a free slot.`
                : "No compatible module model in the catalog.",
          },
          { label: "Remove module", detail: "Asks for confirmation; only a module with no wired point." },
        );
      }
      actions.push({
        label: "Select a pin",
        detail: "`?pin=` shows one point's signal, addresses, tag and device.",
        href: routes.plcHardware(f, p),
      });
      break;
    }
    case "connections":
    case "io-mapping":
      actions.push({
        label: "Change the wiring in the designer",
        href: routes.designer(f),
        detail: "This screen is a read-only projection.",
      });
      break;
    case "program": {
      const program = input.program;
      const runtime = input.runtime;
      if (program) {
        context.push(
          {
            label: "Editor opens",
            value: program.sourceVersion ? `version ${program.sourceVersion}` : "the starter program",
            detail: program.sourceVersion
              ? undefined
              : "A starter that declares every tag as a located variable; nothing is stored yet.",
          },
          { label: "Stored versions", value: String(program.versions.length), href: routes.plcVersions(f, p) },
          {
            label: "Located variables",
            value: String(program.locatedVariables.length),
            detail:
              program.locatedVariables
                .slice(0, 12)
                .map((v) => `${v.name} AT ${v.address}: ${v.type}`)
                .join("; ") || undefined,
          },
          { label: "Source limit", value: `${program.maxSourceBytes} bytes` },
        );
        if (program.versions.length === 0)
          validation.push({ label: "No program version stored", detail: "Check, then Save version.", tone: "warn" });
        if (!program.versions.some((v) => v.selected) && program.versions.length > 0)
          validation.push({
            label: "No version selected for the next start",
            href: routes.plcVersions(f, p),
            tone: "warn",
          });
        if (program.versions.length === 0)
          decisions.push({
            label: "Control logic",
            detail: "Ask for the control strategy, setpoints and interlocks before writing the program.",
          });
      }
      if (runtime) {
        context.push({
          label: "Deployed program",
          value: runtime.deployedProgram ? `version ${runtime.deployedProgram.version}` : "none",
          detail: runtime.created ? undefined : "No runtime container exists yet.",
        });
      }
      actions.push(
        { label: "Check", detail: "Compiles without saving; findings are listed with line and column." },
        { label: "Save version", detail: "Stores an immutable version and selects it for the next start." },
        {
          label: "Save & deploy",
          detail: runtime?.created
            ? "Stores it and runs it on the started runtime."
            : "Needs a started runtime; start the PLC first.",
          tone: running ? "warn" : "info",
          href: running ? undefined : routes.plcRuntime(f, p),
        },
      );
      break;
    }
    case "versions": {
      const versions = input.versions;
      if (versions) {
        for (const version of versions.versions)
          objects.push({
            label: `Version ${version.version}`,
            value: `${version.status.toLowerCase()}${version.selected ? " · selected for the next start" : ""}`,
            href: routes.plcProgram(f, p, version.version),
            tone: version.status === "FAILED" ? "fault" : version.selected ? "ok" : "info",
          });
        context.push(
          { label: "Deployments recorded", value: String(versions.deployments.length) },
          { label: "Runtime container", value: versions.runtimeCreated ? "exists" : "none" },
        );
        if (versions.versions.length === 0)
          validation.push({ label: "No program version stored", href: routes.plcProgram(f, p), tone: "warn" });
        if (versions.versions.some((v) => v.status === "FAILED"))
          validation.push({
            label: "A version failed to compile or deploy",
            detail: "Open it in the editor to read the findings.",
            tone: "warn",
          });
      }
      actions.push(
        { label: "Use for next start", detail: "Selects a version; the next start or deploy uses it." },
        {
          label: "Deploy now",
          detail: versions?.runtimeCreated
            ? `Runs the version on the runtime. ${ASK_BEFORE_RUNTIME}`
            : "Disabled: no runtime container exists.",
          tone: versions?.runtimeCreated ? "warn" : "info",
        },
      );
      break;
    }
    case "runtime": {
      const runtime = input.runtime;
      if (runtime) {
        context.push(
          {
            label: "Real state",
            value: runtime.liveError
              ? `${runtimeStateLabel(runtime.state)} (stored)`
              : runtimeStateLabel(runtime.state),
            tone: STATE_TONE[runtime.state],
          },
          { label: "Runtime container", value: runtime.created ? "exists" : "none" },
          {
            label: "Runtime version",
            value: runtime.runtimeVersion ?? "unknown",
            detail: runtime.image ? `image ${runtime.image}` : undefined,
          },
          {
            label: "Modbus TCP endpoint",
            value: runtime.modbus ? `${runtime.modbus.bindAddress}:${runtime.modbus.hostPort}` : "not published yet",
            detail: "What gateways and edge clients connect to.",
          },
          {
            label: "Selected program",
            value: runtime.selectedProgram
              ? `version ${runtime.selectedProgram.version} (${runtime.selectedProgram.status.toLowerCase()})`
              : "none",
          },
          {
            label: "Deployed program",
            value: runtime.deployedProgram ? `version ${runtime.deployedProgram.version}` : "none",
          },
        );
        for (const event of runtime.events.slice(0, 5))
          objects.push({
            label: event.type,
            value: event.occurredAt,
            detail: event.detail,
            tone: event.severity === "CRITICAL" ? "fault" : event.severity === "WARNING" ? "warn" : "info",
          });
        if (runtime.liveError)
          validation.push({ label: "The live state could not be read", detail: runtime.liveError, tone: "warn" });
        if (!runtime.selectedProgram)
          validation.push({
            label: "No program selected",
            href: routes.plcProgram(f, p),
            detail: "A start runs nothing until a version is saved.",
            tone: "warn",
          });
        const created = runtime.created;
        const state = runtime.state;
        actions.push(
          {
            label: "Start",
            detail:
              state === "RUNNING"
                ? "Already running."
                : "Creates the network and container if needed, starts OpenPLC and deploys the selected program. Can take minutes.",
            tone: state === "RUNNING" ? "info" : "warn",
          },
          {
            label: "Deploy",
            detail: created
              ? `Rebuilds and reloads the selected program on the runtime. ${ASK_BEFORE_RUNTIME}`
              : "Needs a runtime.",
            tone: created ? "warn" : "info",
          },
          {
            label: "Restart",
            detail: created ? `Restarts the container; the program reloads. ${ASK_BEFORE_RUNTIME}` : "Needs a runtime.",
            tone: created ? "warn" : "info",
          },
          {
            label: "Stop",
            detail:
              state === "RUNNING"
                ? `Stops the container; the Modbus endpoint and history stay. ${ASK_BEFORE_RUNTIME}`
                : "Nothing is running.",
            tone: state === "RUNNING" ? "warn" : "info",
          },
          {
            label: "Remove",
            detail: created
              ? "Asks first. Removes the container; versions and the Modbus endpoint are kept."
              : "No container to remove.",
            tone: created ? "warn" : "info",
          },
          { label: "Refresh state", detail: "Re-reads the real state from the runtime and stores it." },
        );
      }
      break;
    }
    case "communication": {
      const communication = input.communication;
      if (communication) {
        for (const peer of communication.peers)
          objects.push({
            label: `Peer ${peer.name}`,
            value: runtimeStateLabel(peer.runtimeStatus),
            href: routes.plcCommunication(f, peer.plcId),
            detail: peer.servesModbus ? "Serves Modbus TCP." : "Does not serve Modbus TCP.",
          });
        for (const { link, role, peer, health, mappings, deployedVersion } of communication.links) {
          const stale = link.enabled && deployedVersion !== null && deployedVersion !== link.configVersion;
          relationships.push({
            label: `${view.plc.name} is the ${role} of a ${link.protocol} link with ${peer.name}`,
            value: `${mappings.length} mapping${mappings.length === 1 ? "" : "s"} · ${link.enabled ? "enabled" : "disabled"} · every ${link.pollIntervalMs} ms`,
            detail: health
              ? `${health.quality.toLowerCase()}${health.reason ? `: ${health.reason}` : ""}`
              : "no live health while nothing runs",
            tone: health?.quality === "DISCONNECTED" ? "fault" : health?.quality === "STALE" || stale ? "warn" : "info",
          });
          if (health && health.quality !== "GOOD")
            validation.push({
              label: `Link with ${peer.name} is ${health.quality.toLowerCase()}`,
              detail: health.reason ?? undefined,
              tone: health.quality === "DISCONNECTED" ? "fault" : "warn",
            });
          if (stale)
            validation.push({
              label: `Link with ${peer.name} changed since it was deployed`,
              detail: "Deploy the client PLC's program to apply it.",
              tone: "warn",
            });
        }
        context.push(
          { label: "Links", value: String(communication.links.length) },
          { label: "Peers in the factory", value: String(communication.peers.length) },
          { label: "Watched", value: communication.watched ? "yes" : "no" },
        );
        if (communication.peers.length === 0)
          validation.push({ label: "No other PLC in the factory", detail: "A link needs a second PLC.", tone: "info" });
        actions.push(
          {
            label: "Create link",
            detail: "Choose the peer, which end is the client, the protocol and the poll interval.",
          },
          {
            label: "Add mapping",
            detail:
              "A READ into free %I/%M memory, or a WRITE of a program value to the server's command or setpoint tag; one writer per value.",
          },
          { label: "Enable, disable or remove a link or a mapping" },
          { label: "Download link.json", detail: "The link with its mappings." },
        );
        decisions.push({
          label: "Which PLC is the client?",
          detail: "Ask which end polls and which values cross the link.",
        });
      }
      break;
    }
    case "export": {
      const document = input.exportDocument;
      if (document) {
        context.push(
          {
            label: "Configuration revision",
            value: document.revision.configuration.slice(0, 12),
            detail: "Equal configurations give equal revisions.",
          },
          {
            label: "Mappings",
            value: `I/O v${document.revision.ioMapping} · Modbus v${document.revision.modbusMapping}`,
          },
          {
            label: "Program in the export",
            value: document.revision.program
              ? `version ${document.revision.program.version} (${document.revision.program.status.toLowerCase()})`
              : "none",
          },
          {
            label: "Deployed snapshot",
            value: document.revision.deployedSnapshot
              ? `version ${document.revision.deployedSnapshot.version}`
              : "none",
          },
          { label: "Generated", value: document.generatedAt },
        );
        if (!document.revision.program)
          validation.push({ label: "The export has no program", href: routes.plcProgram(f, p), tone: "warn" });
      }
      actions.push(
        {
          label: "Open printable report",
          href: routes.plcExportReport(f, p),
          detail: "The report alone; print it from the browser.",
        },
        { label: "Download plc.json", href: routes.plcExportFile(f, p, "plc.json") },
        { label: "Download io.csv", href: routes.plcExportFile(f, p, "io.csv") },
        { label: "Download tags.csv", href: routes.plcExportFile(f, p, "tags.csv") },
        { label: "Download devices.csv", href: routes.plcExportFile(f, p, "devices.csv") },
        {
          label: "Download the edge deployment",
          href: routes.plcEdgeDeployment(f, p),
          detail: "What the Thin Client Agent runs from.",
        },
        { label: "Include the stored runtime state", detail: "A switch; `?runtime=1` on the report." },
      );
      break;
    }
  }
  return lists;
}
