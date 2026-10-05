import type { Metadata } from "next";
import { Stage } from "@/components/canvas/stage";
import { AppShell } from "@/components/shell/app-shell";
import { EditorTabs, Toolbar } from "@/components/shell/editor";
import { SideBar, SideSection, Tree } from "@/components/shell/side-bar";
import { Button } from "@/components/ui/button";
import { KeyValue } from "@/components/ui/primitives";
import { RuntimeStatePill } from "@/components/ui/state-pill";
import { demoContext, isDemoFactory } from "@/lib/fixtures";
import { designer, devices, factory, paletteGroups, plc } from "@/lib/fixtures/pump-house-demo";
import { routes } from "@/lib/navigation/routes";
import { StoredCanvas } from "./stored-designer";

export const metadata: Metadata = { title: "Designer" };

// Stored factories read the database on every request.
export const dynamic = "force-dynamic";

type DesignerPageProps = {
  params: Promise<{ factoryId: string }>;
};

/** 2d — Factory Designer: palette · canvas · inspector. */
export default async function DesignerPage({ params }: DesignerPageProps) {
  const { factoryId } = await params;
  // Stored factories render from the database; the demo factory keeps its fixture screen.
  if (!isDemoFactory(factoryId)) return StoredCanvas({ factoryId, mode: "designer" });

  const plcHref = routes.plc(factoryId, plc.id);

  return (
    <AppShell
      title={`${factory.name} — Z-FACTORY`}
      command="⌘K"
      titleState={<RuntimeStatePill state={designer.state} />}
      activity="designer"
      context={demoContext}
      sidebar={
        <SideBar title="Palette">
          {paletteGroups.map((group) => (
            <SideSection key={group.title} title={group.title}>
              <Tree items={group.items.map((item) => ({ label: `▢ ${item}` }))} />
            </SideSection>
          ))}
        </SideBar>
      }
      status={{
        left: [
          `⎇ ${factory.slug}`,
          "designer",
          `${devices.length} devices · ${designer.validation.errors} errors · ${designer.validation.warnings} warning`,
        ],
        right: [designer.scan, "SSE"],
      }}
    >
      <EditorTabs
        tabs={[
          { label: "Designer", active: true },
          { label: `PLC · ${plc.name}`, href: plcHref },
          { label: "Topology", href: routes.topology(factoryId) },
          { label: "3D", href: routes.view3d(factoryId) },
        ]}
        crumb={`${factory.slug} › designer`}
      />
      <Toolbar summary={`● unsaved · ${devices.length} devices · ${designer.edges.length} links`}>
        <Button size="sm" variant="ghost">
          Validate
        </Button>
        <Button size="sm">Save</Button>
        <Button size="sm" variant="primary">
          Start factory
        </Button>
        <Button size="sm" variant="ghost" disabled>
          Stop
        </Button>
        <Button size="sm" variant="ghost" href={routes.plcExport(factoryId, plc.id)}>
          Export
        </Button>
      </Toolbar>
      <div className="flex min-h-0 flex-1">
        <Stage
          width={designer.stage.width}
          height={designer.stage.height}
          label="Factory canvas"
          nodes={designer.nodes}
          edges={designer.edges}
        >
          <div className="zf-stage-overlay zf-k left-2.5 gap-3">
            <span className="text-ok">— signal ok</span>
            <span>- - network</span>
            <span className="text-info">· · feedback</span>
          </div>
          <div className="zf-stage-overlay right-2.5">
            <Button size="sm" variant="ghost">
              −
            </Button>
            <Button size="sm" variant="ghost">
              +
            </Button>
            <Button size="sm" variant="ghost">
              fit
            </Button>
          </div>
        </Stage>
        <SideBar title="Inspector" edge="left" className="w-62.5">
          <KeyValue
            rows={[
              [
                "Instance",
                <span key="v" className="mono text-fg-strong">
                  {plc.name}
                </span>,
              ],
              ["Role", plc.role],
              ["Profile", plc.profile],
              [
                "Runtime",
                <span key="v" className="syn-type">
                  {plc.runtime}
                </span>,
              ],
              ["Arch", "Compact"],
              ["State", <RuntimeStatePill key="v" state="RUNNING" />],
            ]}
          />
          <SideSection title={`Connections (${designer.inspector.connections.length})`}>
            <KeyValue
              rows={designer.inspector.connections.map(
                ([device, endpoint]) =>
                  [
                    device,
                    <span key="v" className="mono">
                      {endpoint}
                    </span>,
                  ] as const,
              )}
            />
          </SideSection>
          <SideSection title="Disclosure">
            <p className="zf-sub px-4 py-2 text-fg-muted">
              Profile is represented by an OpenPLC-backed virtual PLC — not vendor firmware.
            </p>
          </SideSection>
          <div className="mt-auto flex gap-1.5 p-3">
            <Button size="sm" href={plcHref} className="flex-1">
              Open PLC
            </Button>
            <Button size="sm" variant="ghost">
              Remove
            </Button>
          </div>
        </SideBar>
      </div>
    </AppShell>
  );
}
