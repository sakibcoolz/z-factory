import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Stage } from "@/components/canvas/stage";
import { AppShell } from "@/components/shell/app-shell";
import { EditorTabs } from "@/components/shell/editor";
import { SideBar, SideSection, Tree } from "@/components/shell/side-bar";
import { Button } from "@/components/ui/button";
import { KeyValue } from "@/components/ui/primitives";
import { RuntimeStatePill } from "@/components/ui/state-pill";
import { demoContext, isDemoFactory } from "@/lib/fixtures";
import { factory, topology } from "@/lib/fixtures/pump-house-demo";
import { routes } from "@/lib/navigation/routes";

export const metadata: Metadata = { title: "Topology" };

type TopologyPageProps = {
  params: Promise<{ factoryId: string }>;
};

const LEGEND_CLASS = {
  ok: "text-ok",
  fault: "text-fault-fg",
  info: "text-info",
  plain: undefined,
} as const;

/** 2o — 2D Network / Wiring Topology: network · wiring · control-authority layers. */
export default async function TopologyPage({ params }: TopologyPageProps) {
  const { factoryId } = await params;
  if (!isDemoFactory(factoryId)) notFound();

  const { selected, networkZone } = topology;

  return (
    <AppShell
      title={`Topology — ${factory.name}`}
      command="⌘K"
      titleState={<RuntimeStatePill state={topology.state} />}
      activity="designer"
      context={demoContext}
      sidebar={
        <SideBar title="Layers" className="w-50">
          <Tree items={topology.layers} />
          <SideSection title="Legend">
            <KeyValue
              rows={topology.legend.map(
                (entry) =>
                  [
                    <span key="k" className={LEGEND_CLASS[entry.tone]}>
                      {entry.sample}
                    </span>,
                    entry.meaning,
                  ] as const,
              )}
            />
          </SideSection>
          <SideSection title={`Selected · ${selected.name}`}>
            <KeyValue
              rows={[
                ["State", <RuntimeStatePill key="v" state={selected.state} />],
                ...selected.rows.map(
                  ([label, value], index) =>
                    [
                      label,
                      index === 0 ? (
                        <span key="v" className="mono">
                          {value}
                        </span>
                      ) : (
                        value
                      ),
                    ] as const,
                ),
              ]}
            />
            <div className="flex gap-1.5 px-3 py-2.5">
              <Button size="sm" className="flex-1">
                Clear fault
              </Button>
              <Button size="sm" variant="ghost" href={routes.events(factoryId)}>
                Logs
              </Button>
            </div>
          </SideSection>
        </SideBar>
      }
      status={{ tone: "deg", left: [topology.state, topology.summary], right: ["layer: network"] }}
    >
      <EditorTabs
        tabs={[
          { label: "Designer", href: routes.designer(factoryId) },
          { label: "Topology", active: true },
          { label: "3D", href: routes.view3d(factoryId) },
        ]}
        crumb="read-only · auto-layout"
      />
      <Stage
        width={topology.stage.width}
        height={topology.stage.height}
        label="Factory topology"
        nodes={topology.nodes}
        edges={topology.edges}
      >
        <div
          className="zf-zone"
          style={{ left: networkZone.left, top: networkZone.top, width: networkZone.width, height: networkZone.height }}
        >
          <span className="zf-k">{networkZone.label}</span>
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
          <Button size="sm" variant="ghost">
            ⇄ relayout
          </Button>
        </div>
      </Stage>
    </AppShell>
  );
}
