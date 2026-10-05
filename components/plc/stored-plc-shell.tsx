import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs } from "@/components/shell/editor";
import { SideBar, SideSection, Tree, type TreeNode } from "@/components/shell/side-bar";
import { KeyValue } from "@/components/ui/primitives";
import { RuntimeStatePill } from "@/components/ui/state-pill";
import type { PlcConfigurationView } from "@/lib/domain/plc-config-view";
import { routes } from "@/lib/navigation/routes";

export type StoredPlcSection = "overview" | "hardware" | "connections" | "io-mapping";

type StoredPlcShellProps = {
  factory: { id: string; name: string };
  view: PlcConfigurationView;
  section: StoredPlcSection;
  children: ReactNode;
};

const SECTION_LABELS: Record<StoredPlcSection, string> = {
  overview: "Overview",
  hardware: "Hardware / Pinout",
  connections: "Connections",
  "io-mapping": "I/O Mapping",
};

/** Sections of the PLC edit view (docs/design.md → PLC edit). Those without a screen for stored PLCs yet are listed, not linked. */
function sections(view: PlcConfigurationView, active: StoredPlcSection): TreeNode[] {
  const { factoryId, id } = view.plc;
  const modular = view.plc.architectureType === "MODULAR";
  const installed = view.rack?.slots.filter((slot) => slot.module).length ?? 0;
  const pending = (label: string): TreeNode => ({ label, meta: "not wired yet", muted: true });
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
    pending("Program"),
    {
      label: SECTION_LABELS["io-mapping"],
      meta: `v${view.plc.ioMappingVersion}`,
      href: routes.plcIoMapping(factoryId, id),
      active: active === "io-mapping",
    },
    pending("Simulator"),
    pending("Live Tags"),
    pending("Events"),
    pending("Logs"),
    pending("Versions"),
    pending("Runtime"),
    pending("Export"),
  ];
}

/** Shell shared by the screens of a stored PLC: section list, identity and tabs. */
export function StoredPlcShell({ factory, view, section, children }: StoredPlcShellProps) {
  const { plc, model, occupancy } = view;
  return (
    <AppShell
      title={`${factory.name} — Z-FACTORY`}
      titleState={<RuntimeStatePill state={plc.runtimeStatus} />}
      activity="factories"
      sidebar={
        <SideBar title={plc.name}>
          <SideSection title="PLC">
            <Tree items={sections(view, section)} />
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
                    OpenPLC
                  </span>,
                ],
              ]}
            />
          </SideSection>
        </SideBar>
      }
      status={{
        tone: plc.runtimeStatus === "STOPPED" ? "off" : "ok",
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
      <Content plain>{children}</Content>
    </AppShell>
  );
}
