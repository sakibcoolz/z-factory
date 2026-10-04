import type { Metadata } from "next";
import Link from "next/link";
import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs } from "@/components/shell/editor";
import { SideBar } from "@/components/shell/side-bar";
import { SectionRule } from "@/components/ui/primitives";
import { StatePill, type Tone } from "@/components/ui/state-pill";
import { host } from "@/lib/fixtures/factories";
import { routes } from "@/lib/navigation/routes";

export const metadata: Metadata = { title: "Welcome" };

const START_ACTIONS: ReadonlyArray<{ label: string; href: string }> = [
  { label: "Create the primary demo factory", href: routes.newFactory() },
  { label: "New empty factory…", href: routes.newFactory() },
  { label: "Import factory JSON…", href: routes.newFactory() },
  { label: "Browse device catalog", href: routes.catalog() },
];

const HOST_CHECKS: ReadonlyArray<{ label: string; tone: Tone; status: string }> = [
  { label: "Docker Engine", tone: "run", status: "ok" },
  { label: "OpenPLC image", tone: "start", status: "pulling 64%" },
  { label: "PostgreSQL", tone: "run", status: "migrated" },
];

/** 2b — First run: welcome page in the editor area. */
export default function WelcomePage() {
  return (
    <AppShell
      title="Z-FACTORY"
      activity="factories"
      sidebar={
        <SideBar title="Factories" className="w-40">
          <div className="zf-box m-3 h-20">no factories yet</div>
        </SideBar>
      }
      status={{ tone: "off", left: ["no factory open"], right: [`Docker ${host.dockerEngine}`] }}
    >
      <EditorTabs tabs={[{ label: "Welcome", active: true }]} />
      <Content plain className="gap-4.5">
        <div>
          <div className="zf-k">Z-Factory</div>
          <h1 className="zf-h mt-1.5 text-hero">Build a virtual plant.</h1>
          <p className="mt-1.5 max-w-90 leading-normal text-fg-muted">
            Catalog PLC → OpenPLC runtime → VFD → motor → pump, with an external edge gateway closing the loop over
            Modbus TCP.
          </p>
        </div>
        <SectionRule>
          <span className="zf-k">Start</span>
        </SectionRule>
        <ul className="flex flex-col gap-2">
          {START_ACTIONS.map((action) => (
            <li key={action.label}>
              <Link href={action.href} className="text-info hover:underline">
                ▸ {action.label}
              </Link>
            </li>
          ))}
        </ul>
        <SectionRule>
          <span className="zf-k">Host checks</span>
        </SectionRule>
        <div className="grid grid-cols-3 gap-2">
          {HOST_CHECKS.map((check) => (
            <div key={check.label} className="zf-cell">
              <span className="zf-k">{check.label}</span>
              <StatePill tone={check.tone}>{check.status}</StatePill>
            </div>
          ))}
        </div>
      </Content>
    </AppShell>
  );
}
