import type { Metadata } from "next";
import { PlcSectionNav } from "@/components/plc/plc-section-nav";
import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs, Toolbar } from "@/components/shell/editor";
import { SideBar, SideSection } from "@/components/shell/side-bar";
import { Button } from "@/components/ui/button";
import { KeyValue } from "@/components/ui/primitives";
import { StatePill } from "@/components/ui/state-pill";
import { demoContext, isDemoPlc } from "@/lib/fixtures";
import { ioMapping, plc, program } from "@/lib/fixtures/pump-house-demo";
import { routes } from "@/lib/navigation/routes";
import { StoredPlcIoMapping } from "../stored-screens";

export const metadata: Metadata = { title: "I/O mapping" };

// Stored PLCs read the database on every request.
export const dynamic = "force-dynamic";

type IoMappingPageProps = {
  params: Promise<{ factoryId: string; plcId: string }>;
};

/** 2j — I/O Mapping / Pinout: channel › logical address › tag › Modbus area. */
export default async function IoMappingPage({ params }: IoMappingPageProps) {
  const { factoryId, plcId } = await params;
  // Stored PLCs render from the database; the demo PLC keeps its fixture screen.
  if (!isDemoPlc(factoryId, plcId)) return StoredPlcIoMapping({ factoryId, plcId });

  const { rows } = ioMapping;
  const unmapped = rows.filter((row) => row.tag === null).length;
  const problems = rows.filter((row) => row.problem).length;

  return (
    <AppShell
      title={`I/O Mapping — ${plc.name}`}
      activity="designer"
      context={demoContext}
      sidebar={
        <SideBar title={plc.name}>
          <PlcSectionNav factoryId={factoryId} plcId={plcId} active="io-mapping" />
          <SideSection title="Filters">
            <div className="zf-chips">
              {ioMapping.filters.map((filter, index) => (
                <StatePill key={filter} tone={index === 0 ? "start" : "off"}>
                  {filter}
                </StatePill>
              ))}
            </div>
          </SideSection>
          <SideSection title="Conventions">
            <KeyValue
              rows={ioMapping.conventions.map(
                ([label, value]) =>
                  [
                    label,
                    <span key="v" className="mono">
                      {value}
                    </span>,
                  ] as const,
              )}
            />
          </SideSection>
        </SideBar>
      }
      status={{
        tone: problems > 0 ? "deg" : "ok",
        left: [`⚠ ${problems} duplicate channel`, `${unmapped} unmapped`],
        right: [`io ${ioMapping.currentVersion} → ${ioMapping.draftVersion} draft`],
      }}
    >
      <EditorTabs
        tabs={[
          { label: program.file, href: routes.plcProgram(factoryId, plcId) },
          { label: "I/O Mapping", active: true },
        ]}
        crumb="channel → %address → tag → modbus"
      />
      <Toolbar summary={`${rows.length} tags · ${unmapped} unmapped · duplicates blocked`}>
        <Button size="sm" variant="ghost">
          Auto-assign free
        </Button>
        <Button size="sm" variant="ghost">
          Import CSV
        </Button>
        <Button size="sm" variant="primary">
          {`Save mapping ${ioMapping.draftVersion}`}
        </Button>
      </Toolbar>
      <Content plain flush>
        <table className="zf-tbl">
          <thead>
            <tr>
              <th>Channel / source</th>
              <th>Logical</th>
              <th>Tag</th>
              <th>Type</th>
              <th>Dir</th>
              <th>Role</th>
              <th>Modbus area · addr</th>
              <th>Scale · unit</th>
              <th>Access</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.logical}
                aria-selected={row.selected ?? false}
                data-tone={row.problem ? "fault" : undefined}
                data-muted={row.tag === null && !row.problem}
              >
                <td className="mono">{row.source}</td>
                <td className="mono">{row.logical}</td>
                {row.problem ? (
                  <td className="mono text-fault-fg">{`⊗ ${row.problem}`}</td>
                ) : row.tag ? (
                  <td className="mono syn-var">{row.tag}</td>
                ) : (
                  <td className="mono syn-comment">unmapped</td>
                )}
                <td className="mono syn-type">{row.dataType}</td>
                <td className="mono">{row.direction}</td>
                <td>{row.role}</td>
                <td className="mono">{row.modbus}</td>
                <td className="mono">{row.scale}</td>
                <td className="mono">{row.access}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="zf-sub mt-auto border-t border-line-subtle px-4 py-2.5">
          Display notation (3xxxx/4xxxx) is derived; internals store normalized area + zero-based address.
        </p>
      </Content>
    </AppShell>
  );
}
