import type { ReactNode } from "react";
import type { LlmContextDocument } from "@/lib/agent/llm-context";
import { LlmContextPanel } from "@/components/agent/llm-context";
import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs } from "@/components/shell/editor";
import { SideBar, SideSection, Tree, type TreeNode } from "@/components/shell/side-bar";
import { KeyValue } from "@/components/ui/primitives";
import { RuntimeStatePill, runtimeStateTone } from "@/components/ui/state-pill";
import { DEVICE_CAPABILITY_LABELS, type DeviceSection } from "@/lib/domain/device-capabilities";
import { routes } from "@/lib/navigation/routes";
import type { DeviceDetailView } from "@/lib/domain/device-detail-view";

type DeviceShellProps = {
  device: DeviceDetailView;
  section: DeviceSection;
  /** The screen's LLM Context (TASK-1003), rendered after its content. */
  llmContext?: LlmContextDocument;
  children: ReactNode;
};

/** Status bar colour for the device's runtime state: red for a fault, amber for degraded, grey when stopped. */
const STATUS_TONE: Partial<Record<string, "ok" | "flt" | "deg" | "off">> = { flt: "flt", deg: "deg", off: "off" };

/** The route of each screen a device can have. Screens of the factory are linked where a device has no own. */
function sectionHref(device: DeviceDetailView, section: DeviceSection): string | undefined {
  const { factoryId, id } = device;
  switch (section) {
    case "overview":
      return routes.device(factoryId, id);
    case "connections":
      return routes.deviceConnections(factoryId, id);
    case "parameters":
      return routes.deviceParameters(factoryId, id);
    case "registers":
      return routes.deviceRegisters(factoryId, id);
    case "communications":
      return routes.deviceCommunications(factoryId, id);
    case "runtime":
      return routes.simulator(factoryId);
    default:
      return undefined;
  }
}

/**
 * The section list of a device, from its model's capabilities: a screen the model has no
 * capability for is not listed, not greyed out. Program and Versions of a programmable
 * model without an adapter are listed with the reason they are empty.
 */
function sections(device: DeviceDetailView, active: DeviceSection): TreeNode[] {
  const items: TreeNode[] = device.sections.map(({ key, label }) => {
    const href = sectionHref(device, key);
    if ((key === "program" || key === "versions") && device.programNote) {
      return { label, meta: "no adapter", muted: true };
    }
    return {
      label,
      href,
      active: key === active,
      meta: key === "runtime" ? "factory" : key === "connections" ? String(device.wires.length) : undefined,
    };
  });
  return [
    ...items,
    { label: "Live Tags", meta: "factory", href: routes.tags(device.factoryId, device.id) },
    { label: "Events", meta: "factory", href: routes.events(device.factoryId, { device: device.id }) },
  ];
}

/** Shell shared by the screens of a device that is not a controller: sections, identity and tabs. */
export function DeviceShell({ device, section, llmContext, children }: DeviceShellProps) {
  const label = device.sections.find((item) => item.key === section)?.label ?? section;
  return (
    <AppShell
      title={`${device.factoryName} — Z-FACTORY`}
      titleState={<RuntimeStatePill state={device.runtimeStatus} />}
      activity="factories"
      sidebar={
        <SideBar title={device.name}>
          <SideSection title="Device">
            <Tree items={sections(device, section)} />
          </SideSection>
          <SideSection title="Instance">
            <KeyValue
              rows={[
                ["Role", device.role ?? "—"],
                ["Type", device.categoryName],
                ["Model", `${device.manufacturer} ${device.modelName}`],
                [
                  "Capabilities",
                  device.capabilities.length > 0
                    ? device.capabilities.map((capability) => DEVICE_CAPABILITY_LABELS[capability]).join(", ")
                    : "none declared",
                ],
              ]}
            />
          </SideSection>
        </SideBar>
      }
      status={{
        tone: STATUS_TONE[runtimeStateTone(device.runtimeStatus)] ?? "ok",
        left: [device.name, label.toLowerCase()],
        right: [`${device.wires.length} wires`, device.modelName],
      }}
    >
      <EditorTabs
        tabs={[
          { label: device.factoryName, href: routes.factory(device.factoryId) },
          { label: device.name, active: true },
        ]}
        crumb={`${device.factoryName.toLowerCase()} › ${device.name.toLowerCase()} › ${label.toLowerCase()}`}
      />
      <Content plain>
        {children}
        {llmContext ? <LlmContextPanel document={llmContext} /> : null}
      </Content>
    </AppShell>
  );
}
