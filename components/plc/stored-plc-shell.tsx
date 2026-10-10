import type { ReactNode } from "react";
import { LlmContextPanel } from "@/components/agent/llm-context";
import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs } from "@/components/shell/editor";
import { SideBar, SideSection, Tree, type TreeNode } from "@/components/shell/side-bar";
import { KeyValue } from "@/components/ui/primitives";
import { RuntimeStatePill, runtimeStateTone } from "@/components/ui/state-pill";
import type { LlmContextDocument } from "@/lib/agent/llm-context";
import { DEVICE_CAPABILITY_LABELS, hasCapability } from "@/lib/domain/device-capabilities";
import type { PlcConfigurationView } from "@/lib/domain/plc-config-view";
import { routes } from "@/lib/navigation/routes";

export type StoredPlcSection =
  | "overview"
  | "hardware"
  | "connections"
  | "communication"
  | "program"
  | "io-mapping"
  | "versions"
  | "runtime"
  | "export";

type StoredPlcShellProps = {
  factory: { id: string; name: string };
  view: PlcConfigurationView;
  section: StoredPlcSection;
  /** The screen's LLM Context (TASK-1003), rendered after its content. */
  llmContext?: LlmContextDocument;
  children: ReactNode;
};

const SECTION_LABELS: Record<StoredPlcSection, string> = {
  overview: "Overview",
  hardware: "Hardware / Pinout",
  connections: "Connections",
  communication: "Communication",
  program: "Program",
  "io-mapping": "I/O Mapping",
  versions: "Versions",
  runtime: "Runtime",
  export: "Export",
};

/** Status bar colour for the PLC's runtime state: red for a fault, amber for degraded, grey when stopped. */
const STATUS_TONE: Partial<Record<string, "ok" | "flt" | "deg" | "off">> = { flt: "flt", deg: "deg", off: "off" };

/**
 * The PLC's own screens (docs/design.md → PLC edit). Every entry is a screen that exists:
 * since TASK-1005 nothing is listed that cannot be opened (Logs, which has no screen, is gone).
 */
export function plcSections(view: PlcConfigurationView, active: StoredPlcSection): TreeNode[] {
  const { factoryId, id } = view.plc;
  const modular = view.plc.architectureType === "MODULAR";
  const programmable = hasCapability(view.model, "PROGRAMMABLE");
  const installed = view.rack?.slots.filter((slot) => slot.module).length ?? 0;
  return [
    { label: SECTION_LABELS.overview, href: routes.plc(factoryId, id), active: active === "overview" },
    {
      label: modular ? "Hardware · Rack & Modules" : SECTION_LABELS.hardware,
      meta: modular ? `${installed} modules` : "compact",
      href: routes.plcHardware(factoryId, id),
      active: active === "hardware",
    },
    {
      label: SECTION_LABELS.connections,
      meta: String(view.peripherals.length),
      href: routes.plcConnections(factoryId, id),
      active: active === "connections",
    },
    // Links to other PLCs of the factory (Phase 07).
    {
      label: SECTION_LABELS.communication,
      href: routes.plcCommunication(factoryId, id),
      active: active === "communication",
    },
    // Program and Versions exist for a programmable model only; every controller model is one today.
    ...(programmable
      ? [{ label: SECTION_LABELS.program, href: routes.plcProgram(factoryId, id), active: active === "program" }]
      : []),
    {
      label: SECTION_LABELS["io-mapping"],
      meta: `v${view.plc.ioMappingVersion}`,
      href: routes.plcIoMapping(factoryId, id),
      active: active === "io-mapping",
    },
    ...(programmable
      ? [{ label: SECTION_LABELS.versions, href: routes.plcVersions(factoryId, id), active: active === "versions" }]
      : []),
    { label: SECTION_LABELS.runtime, href: routes.plcRuntime(factoryId, id), active: active === "runtime" },
    { label: SECTION_LABELS.export, href: routes.plcExport(factoryId, id), active: active === "export" },
  ];
}

/** The factory's screens this PLC takes part in, narrowed to it where they can be. */
export function factorySections(view: PlcConfigurationView): TreeNode[] {
  const { factoryId, id } = view.plc;
  return [
    // The device simulation belongs to the factory, not to one PLC.
    { label: "Simulator", href: routes.simulator(factoryId) },
    { label: "Live Tags", meta: "this PLC", href: routes.tags(factoryId, id) },
    { label: "Events", meta: "this PLC", href: routes.events(factoryId, { device: id }) },
  ];
}

/** Shell shared by the screens of a stored PLC: section list, identity and tabs. */
export function StoredPlcShell({ factory, view, section, llmContext, children }: StoredPlcShellProps) {
  const { plc, model, occupancy } = view;
  return (
    <AppShell
      title={`${factory.name} — Z-FACTORY`}
      titleState={<RuntimeStatePill state={plc.runtimeStatus} />}
      activity="factories"
      sidebar={
        <SideBar title={plc.name}>
          <SideSection title={model.categoryCode === "RTU" ? "RTU" : "PLC"}>
            <Tree items={plcSections(view, section)} />
          </SideSection>
          <SideSection title="Factory">
            <Tree items={factorySections(view)} />
          </SideSection>
          <SideSection title="Instance">
            <KeyValue
              rows={[
                ["Role", plc.role ?? "—"],
                ["Model", model.modelName],
                ["Architecture", plc.architectureType.toLowerCase()],
                [
                  "Runtime",
                  <span key="v" className="syn-type">
                    {model.runtimeSupport === "OPENPLC" ? "OpenPLC" : "none"}
                  </span>,
                ],
                [
                  "Capabilities",
                  model.capabilities.map((capability) => DEVICE_CAPABILITY_LABELS[capability]).join(", "),
                ],
              ]}
            />
          </SideSection>
        </SideBar>
      }
      status={{
        tone: STATUS_TONE[runtimeStateTone(plc.runtimeStatus)] ?? "ok",
        left: [plc.name, SECTION_LABELS[section].toLowerCase()],
        right: [
          `${occupancy.occupied}/${occupancy.total} channels used`,
          `${plc.architectureType.toLowerCase()} · ${model.modelName}`,
        ],
      }}
    >
      <EditorTabs
        tabs={[
          { label: factory.name, href: routes.factory(factory.id) },
          { label: plc.name, active: true },
        ]}
        crumb={`${factory.name.toLowerCase()} › ${plc.name.toLowerCase()} › ${SECTION_LABELS[section].toLowerCase()}`}
      />
      <Content plain>
        {children}
        {llmContext ? <LlmContextPanel document={llmContext} /> : null}
      </Content>
    </AppShell>
  );
}
