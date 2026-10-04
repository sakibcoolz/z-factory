import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PlcSectionNav } from "@/components/plc/plc-section-nav";
import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs } from "@/components/shell/editor";
import { SideBar } from "@/components/shell/side-bar";
import { Button } from "@/components/ui/button";
import { Gauge, KeyValue } from "@/components/ui/primitives";
import { RuntimeStatePill } from "@/components/ui/state-pill";
import { demoContext, isDemoPlc } from "@/lib/fixtures";
import { factory, plc, plcOverview } from "@/lib/fixtures/pump-house-demo";
import { routes } from "@/lib/navigation/routes";

export const metadata: Metadata = { title: "PLC overview" };

type PlcPageProps = {
  params: Promise<{ factoryId: string; plcId: string }>;
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

/** 2h — PLC Details / Edit: overview with section navigation and version metadata. */
export default async function PlcPage({ params }: PlcPageProps) {
  const { factoryId, plcId } = await params;
  if (!isDemoPlc(factoryId, plcId)) notFound();

  const overview = plcOverview;

  return (
    <AppShell
      title={`${factory.name} — Z-FACTORY`}
      command="⌘K"
      titleState={<RuntimeStatePill state={overview.state} />}
      activity="designer"
      context={demoContext}
      sidebar={
        <SideBar title={plc.name}>
          <PlcSectionNav factoryId={factoryId} plcId={plcId} active="overview" />
        </SideBar>
      }
      status={{ left: [`⎇ ${factory.slug}`, "plc overview"], right: [overview.versionSummary] }}
    >
      <EditorTabs
        tabs={[
          { label: "Designer", href: routes.designer(factoryId) },
          { label: `PLC · ${plc.name}`, active: true },
        ]}
        crumb="devices › plc › overview"
      />
      <Content plain>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="zf-k">{`PLC · ${plc.role}`}</div>
            <h1 className="zf-h mt-1.5">{plc.name}</h1>
            <p className="mt-1 text-fg-muted">
              {plc.profile} · {plc.architecture} · runtime <span className="syn-type">{plc.runtime}</span>
            </p>
          </div>
          <div className="flex gap-1.5">
            <Button size="sm" variant="ghost">
              Restart
            </Button>
            <Button size="sm" variant="ghost">
              Stop
            </Button>
            <Button size="sm" href={routes.simulator(factoryId)}>
              Debug
            </Button>
            <Button size="sm" variant="primary" href={routes.plcExport(factoryId, plcId)}>
              Export
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-2.5">
          <div className="zf-cell">
            <span className="zf-k">State</span>
            <RuntimeStatePill state={overview.state} />
            <span className="mono text-fg-dim">{overview.uptime}</span>
          </div>
          <div className="zf-cell">
            <span className="zf-k">Program</span>
            <span className="mono text-fg-strong">{overview.program.label}</span>
            <span className="mono text-fg-dim">{overview.program.deployed}</span>
          </div>
          <div className="zf-cell">
            <span className="zf-k">Scan</span>
            <span className="mono text-fg-strong">{overview.scan.label}</span>
            <Gauge percent={overview.scan.percent} label="Scan time used" />
          </div>
          <div className="zf-cell">
            <span className="zf-k">Endpoint</span>
            <span className="mono text-fg-strong">{overview.endpoint.internal}</span>
            <span className="mono text-fg-dim">{overview.endpoint.published}</span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <section className="zf-cell" data-flush="true">
            <h2 className="zf-cell-head">Versions</h2>
            <KeyValue rows={monoRows(overview.versions)} />
          </section>
          <section className="zf-cell" data-flush="true">
            <h2 className="zf-cell-head">Connected devices</h2>
            <KeyValue rows={monoRows(overview.connectedDevices)} />
          </section>
        </div>
        <p className="zf-sub mt-auto">
          Hardware profile and executable runtime are separate: no claim of vendor firmware, timing or safety
          certification.
        </p>
      </Content>
    </AppShell>
  );
}
