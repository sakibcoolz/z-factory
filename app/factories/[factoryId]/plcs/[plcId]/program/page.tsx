import type { Metadata } from "next";
import { AppShell } from "@/components/shell/app-shell";
import { EditorTabs, Panel, Toolbar } from "@/components/shell/editor";
import { SideBar, SideSection, Tree } from "@/components/shell/side-bar";
import { Button } from "@/components/ui/button";
import { KeyValue } from "@/components/ui/primitives";
import { StatePill } from "@/components/ui/state-pill";
import { demoContext, isDemoPlc } from "@/lib/fixtures";
import { factory, program, type SyntaxKind } from "@/lib/fixtures/pump-house-demo";
import { routes } from "@/lib/navigation/routes";
import { StoredPlcProgram } from "../stored-runtime-screens";

export const metadata: Metadata = { title: "PLC program" };

// Stored PLCs read the database on every request.
export const dynamic = "force-dynamic";

type ProgramPageProps = {
  params: Promise<{ factoryId: string; plcId: string }>;
  searchParams?: Promise<{ version?: string | string[] }>;
};

const SYNTAX_CLASS: Record<SyntaxKind, string | undefined> = {
  plain: undefined,
  kw: "syn-kw",
  var: "syn-var",
  str: "syn-str",
  num: "syn-num",
  type: "syn-type",
  fn: "syn-fn",
  comment: "syn-comment",
};

/** 2i — PLC Program & Versions: ST source, lifecycle bar, build panel. */
export default async function ProgramPage({ params, searchParams }: ProgramPageProps) {
  const { factoryId, plcId } = await params;
  // Stored PLCs edit their real program; the demo PLC keeps its fixture screen.
  if (!isDemoPlc(factoryId, plcId)) {
    const requested = (await searchParams)?.version;
    const version = typeof requested === "string" && /^[1-9]\d{0,8}$/.test(requested) ? Number(requested) : undefined;
    return StoredPlcProgram({ factoryId, plcId, version });
  }

  return (
    <AppShell
      title={`${program.file} — ${factory.name}`}
      command="⌘K"
      titleState={<StatePill tone="run">{`Running ${program.runningVersion}`}</StatePill>}
      activity="designer"
      context={demoContext}
      sidebar={
        <SideBar title="Program" className="w-65">
          <SideSection title="Files">
            <Tree items={[...program.files, { label: "+ new program", muted: true }]} />
          </SideSection>
          <SideSection title="Versions">
            <Tree
              items={[
                ...program.versions.map((version) => ({
                  label: (
                    <>
                      <span className="mono syn-num">{version.version}</span> {version.note}
                    </>
                  ),
                  meta: version.when,
                })),
                { label: <span className="text-info">↶ rollback to…</span> },
              ]}
            />
          </SideSection>
          <SideSection title="Located variables">
            <KeyValue
              rows={program.locatedVariables.map(
                ([name, address]) =>
                  [
                    <span key="k" className="mono syn-var">
                      {name}
                    </span>,
                    <span key="v" className="mono">
                      {address}
                    </span>,
                  ] as const,
              )}
            />
          </SideSection>
        </SideBar>
      }
      status={{
        left: [
          `Ln ${program.activeLine}, Col 3`,
          "ST",
          `${program.draftVersion} draft → ${program.runningVersion} running`,
        ],
        right: ["⚠ 1", "UTF-8"],
      }}
    >
      <EditorTabs
        tabs={[
          { label: `● ${program.file}`, active: true },
          { label: "alarms.st" },
          { label: "I/O Mapping", href: routes.plcIoMapping(factoryId, plcId) },
        ]}
        crumb="edit › save version › compile › deploy › run"
      />
      <Toolbar summary={`IEC 61131-3 · Structured Text · ${program.draftVersion} draft`}>
        <Button size="sm" variant="ghost">
          Save version
        </Button>
        <Button size="sm">Validate / compile</Button>
        <Button size="sm" variant="primary">
          Deploy
        </Button>
        <Button size="sm" variant="ghost">
          ▶ Run
        </Button>
        <Button size="sm" variant="ghost">
          ■ Stop
        </Button>
        <Button size="sm" variant="ghost">
          ↻ Restart
        </Button>
      </Toolbar>
      <div className="zf-code" role="region" aria-label={`${program.file} source`} tabIndex={0}>
        {program.source.map((tokens, index) => {
          const lineNumber = index + 1;
          return (
            <div key={lineNumber} className="zf-code-line" data-active={lineNumber === program.activeLine}>
              <span className="zf-code-no">{lineNumber}</span>
              <span>
                {tokens.map(([kind, text], tokenIndex) => (
                  <span key={tokenIndex} className={SYNTAX_CLASS[kind]}>
                    {text}
                  </span>
                ))}
              </span>
            </div>
          );
        })}
      </div>
      <Panel tabs={["Problems", "Build", "Deploy", "Debug console"]} active="Build">
        <div className="zf-log">
          <span>
            <span className="syn-comment">$</span> {program.build.command}{" "}
            <span className="text-ok">{program.build.result}</span> {program.build.summary}
          </span>
          <span className="text-warn">{program.build.warning}</span>
          <span>{program.build.artifacts}</span>
          <span className="text-fg-dim">{program.build.note}</span>
        </div>
      </Panel>
    </AppShell>
  );
}
