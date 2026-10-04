import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ScenePlaceholder } from "@/components/canvas/scene-placeholder";
import { AppShell } from "@/components/shell/app-shell";
import { EditorTabs } from "@/components/shell/editor";
import { SideBar, SideSection, Tree } from "@/components/shell/side-bar";
import { Button } from "@/components/ui/button";
import { KeyValue } from "@/components/ui/primitives";
import { RuntimeStatePill, StatePill } from "@/components/ui/state-pill";
import { demoContext, isDemoFactory } from "@/lib/fixtures";
import { devices, factory, scene } from "@/lib/fixtures/pump-house-demo";
import { routes } from "@/lib/navigation/routes";

export const metadata: Metadata = { title: "3D view" };

type View3dPageProps = {
  params: Promise<{ factoryId: string }>;
};

const monoRows = (rows: ReadonlyArray<readonly [string, string]>) =>
  rows.map(
    ([label, value]) =>
      [
        label,
        <span key="v" className="mono">
          {value}
        </span>,
      ] as const,
  );

/** 2q — 3D Factory View. Visualization only; it never owns device state. */
export default async function View3dPage({ params }: View3dPageProps) {
  const { factoryId } = await params;
  if (!isDemoFactory(factoryId)) notFound();

  return (
    <AppShell
      title={`3D — ${factory.name}`}
      command="visualization · not the authoritative model"
      titleState={<RuntimeStatePill state={scene.state} />}
      activity="designer"
      context={demoContext}
      sidebar={
        <SideBar title="Scene" className="w-50">
          <Tree
            items={devices.map((device) => ({
              label: device.external ? `${device.name} (ext)` : device.name,
              active: device.name === scene.selected,
            }))}
          />
          <SideSection title="Camera">
            <div className="zf-chips">
              {scene.cameras.map((camera) => (
                <StatePill key={camera.label} tone={camera.active ? "start" : "off"}>
                  {camera.label}
                </StatePill>
              ))}
            </div>
          </SideSection>
          <SideSection title={scene.selected}>
            <KeyValue
              rows={[["State", <RuntimeStatePill key="v" state="RUNNING" />], ...monoRows(scene.selectedRows)]}
            />
          </SideSection>
          <SideSection title="Render">
            <KeyValue rows={monoRows(scene.render)} />
          </SideSection>
        </SideBar>
      }
      status={{ left: ["3D · orbit", "60 fps"], right: ["tag sync 250 ms"] }}
    >
      <EditorTabs
        tabs={[
          { label: "Designer", href: routes.designer(factoryId) },
          { label: "Topology", href: routes.topology(factoryId) },
          { label: "3D", active: true },
        ]}
        crumb="three.js · react-three-fiber"
      />
      <div className="zf-scene">
        <ScenePlaceholder />
        <div className="zf-box zf-scene-note">R3F canvas · primitive meshes · emissive state colour from runtime</div>
        <div className="zf-k absolute bottom-2.5 left-2.5 flex gap-3">
          <span className="text-ok">▣ running</span>
          <span className="text-warn-fg">▣ degraded</span>
          <span className="text-fault-fg">▣ faulted</span>
          <span>▢ stopped</span>
          <span className="text-ext">- - external</span>
        </div>
        <div className="absolute bottom-2.5 right-2.5 flex gap-1">
          <Button size="sm" variant="ghost">
            −
          </Button>
          <Button size="sm" variant="ghost">
            +
          </Button>
          <Button size="sm" variant="ghost">
            reset
          </Button>
          <Button size="sm" variant="ghost">
            labels
          </Button>
        </div>
      </div>
    </AppShell>
  );
}
