import { createLlmContext, type LlmContextDocument, type LlmContextItem } from "@/lib/agent/llm-context";
import { routePattern } from "@/lib/agent/llm-index";
import type { DeviceTreeNode } from "@/lib/domain/device-tree";
import type { FactoryDeviceView } from "@/lib/domain/plc-config-view";
import { runtimeStateLabel } from "@/lib/domain/runtime-state";
import { routes } from "@/lib/navigation/routes";
import type { FactoryView } from "@/lib/services/factory-service";
import type { FactoryPlcSummary } from "@/lib/services/plc-config-service";

export type FactoryOverviewContextInput = {
  factory: FactoryView;
  /** The devices as the page shows them: PLCs first, each with what is connected to it. */
  devices: readonly DeviceTreeNode<FactoryDeviceView>[];
  plcs: readonly FactoryPlcSummary[];
  docker: { reachable: boolean; version?: string };
};

const STATE_TONE: Record<FactoryDeviceView["runtimeStatus"], LlmContextItem["tone"]> = {
  STOPPED: "info",
  STARTING: "info",
  RUNNING: "ok",
  STOPPING: "info",
  DEGRADED: "warn",
  FAULTED: "fault",
  DISCONNECTED: "warn",
};

const isPlc = (device: FactoryDeviceView) => device.architectureType !== null;

const deviceHref = (factoryId: string, device: FactoryDeviceView) =>
  isPlc(device) ? routes.plc(factoryId, device.id) : routes.device(factoryId, device.id);

/** The LLM Context of the factory overview (`/factories/[factoryId]`), from what the page renders. */
export function buildFactoryOverviewContext({
  factory,
  devices,
  plcs,
  docker,
}: FactoryOverviewContextInput): LlmContextDocument {
  const stopped = factory.runtimeStatus === "STOPPED";
  const flat: Array<{ device: FactoryDeviceView; parent: FactoryDeviceView | null }> = [];
  const walk = (nodes: readonly DeviceTreeNode<FactoryDeviceView>[], parent: FactoryDeviceView | null) => {
    for (const node of nodes) {
      flat.push({ device: node.device, parent });
      walk(node.children, node.device);
    }
  };
  walk(devices, null);
  const peripherals = flat.filter(({ device }) => !isPlc(device));
  const faulted = flat.filter(({ device }) => device.runtimeStatus === "FAULTED");
  const unprogrammed = plcs.filter((plc) => !plc.programSelected);

  const objects: LlmContextItem[] = flat.map(({ device }) => ({
    label: device.name,
    value: `${device.categoryName} · ${device.modelName}`,
    href: deviceHref(factory.id, device),
    detail: [device.role, runtimeStateLabel(device.runtimeStatus)].filter(Boolean).join(" · "),
    tone: STATE_TONE[device.runtimeStatus],
  }));

  const relationships: LlmContextItem[] = flat.map(({ device, parent }) =>
    parent
      ? {
          label: `${device.name} is connected to ${parent.name}`,
          href: isPlc(parent)
            ? routes.plcConnections(factory.id, parent.id)
            : routes.deviceConnections(factory.id, parent.id),
        }
      : {
          label: isPlc(device) ? `${device.name} is a PLC root` : `${device.name} is connected to nothing`,
          detail: isPlc(device) ? undefined : "Wire it in the designer, or it takes no part in the plant.",
          tone: isPlc(device) ? "info" : "warn",
        },
  );

  const capacity: LlmContextItem[] =
    plcs.length > 0
      ? plcs.map((plc) => ({
          label: plc.name,
          value: `${plc.occupancy.occupied}/${plc.occupancy.total} channels used, ${plc.occupancy.total - plc.occupancy.occupied} free`,
          href: routes.plcHardware(factory.id, plc.id),
          detail: `${plc.architectureType.toLowerCase()} PLC · I/O mapping v${plc.ioMappingVersion}`,
          tone: plc.occupancy.total > 0 && plc.occupancy.occupied === plc.occupancy.total ? "warn" : "info",
        }))
      : [{ label: "No PLC", detail: "There are no channels to wire to until a PLC exists.", tone: "warn" }];

  const validation: LlmContextItem[] = [];
  if (!docker.reachable)
    validation.push({
      label: "Docker Engine unreachable",
      detail: "Nothing can be started until it is.",
      tone: "fault",
    });
  if (plcs.length === 0)
    validation.push({ label: "No PLC", detail: "A factory without a PLC cannot start.", tone: "warn" });
  if (factory.runtimeStatus === "DEGRADED")
    validation.push({
      label: "Factory is degraded",
      detail: "Some PLC is faulted, degraded or disconnected; see the Runtime page.",
      href: routes.runtime(factory.id),
      tone: "warn",
    });
  for (const { device } of faulted)
    validation.push({
      label: `${device.name} is faulted`,
      href: routes.events(factory.id, { device: device.id }),
      tone: "fault",
    });
  for (const plc of unprogrammed)
    validation.push({
      label: `${plc.name} has no program selected`,
      href: routes.plcProgram(factory.id, plc.id),
      detail: "It starts with nothing to run until a version is saved.",
      tone: "warn",
    });
  for (const { device } of peripherals.filter(({ parent }) => parent === null))
    validation.push({ label: `${device.name} is not connected`, href: routes.designer(factory.id), tone: "warn" });

  const actions: LlmContextItem[] = [
    {
      label: "Edit factory",
      href: routes.editFactory(factory.id),
      detail: "Name and description; the subnet only while stopped.",
    },
    {
      label: "Delete factory",
      detail: stopped
        ? "Asks for confirmation. Removes the factory, its devices, programs, history and Docker resources."
        : "Not available: stop the factory first.",
      tone: stopped ? "warn" : "info",
    },
    { label: "Open designer", href: routes.designer(factory.id), detail: "Add devices and wire them." },
    { label: "Add compact PLC", href: routes.newDevice(factory.id, "compact") },
    { label: "Add modular PLC", href: routes.newDevice(factory.id, "modular") },
    {
      label: stopped ? "Start factory" : "Stop factory",
      href: routes.runtime(factory.id),
      detail: "On the Runtime page. Ask the user before changing what runs.",
    },
  ];

  const constraints: LlmContextItem[] = [
    {
      label: "Nothing on this page starts Docker",
      detail: "A PLC is started from Runtime, the simulation from the Simulator.",
    },
    { label: "Editing the subnet and deleting need a stopped factory" },
    { label: "Device names are unique within the factory" },
    { label: "One isolated Docker network per factory", value: factory.subnetCidr },
    {
      label: "The PLC program is the control authority",
      detail: "Nothing outside it sets a physical output (ADR-0015).",
    },
  ];

  const decisions: LlmContextItem[] = [];
  if (plcs.length === 0)
    decisions.push({
      label: "Which PLC?",
      detail: "Ask for the architecture (compact or modular) and the catalog model before creating one.",
      href: routes.catalog({ type: "PLC" }),
    });
  if (peripherals.length === 0)
    decisions.push({
      label: "What should the plant do?",
      detail: "Ask which process and which field devices (sensors, drives, motors, pumps, valves) before adding any.",
    });
  for (const plc of unprogrammed)
    decisions.push({
      label: `Control logic for ${plc.name}`,
      detail: "Ask for the control strategy, setpoints and interlocks before writing a program.",
      href: routes.plcProgram(factory.id, plc.id),
    });
  if (!stopped)
    decisions.push({
      label: "The factory is running",
      detail: "Ask before any change that stops it, rewires it or writes to it.",
    });

  const firstPlc = plcs[0];
  const navigation: LlmContextItem[] = [
    { label: "Designer", href: routes.designer(factory.id), detail: "Add and wire devices." },
    { label: "Runtime", href: routes.runtime(factory.id), detail: "Start and stop; each PLC's real state." },
    {
      label: "Simulator",
      href: routes.simulator(factory.id),
      detail: "Faults and test inputs for the simulated field.",
    },
    { label: "Live tags", href: routes.tags(factory.id), detail: "Values the PLCs read and drive." },
    { label: "Events", href: routes.events(factory.id), detail: "Why something happened." },
    {
      label: "Gateways",
      href: routes.gateways(factory.id),
      detail: "External edge access to command and feedback tags.",
    },
    { label: "Process modules", href: routes.modules(factory.id), detail: "Process behaviour composed from devices." },
    { label: "3D view", href: routes.view3d(factory.id) },
    ...(firstPlc
      ? [
          {
            label: `Export ${firstPlc.name}`,
            href: routes.plcExport(factory.id, firstPlc.id),
            detail: "The PLC's engineering snapshot.",
          },
        ]
      : []),
    { label: "LLM Index", href: routes.llmIndex(), detail: "The whole application, its areas and the rules." },
  ];

  return createLlmContext(
    {
      page: "Factory overview",
      area: "factory",
      route: routes.factory(factory.id),
      routePattern: routePattern(routes.factory("factoryId")),
      subject: factory.name,
      summary:
        "One factory: its devices as they are connected, its stored runtime state and settings, and the way into every other screen of the factory. This is desired configuration; the Runtime page runs it.",
    },
    {
      context: [
        {
          label: "Runtime state",
          value: runtimeStateLabel(factory.runtimeStatus),
          tone: STATE_TONE[factory.runtimeStatus],
        },
        { label: "Configuration", value: factory.status.toLowerCase() },
        { label: "Subnet", value: factory.subnetCidr },
        { label: "Docker network", value: factory.dockerNetworkName, detail: "Created when the factory first starts." },
        { label: "Devices", value: `${flat.length} devices · ${plcs.length} PLCs` },
        {
          label: "Last event",
          value: factory.lastEvent ? `${factory.lastEvent.type} · ${factory.lastEvent.occurredAt}` : "none",
          href: routes.events(factory.id),
        },
        {
          label: "Docker Engine",
          value: docker.reachable ? (docker.version ?? "reachable") : "unreachable",
          tone: docker.reachable ? "ok" : "fault",
        },
      ],
      objects,
      relationships,
      capacity,
      validation: { items: validation },
      actions,
      constraints,
      decisions,
      navigation,
    },
  );
}
