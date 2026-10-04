import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs } from "@/components/shell/editor";
import { SideBar, SideSection, Tree } from "@/components/shell/side-bar";
import { Button } from "@/components/ui/button";
import { KeyValue } from "@/components/ui/primitives";
import { demoContext, isDemoPlc } from "@/lib/fixtures";
import { devices, plc, plcExport } from "@/lib/fixtures/pump-house-demo";

export const metadata: Metadata = { title: "PLC export" };

type ExportPageProps = {
  params: Promise<{ factoryId: string; plcId: string }>;
};

/** 2p — PLC Export / Print: report preview, section picker, CSV / JSON / package. */
export default async function ExportPage({ params }: ExportPageProps) {
  const { factoryId, plcId } = await params;
  if (!isDemoPlc(factoryId, plcId)) notFound();

  const { sections, sheet } = plcExport;
  const included = sections.filter((section) => section.included).length;
  const scheduleIndex = sections.findIndex((section) => section.title === "Connected-device schedule") + 1;
  const topologyIndex = sections.findIndex((section) => section.title === "Topology diagram") + 1;

  return (
    <AppShell
      title={`Export — ${plc.name}`}
      command="reproducible from recorded snapshot"
      activity="export"
      context={demoContext}
      sidebar={
        <SideBar title="Export" className="w-62.5">
          <SideSection title="Format">
            <Tree items={plcExport.formats} />
          </SideSection>
          <SideSection title={`Report sections (${sections.length})`}>
            <Tree
              items={sections.map((section, index) => ({
                label: `${section.included ? "☑" : "☐"} ${index + 1} ${section.title}`,
              }))}
            />
          </SideSection>
          <SideSection title="Pinned versions">
            <KeyValue
              rows={plcExport.pinned.map(
                ([label, value]) =>
                  [
                    label,
                    <span key="v" className={label === "Secrets" ? "mono syn-comment" : "mono"}>
                      {value}
                    </span>,
                  ] as const,
              )}
            />
          </SideSection>
          <div className="mt-auto flex flex-col gap-1.5 p-3">
            <Button variant="primary">Generate PDF</Button>
            <Button variant="ghost">Print</Button>
          </div>
        </SideBar>
      }
      status={{
        left: ["export", `${included} of ${sections.length} sections`],
        right: ["no secrets · no host paths"],
      }}
    >
      <EditorTabs tabs={[{ label: `Preview · page ${sheet.page}`, active: true }]} crumb="Letter / A4 · grayscale" />
      <Content className="items-center p-5">
        <article className="zf-sheet" aria-label="Engineering report preview">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="zf-sheet-k">Z-Factory · engineering export</div>
              <h2>{`${plc.name} — ${plc.role}`}</h2>
            </div>
            <div className="zf-sheet-k text-right">{sheet.revision}</div>
          </div>
          <div className="zf-sheet-rule" />
          <div className="grid grid-cols-3 gap-2.5">
            {sheet.identity.map(([label, value]) => (
              <div key={label}>
                <div className="zf-sheet-k">{label}</div>
                {value}
              </div>
            ))}
          </div>
          <div className="zf-sheet-k">{`${scheduleIndex} · Connected-device schedule`}</div>
          <table>
            <thead>
              <tr>
                {sheet.scheduleColumns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sheet.schedule.map((row) => (
                <tr key={row[1]}>
                  {row.map((cell, index) => (
                    <td key={index}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="zf-sheet-k">{`${topologyIndex} · Topology`}</div>
          <div className="zf-sheet-figure">
            wiring diagram (grayscale) — {devices.map((device) => device.name).join(" · ")}
          </div>
          <div className="zf-sheet-k mt-auto flex justify-between gap-4">
            <span>Simulation is an approximation for control testing — not electrical/process certification.</span>
            <span>{sheet.page}</span>
          </div>
        </article>
      </Content>
    </AppShell>
  );
}
