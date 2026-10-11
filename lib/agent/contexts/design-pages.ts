import { createLlmContext, type LlmContextDocument, type LlmContextItem } from "@/lib/agent/llm-context";
import { routePattern } from "@/lib/agent/llm-index";
import type { CatalogModelDetail, CatalogOverview, PeripheralCompatibility } from "@/lib/domain/catalog-view";
import type { DeviceSection } from "@/lib/domain/device-capabilities";
import type { DeviceDetailView } from "@/lib/domain/device-detail-view";
import type { FactoryDeviceView, PlcModelOption } from "@/lib/domain/plc-config-view";
import { runtimeStateLabel } from "@/lib/domain/runtime-state";
import type { FactorySceneView } from "@/lib/domain/scene-view";
import type { TopologyView } from "@/lib/domain/topology-view";
import { routes } from "@/lib/navigation/routes";
import type { FactoryView } from "@/lib/services/factory-service";

/**
 * The LLM Contexts of the design screens (TASK-1003, PR C): designer and topology, the 3D
 * view, the device screens, the new-PLC form, the catalog and the Factories list.
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

const RELATIONSHIP_TEXT: Record<string, string> = {
  CONTROLS: "controls",
  DRIVES: "drives",
  MECHANICALLY_DRIVES: "mechanically drives",
  MEASURES: "measures",
  FEEDS_BACK_TO: "feeds back to",
  COMMUNICATES_WITH: "communicates with",
  WIRED_TO: "is wired to",
};

// ---------------------------------------------------------------------------------------
// Designer and topology

export type TopologyContextInput = { factory: FactoryView; view: TopologyView; mode: "designer" | "topology" };

export function buildTopologyContext({ factory, view, mode }: TopologyContextInput): LlmContextDocument {
  const f = factory.id;
  const designing = mode === "designer";
  const byId = new Map(view.nodes.map((node) => [node.id, node]));
  const plcs = view.nodes.filter((node) => node.architectureType !== null);
  const connected = new Set(view.edges.flatMap((edge) => [edge.sourceId, edge.targetId]));
  const loose = view.nodes.filter((node) => !connected.has(node.id) && node.architectureType === null);
  const faulted = view.nodes.filter((node) => node.runtimeStatus === "FAULTED");
  const href = (node: TopologyView["nodes"][number]) =>
    node.architectureType ? routes.plc(f, node.id) : routes.device(f, node.id);

  const validation: LlmContextItem[] = [];
  if (plcs.length === 0)
    validation.push({
      label: "No PLC",
      detail: "Place a PLC from the palette first; peripherals are wired to it.",
      tone: "warn",
    });
  for (const node of loose)
    validation.push({ label: `${node.name} is connected to nothing`, href: href(node), tone: "warn" });
  for (const node of faulted) validation.push({ label: `${node.name} is faulted`, href: href(node), tone: "fault" });

  return createLlmContext(
    {
      page: designing ? "Designer" : "Topology",
      area: designing ? "designer" : "topology",
      route: designing ? routes.designer(f) : routes.topology(f),
      routePattern: routePattern(designing ? routes.designer("factoryId") : routes.topology("factoryId")),
      subject: factory.name,
      summary: designing
        ? "The canvas where devices are added from the catalog palette and connected. Drawing a connection creates the relationship the two devices allow; wiring to a PLC picks free, compatible channels and makes the tags. Every change is validated and saved as it is made."
        : "The designer's canvas, read-only: the devices, their relationships and wiring, with the stored runtime state as an overlay.",
    },
    {
      context: [
        { label: "Devices", value: `${view.nodes.length} · ${plcs.length} PLCs` },
        { label: "Connections", value: String(view.edges.length) },
        {
          label: "Factory state",
          value: runtimeStateLabel(factory.runtimeStatus),
          tone: STATE_TONE[factory.runtimeStatus],
        },
        {
          label: "Palette",
          value: `${view.palette.reduce((sum, group) => sum + group.items.length, 0)} catalog models in ${view.palette.length} categories`,
          href: routes.catalog(),
        },
      ],
      objects: view.nodes.map((node) => ({
        label: node.name,
        value: `${node.categoryName} · ${node.manufacturer} ${node.modelName}`,
        href: href(node),
        detail: [
          node.role,
          runtimeStateLabel(node.runtimeStatus),
          node.placed ? undefined : "not placed yet (grid slot)",
        ]
          .filter(Boolean)
          .join(" · "),
        tone: STATE_TONE[node.runtimeStatus],
      })),
      relationships: view.edges.map((edge) => {
        const source = byId.get(edge.sourceId)?.name ?? edge.sourceId;
        const target = byId.get(edge.targetId)?.name ?? edge.targetId;
        return {
          label: `${source} ${RELATIONSHIP_TEXT[edge.relationship] ?? edge.relationship.toLowerCase()} ${target}`,
          value:
            edge.wires.length > 0
              ? `${edge.wires.length} wire${edge.wires.length === 1 ? "" : "s"}`
              : edge.protocol
                ? `over ${edge.protocol}`
                : undefined,
          detail:
            edge.wires.length > 0
              ? edge.wires
                  .map((wire) => `${wire.from.name} → ${wire.to.name}${wire.tagName ? ` (${wire.tagName})` : ""}`)
                  .join("; ")
              : edge.plcLink
                ? "a PLC-to-PLC link, configured on the PLC's Communication screen"
                : undefined,
        };
      }),
      capacity: view.palette.map((group) => ({
        label: group.categoryName,
        value: `${group.items.length} model${group.items.length === 1 ? "" : "s"} to place`,
      })),
      validation: { items: validation },
      actions: designing
        ? [
            {
              label: "Add a device",
              detail: "Drag a palette item onto the canvas, or press its +; it gets the next free numbered name.",
            },
            {
              label: "Connect two devices",
              detail:
                "Draw from one device's handle to another. The relationship follows from the two devices; when several apply, the canvas asks which. A refused connection shows its reason.",
            },
            {
              label: "Wire pin to pin",
              detail: "Between a PLC and a device with terminals: each terminal to a free compatible channel.",
            },
            { label: "Rename a device or set its role", detail: "In the inspector of the selected device." },
            {
              label: "Remove a device or a connection",
              detail: "Asks for confirmation; removing a wired edge disconnects the device from the PLC as a whole.",
              tone: "warn",
            },
          ]
        : [{ label: "Edit in designer", href: routes.designer(f), detail: "This view changes nothing." }],
      constraints: [
        {
          label: "A connection must resolve to valid, compatible, free endpoints",
          detail:
            "No free channel, a wrong signal, a second motor on a drive or no possible relationship is refused (docs/rules.md 17).",
        },
        { label: "One VFD drives one primary motor" },
        { label: "Device names are unique within the factory" },
        {
          label: "The canvas stores nothing it does not validate",
          detail: "There is no Save button: every change is checked and saved when made.",
        },
      ],
      decisions: [
        ...(plcs.length === 0
          ? [
              {
                label: "Which PLC?",
                decision: {
                  kind: "model" as const,
                  confirm: "required" as const,
                  enforced: "PLC identity is manufacturer, family and exact model; a vendor model runs on OpenPLC.",
                },
                detail: "Ask for the architecture and model before placing one.",
                href: routes.catalog({ type: "PLC" }),
              },
            ]
          : []),
        {
          label: "Which model for a new device?",
          decision: {
            kind: "model" as const,
            confirm: "required" as const,
            enforced: "A device is created from a catalog model and keeps its facts.",
          },
          detail: "Vendor models are hardware profiles with sources; generic ones are simulated. Ask before placing.",
        },
        {
          label: "Which relationship, when the canvas asks?",
          decision: {
            kind: "relationship" as const,
            confirm: "required" as const,
            enforced: "Only the relationships the two devices allow; one VFD drives one primary motor.",
          },
          detail: "A drive and a motor, a sensor and what it measures: the user decides.",
        },
        ...(plcs.length > 1
          ? [
              {
                label: "Which PLC to wire to?",
                decision: {
                  kind: "endpoint" as const,
                  confirm: "required" as const,
                  enforced: "A device wires to one PLC's free compatible channels.",
                },
                value: plcs.map((plc) => plc.name).join(", "),
                detail: "More than one PLC can take the device; the user decides which controls it.",
              },
            ]
          : []),
        ...(factory.runtimeStatus !== "STOPPED"
          ? [
              {
                label: "The factory is running",
                decision: { kind: "run-state" as const, confirm: "required" as const },
                detail: "Rewiring a running plant changes its I/O; ask first.",
              },
            ]
          : []),
      ],
      navigation: [
        {
          label: designing ? "Topology (read-only)" : "Designer",
          href: designing ? routes.topology(f) : routes.designer(f),
        },
        { label: "3D view", href: routes.view3d(f) },
        { label: "Factory overview", href: routes.factory(f) },
        { label: "Device catalog", href: routes.catalog(), detail: "What the palette offers, with provenance." },
        ...plcs.slice(0, 3).map((plc) => ({
          label: `${plc.name} hardware`,
          href: routes.plcHardware(f, plc.id),
          detail: "Free channels before wiring.",
        })),
        { label: "Runtime", href: routes.runtime(f) },
        { label: "LLM Index", href: routes.llmIndex() },
      ],
    },
  );
}

// ---------------------------------------------------------------------------------------
// 3D view

export function buildView3dContext({
  factory,
  scene,
}: {
  factory: FactoryView;
  scene: FactorySceneView;
}): LlmContextDocument {
  const f = factory.id;
  const byId = new Map(scene.devices.map((device) => [device.id, device]));
  const withAsset = scene.devices.filter((device) => device.asset);

  return createLlmContext(
    {
      page: "3D view",
      area: "topology",
      route: routes.view3d(f),
      routePattern: routePattern(routes.view3d("factoryId")),
      subject: factory.name,
      summary:
        "The factory in 3D with its stored runtime state: a visualization, not the authoritative model. Devices with a catalog 3D asset are drawn with it, the rest as generic shapes.",
    },
    {
      context: [
        { label: "Devices", value: String(scene.devices.length) },
        { label: "With a catalog asset", value: `${withAsset.length}/${scene.devices.length}` },
        { label: "Floor", value: `${scene.extent * 2} m square` },
        {
          label: "Factory state",
          value: runtimeStateLabel(factory.runtimeStatus),
          tone: STATE_TONE[factory.runtimeStatus],
        },
      ],
      objects: scene.devices.map((device) => ({
        label: device.name,
        value: `${device.categoryName} · ${device.modelName}`,
        href: device.isPlc ? routes.plc(f, device.id) : routes.device(f, device.id),
        detail: `${runtimeStateLabel(device.runtimeStatus)} · ${device.asset ? `asset v${device.asset.version}` : "generic shape"}`,
        tone: STATE_TONE[device.runtimeStatus],
      })),
      relationships: scene.connections.map((connection) => ({
        label: `${byId.get(connection.sourceId)?.name ?? connection.sourceId} ${RELATIONSHIP_TEXT[connection.relationship] ?? connection.relationship.toLowerCase()} ${byId.get(connection.targetId)?.name ?? connection.targetId}`,
      })),
      capacity: [],
      validation: { items: [] },
      actions: [
        {
          label: "Select, scale or rotate a device",
          detail: "Scale and rotation of an instance are saved; they change nothing in the plant.",
        },
        { label: "Edit in designer", href: routes.designer(f) },
      ],
      constraints: [
        {
          label: "Visualization only",
          detail: "Nothing here changes the design or the plant; the designer and the PLC screens are authoritative.",
        },
      ],
      decisions: [],
      navigation: [
        { label: "Designer", href: routes.designer(f) },
        { label: "Topology", href: routes.topology(f) },
        { label: "Factory overview", href: routes.factory(f) },
        { label: "LLM Index", href: routes.llmIndex() },
      ],
    },
  );
}

// ---------------------------------------------------------------------------------------
// Device screens

const DEVICE_PAGES: Partial<Record<DeviceSection, { page: string; summary: string }>> = {
  overview: {
    page: "Device overview",
    summary:
      "A device that is not a controller: its model, role, state, ports, and the screens its model's capabilities give it.",
  },
  hardware: { page: "Device hardware", summary: "The device's hardware as the catalog documents it." },
  connections: {
    page: "Device connections",
    summary:
      "The device's wires, read from the factory's wiring: each terminal to the PLC channel and tag it carries. Read-only; wires are made in the designer.",
  },
  parameters: {
    page: "Device parameters",
    summary:
      "The device's configurable parameters, saved as immutable versions. Applied to the simulation when the model is simulated.",
  },
  registers: {
    page: "Device registers",
    summary: "The tags that carry the device's signals, with their PLC, address and Modbus register.",
  },
  communications: { page: "Device communications", summary: "The device's protocol ports and the links over them." },
};

export function buildDeviceContext({
  device,
  section,
}: {
  device: DeviceDetailView;
  section: DeviceSection;
}): LlmContextDocument {
  const f = device.factoryId;
  const meta = DEVICE_PAGES[section] ?? { page: "Device", summary: "A screen of the device." };
  const routeFor = (key: DeviceSection) =>
    key === "connections"
      ? routes.deviceConnections(f, device.id)
      : key === "parameters"
        ? routes.deviceParameters(f, device.id)
        : key === "registers"
          ? routes.deviceRegisters(f, device.id)
          : key === "communications"
            ? routes.deviceCommunications(f, device.id)
            : routes.device(f, device.id);
  const route = routeFor(section);
  const plcWires = device.wires.filter((wire) => wire.tagName);
  const plcs = [...new Map(device.registers.map((register) => [register.plcId, register.plcName])).entries()];

  const validation: LlmContextItem[] = [];
  if (device.wires.length === 0 && device.ports.length === 0)
    validation.push({ label: "Not connected to anything", href: routes.designer(f), tone: "warn" });
  if (device.runtimeStatus === "FAULTED")
    validation.push({ label: "The device is faulted", href: routes.events(f, { device: device.id }), tone: "fault" });
  if (device.programNote)
    validation.push({ label: "No program can be written for this model", detail: device.programNote, tone: "info" });
  if (section === "parameters" && device.parameters && !device.parameters.applied)
    validation.push({
      label: "Parameters are kept for the record only",
      detail: "The model is not simulated; the values drive nothing.",
      tone: "info",
    });

  const actions: LlmContextItem[] = [];
  if (section === "parameters" && device.parameters)
    actions.push({
      label: "Save parameters",
      detail: `${device.parameters.fields.length} fields; saving makes a new immutable version.${device.parameters.applied ? " Changes how the simulated device behaves." : ""}`,
      tone: device.parameters.applied ? "warn" : "info",
    });
  actions.push({
    label: "Change the wiring in the designer",
    href: routes.designer(f),
    detail: "Device screens are read-only projections.",
  });

  return createLlmContext(
    {
      page: meta.page,
      area: "devices",
      route,
      routePattern: routePattern(
        routeFor(section).replace(`/${device.id}`, "/deviceId").replace(`/${f}/`, "/factoryId/"),
      ),
      subject: `${device.name} (${device.factoryName})`,
      summary: meta.summary,
    },
    {
      context: [
        { label: "Factory", value: device.factoryName, href: routes.factory(f) },
        {
          label: "Model",
          value: `${device.manufacturer} ${device.modelName}`,
          href: routes.catalog({ model: device.modelId }),
          detail: `${device.categoryName} · ${device.simulatorType.toLowerCase()} simulation`,
        },
        {
          label: "Runtime state",
          value: runtimeStateLabel(device.runtimeStatus),
          tone: STATE_TONE[device.runtimeStatus],
        },
        { label: "Role", value: device.role ?? "none" },
        ...(device.location ? [{ label: "Location", value: device.location }] : []),
        {
          label: "Capabilities",
          value:
            device.capabilities.map((capability) => capability.toLowerCase().replace(/_/g, " ")).join(", ") || "none",
        },
        ...(section === "parameters" && device.parameters
          ? [{ label: "Parameter versions", value: String(device.parameters.versions.length) }]
          : []),
      ],
      objects: [
        ...device.wires.map((wire) => ({
          label: `Wire ${wire.from.name} → ${wire.to.name}`,
          value: wire.tagName
            ? `${wire.tagName}${wire.logicalAddress ? ` @ ${wire.logicalAddress}` : ""}`
            : wire.kind.toLowerCase(),
        })),
        ...device.registers.map((register) => ({
          label: `Tag ${register.tagName}`,
          value: `${register.plcName} · ${register.role.toLowerCase()} · ${register.dataType}${register.displayAddress ? ` · ${register.displayAddress}` : ""}`,
          detail: register.signal
            ? `carries ${register.signal}${register.unit ? ` (${register.unit})` : ""}`
            : undefined,
          href: routes.plcIoMapping(f, register.plcId),
        })),
        ...device.ports.map((port) => ({
          label: `Port ${port.name}`,
          value: `${port.physicalType} · ${port.protocols.join(", ") || "no protocol"} · up to ${port.maxConnections} links`,
        })),
        ...(section === "parameters" && device.parameters
          ? device.parameters.fields.map((field) => ({
              label: `Parameter ${field.key}`,
              value: String(device.parameters!.values[field.key] ?? "unset"),
            }))
          : []),
      ],
      relationships: [
        ...plcWires.map((wire) => ({
          label: `${wire.from.name} is wired to ${wire.to.name}`,
          detail: `tag ${wire.tagName}`,
        })),
        ...plcs.map(([plcId, plcName]) => ({
          label: `${device.name} is read and driven by ${plcName}`,
          href: routes.plc(f, plcId),
        })),
      ],
      capacity: device.ports.map((port) => ({
        label: `Port ${port.name}`,
        value: `up to ${port.maxConnections} connections`,
      })),
      validation: { items: validation },
      actions,
      constraints: [
        {
          label: "Screens follow the model's capabilities",
          detail: "A device has only the screens its catalog model supports (TASK-308).",
        },
        { label: "Wires are made in the designer only" },
        {
          label: "The PLC program drives the device",
          detail: "Its commands come from PLC logic through its tags; nothing here writes an output (ADR-0015).",
        },
      ],
      decisions:
        section === "parameters" && device.parameters?.applied
          ? [
              {
                label: "Which parameter values?",
                decision: {
                  kind: "parameters" as const,
                  confirm: "required" as const,
                  defaultChoice: "the model's defaults",
                  enforced: "Values are kept within each parameter's range.",
                },
                detail: "They change how the simulated device behaves; ask before saving.",
              },
            ]
          : [],
      navigation: [
        ...device.sections
          .filter((item) => item.key !== section)
          .map((item) => ({ label: item.label, href: routeFor(item.key) })),
        { label: "Designer", href: routes.designer(f), detail: "Wire or rewire the device." },
        { label: "Simulator", href: routes.simulator(f), detail: "The device's simulated behaviour and faults." },
        { label: "Events", href: routes.events(f, { device: device.id }) },
        { label: "Factory overview", href: routes.factory(f) },
        { label: "LLM Index", href: routes.llmIndex() },
      ],
    },
  );
}

// ---------------------------------------------------------------------------------------
// New PLC

export type NewPlcContextInput = {
  factory: FactoryView;
  architecture: "compact" | "modular";
  models: readonly PlcModelOption[];
  devices: readonly FactoryDeviceView[];
  suggestedName: string;
};

export function buildNewPlcContext({
  factory,
  architecture,
  models,
  devices,
  suggestedName,
}: NewPlcContextInput): LlmContextDocument {
  const f = factory.id;
  const other = architecture === "compact" ? "modular" : "compact";
  const existing = devices.filter((device) => device.architectureType !== null);

  return createLlmContext(
    {
      page: `New ${architecture} PLC`,
      area: "devices",
      route: routes.newDevice(f, architecture),
      routePattern: routePattern(routes.newDevice("factoryId", architecture)),
      subject: factory.name,
      summary:
        architecture === "compact"
          ? "Create a compact PLC from a catalog model: its built-in I/O comes with it. Then wire devices to it in the designer."
          : "Create a modular PLC from a catalog CPU model: its rack comes with it, and modules are installed on the hardware screen.",
    },
    {
      context: [
        { label: "Architecture", value: architecture, detail: `The ${other} form is a separate screen.` },
        { label: "Catalog models offered", value: String(models.length), tone: models.length === 0 ? "warn" : "info" },
        {
          label: "Suggested name",
          value: suggestedName,
          detail: "The next free numbered name; names are unique within the factory.",
        },
        { label: "PLCs in the factory", value: String(existing.length) },
      ],
      objects: models.map((model) => ({
        label: `${model.manufacturer} ${model.modelName}`,
        value: model.io,
        detail: `${model.family}${model.sku ? ` · ${model.sku}` : ""} · ${model.verificationStatus.toLowerCase()} · ${model.ports}`,
        href: routes.catalog({ model: model.id }),
      })),
      relationships: existing.map((plc) => ({
        label: `${plc.name} already exists`,
        value: `${plc.modelName} · ${runtimeStateLabel(plc.runtimeStatus)}`,
        href: routes.plc(f, plc.id),
      })),
      capacity: [
        {
          label: "Models by architecture",
          value: `${models.length} ${architecture}`,
          detail: `Switch to the ${other} form for the others.`,
        },
      ],
      validation: {
        items:
          models.length === 0
            ? [
                {
                  label: `The catalog has no ${architecture} PLC`,
                  detail: "Run npm run db:seed to load the catalog.",
                  tone: "warn",
                },
              ]
            : [],
      },
      actions: [
        {
          label: "Create PLC",
          detail:
            "Model, instance name and process role. The PLC is created with its I/O points (compact) or its rack (modular); nothing is started.",
        },
        { label: `Switch to ${other}`, href: routes.newDevice(f, other) },
        { label: "Cancel", href: routes.factory(f) },
      ],
      constraints: [
        {
          label: "PLC identity is manufacturer, family and exact model",
          detail: "The process role is separate metadata.",
        },
        {
          label: "A vendor model is a hardware profile",
          detail: "Its program runs on OpenPLC; no vendor firmware is emulated.",
        },
        { label: "The name must be unique within the factory", detail: "Letters, digits and dashes." },
      ],
      decisions: [
        {
          label: "Which model?",
          decision: {
            kind: "model" as const,
            confirm: "required" as const,
            enforced: "PLC identity is manufacturer, family and exact model; a vendor model runs on OpenPLC.",
          },
          detail:
            "Ask which vendor model (with sources) or generic model the user wants, and why: I/O count, ports, verification.",
        },
        {
          label: "Compact or modular?",
          decision: {
            kind: "architecture" as const,
            confirm: "required" as const,
            defaultChoice: "compact, when the plant needs only built-in I/O",
          },
          detail: "Compact for built-in I/O; modular when the plant needs modules chosen later.",
        },
        {
          label: "The process role",
          decision: {
            kind: "name" as const,
            confirm: "optional" as const,
            defaultChoice: "left empty; the role is metadata",
          },
          detail: "What the PLC controls, in the user's words.",
        },
      ],
      navigation: [
        {
          label: "Device catalog, PLCs",
          href: routes.catalog({ type: "PLC" }),
          detail: "Compare the models before choosing.",
        },
        { label: "Factory overview", href: routes.factory(f) },
        { label: "Designer", href: routes.designer(f), detail: "Wire devices to the PLC once it exists." },
        { label: "LLM Index", href: routes.llmIndex() },
      ],
    },
  );
}

// ---------------------------------------------------------------------------------------
// Catalog

export type CatalogContextInput = {
  overview: CatalogOverview;
  model: CatalogModelDetail | null;
  peripherals?: readonly PeripheralCompatibility[];
  type?: string;
};

export function buildCatalogContext({ overview, model, peripherals, type }: CatalogContextInput): LlmContextDocument {
  const category = overview.categories.find((candidate) => candidate.code === type);
  const compatible = (peripherals ?? []).filter(
    (peripheral) => peripheral.directIo?.compatible || peripheral.directIo === null,
  );

  return createLlmContext(
    {
      page: "Device catalog",
      area: "catalog",
      route: routes.catalog({ model: model?.id, type }),
      routePattern: routePattern(routes.catalog()),
      subject: model ? `${model.manufacturer} ${model.modelName}` : category ? category.name : "all models",
      summary:
        "The reusable models every factory device is created from, by manufacturer, family and category, with each model's documented facts, their sources, its 3D asset state and, for a PLC, the peripherals it can be wired to. The catalog is read here and used in the designer and the new-PLC form.",
    },
    {
      context: [
        {
          label: "Models",
          value: `${overview.totals.models} · ${overview.totals.manufacturers} manufacturers · ${overview.totals.verified} verified · ${overview.totals.generic} generic · ${overview.totals.withAsset} with a 3D asset`,
        },
        {
          label: "Category filter",
          value: category ? `${category.name} (${category.modelCount})` : "none",
          detail: "?type=<code>",
        },
        ...(model
          ? [
              {
                label: "Selected model",
                value: `${model.manufacturer} ${model.modelName}`,
                detail: `${model.family} · ${model.categoryName}${model.sku ? ` · ${model.sku}` : ""}`,
              },
              {
                label: "Verification",
                value: model.verificationStatus.toLowerCase(),
                detail: model.source.url
                  ? `source: ${model.source.title ?? model.source.url}${model.source.verifiedAt ? `, verified ${model.source.verifiedAt}` : ""}`
                  : "generic model: no vendor source",
                tone: model.verificationStatus === "VERIFIED" ? ("ok" as const) : ("info" as const),
              },
              {
                label: "Control",
                value: model.controlCapability.toLowerCase().replace(/_/g, " "),
                detail: `runtime support ${model.runtimeSupport.toLowerCase()} · ${model.lifecycleStatus.toLowerCase()}`,
              },
              {
                label: "3D asset",
                value: model.asset.state.toLowerCase(),
                tone: model.asset.state === "FAILED" ? ("warn" as const) : ("info" as const),
              },
              ...(model.builtInChannels.length > 0
                ? [
                    {
                      label: "Built-in I/O",
                      value: model.builtInChannels.map((channel) => `${channel.count} ${channel.ioType}`).join(" · "),
                    },
                  ]
                : []),
              ...(model.terminals.length > 0 ? [{ label: "Terminals", value: String(model.terminals.length) }] : []),
              ...(model.racks.length > 0
                ? [
                    {
                      label: "Rack",
                      value: model.racks.map((rack) => `${rack.name}: ${rack.slotCount} slots`).join("; "),
                    },
                  ]
                : []),
              ...(model.modules.length > 0
                ? [{ label: "Installable modules", value: String(model.modules.length) }]
                : []),
            ]
          : [{ label: "Selected model", value: "none" }]),
      ],
      objects: overview.categories.map((entry) => ({
        label: entry.name,
        value: `${entry.modelCount} models`,
        href: routes.catalog({ type: entry.code }),
        tone: entry.code === type ? "ok" : "info",
      })),
      relationships: (peripherals ?? []).slice(0, 30).map((peripheral) => ({
        label: `${peripheral.manufacturer} ${peripheral.modelName} ${peripheral.directIo === null ? "communicates with" : peripheral.directIo.compatible ? "can be wired to" : "cannot be fully wired to"} ${model?.modelName ?? "this PLC"}`,
        value: peripheral.directIo
          ? peripheral.directIo.terminals
              .map(
                (terminal) =>
                  `${terminal.terminalLabel ?? "?"}: ${terminal.required} ${terminal.satisfied ? "ok" : "missing"}`,
              )
              .join(", ")
          : `${peripheral.categoryName} · ${peripheral.controlCapability.toLowerCase().replace(/_/g, " ")}`,
        href: routes.catalog({ model: peripheral.modelId }),
        tone: peripheral.directIo === null || peripheral.directIo.compatible ? "info" : "warn",
      })),
      capacity: peripherals
        ? [{ label: "Compatible peripherals", value: `${compatible.length} of ${peripherals.length}` }]
        : [],
      validation: {
        items:
          model?.asset.state === "FAILED"
            ? [
                {
                  label: "The model's 3D asset generation failed",
                  detail: "The generic shape is drawn instead.",
                  tone: "warn",
                },
              ]
            : [],
      },
      actions: [
        { label: "Open a model", detail: "?model=<id>; the tree on the left lists them by manufacturer and family." },
        { label: "Narrow to a category", detail: "?type=<code>." },
        ...(model?.categoryCode === "PLC"
          ? [
              {
                label: "Create this PLC in a factory",
                detail: `From a factory's overview: Add ${model.architectureType?.toLowerCase() ?? "compact"} PLC.`,
              },
            ]
          : []),
      ],
      constraints: [
        {
          label: "Vendor facts are never invented",
          detail:
            "Every vendor model carries its source and verification; what is not documented is not shown (docs/rules.md 27).",
        },
        {
          label: "A catalog model is not a factory device",
          detail: "Devices are created from models in the designer and the new-PLC form.",
        },
        {
          label: "A vendor PLC runs on OpenPLC",
          detail: "Its catalog record is a hardware profile, not a firmware emulator.",
        },
      ],
      decisions: [
        {
          label: "Vendor or generic?",
          decision: {
            kind: "model" as const,
            confirm: "required" as const,
            enforced: "Vendor facts come with sources and are never invented.",
          },
          detail:
            "A vendor model brings documented I/O and sources; a generic one is simulated with documented behaviour. The user chooses.",
        },
      ],
      navigation: [
        { label: "Factories", href: routes.factories(), detail: "Use a model in a factory." },
        { label: "LLM Index", href: routes.llmIndex() },
      ],
    },
  );
}

// ---------------------------------------------------------------------------------------
// Factories list

export function buildFactoriesContext({
  factories,
  docker,
}: {
  factories: readonly FactoryView[];
  docker: { reachable: boolean; version?: string };
}): LlmContextDocument {
  const running = factories.filter((factory) => factory.runtimeStatus === "RUNNING");
  const troubled = factories.filter(
    (factory) => factory.runtimeStatus === "DEGRADED" || factory.runtimeStatus === "FAULTED",
  );

  return createLlmContext(
    {
      page: "Factories",
      area: "factories",
      route: routes.factories(),
      routePattern: routePattern(routes.factories()),
      subject: "workspace",
      summary:
        factories.length === 0
          ? "The entry point, on its first run: no factory exists yet. Create one, build the pump station demo, or read the catalog."
          : "The entry point: every factory of the workspace with its devices, subnet, PLCs, state and last event. Open one to work on it, or create a new one.",
    },
    {
      context: [
        {
          label: "Factories",
          value: `${factories.length} · ${running.length} running · ${troubled.length} degraded or faulted`,
          tone: troubled.length > 0 ? "warn" : "info",
        },
        {
          label: "Docker Engine",
          value: docker.reachable ? (docker.version ?? "reachable") : "unreachable",
          detail: "Needed to run a factory, not to design one.",
          tone: docker.reachable ? "ok" : "fault",
        },
      ],
      objects: factories.map((factory) => ({
        label: factory.name,
        value: `${factory.deviceCount} devices · ${factory.plcCount} PLCs · ${factory.subnetCidr} · ${runtimeStateLabel(factory.runtimeStatus)}`,
        href: routes.factory(factory.id),
        detail: factory.lastEvent
          ? `last event ${factory.lastEvent.type} at ${factory.lastEvent.occurredAt}`
          : "no events yet",
        tone: STATE_TONE[factory.runtimeStatus],
      })),
      relationships: [
        {
          label: "Each factory has its own isolated Docker network",
          detail: "Subnets never overlap, among factories or with other networks on the host.",
        },
      ],
      capacity: [
        {
          label: "Subnets",
          value: factories.map((factory) => factory.subnetCidr).join(", ") || "none used",
          detail: "The create form suggests the next free /24 in 172.20.0.0/16.",
        },
      ],
      validation: {
        items: [
          ...(!docker.reachable
            ? [
                {
                  label: "Docker Engine unreachable",
                  detail: "Factories can be designed but not started.",
                  tone: "fault" as const,
                },
              ]
            : []),
          ...troubled.map((factory) => ({
            label: `${factory.name} is ${runtimeStateLabel(factory.runtimeStatus).toLowerCase()}`,
            href: routes.runtime(factory.id),
            tone: STATE_TONE[factory.runtimeStatus],
          })),
        ],
      },
      actions: [
        {
          label: "New factory",
          href: routes.newFactory(),
          detail: "Name, slug, description and subnet; the form suggests a free subnet.",
        },
        {
          label: "Create pump station demo",
          href: routes.newFactory(),
          detail:
            "A complete plant from catalog models: PLC, drive, motor, pump, sensor, gateway, wiring and program. Nothing is started.",
        },
        { label: "Open a factory", detail: "Its overview, then every screen of it." },
      ],
      constraints: [
        {
          label: "A factory's subnet must be free",
          detail: "Among the factories and on the Docker host; the form refuses an overlap.",
        },
        {
          label: "Creating a factory starts nothing",
          detail: "Containers and the network are created on its first start.",
        },
      ],
      decisions: [
        {
          label: "Which factory, or a new one?",
          decision: {
            kind: "name" as const,
            confirm: "required" as const,
            defaultChoice: "the suggested free subnet",
            enforced: "A subnet must not overlap another factory or a network on the Docker host.",
          },
          detail:
            "Ask before creating; a new factory needs a name and, when the suggested subnet is not wanted, a subnet.",
        },
      ],
      navigation: [
        { label: "Device catalog", href: routes.catalog() },
        { label: "LLM Index", href: routes.llmIndex() },
      ],
    },
  );
}
