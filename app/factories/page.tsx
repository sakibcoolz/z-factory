import type { Metadata } from "next";
import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs } from "@/components/shell/editor";
import { SideBar, SideSection, Tree } from "@/components/shell/side-bar";
import { Button } from "@/components/ui/button";
import { KeyValue } from "@/components/ui/primitives";
import { RuntimeStatePill, StatePill } from "@/components/ui/state-pill";
import { RUNTIME_STATES, type RuntimeState, runtimeStateLabel } from "@/lib/domain/runtime-state";
import { factories, host } from "@/lib/fixtures/factories";
import { routes } from "@/lib/navigation/routes";

export const metadata: Metadata = { title: "Factories" };

const STATE_SHORT: Record<RuntimeState, string> = {
  STOPPED: "—",
  STARTING: "…",
  RUNNING: "RUN",
  DEGRADED: "DEG",
  FAULTED: "FLT",
  STOPPING: "…",
  DISCONNECTED: "DISC",
};

const SUMMARY_STATES: readonly RuntimeState[] = ["RUNNING", "DEGRADED", "FAULTED", "STOPPED"];

/** 2a — Factories: explorer + factory list. */
export default function FactoriesPage() {
  const countByState = (state: RuntimeState) => factories.filter((factory) => factory.state === state).length;

  return (
    <AppShell
      title="Z-FACTORY"
      command="⌘K · search factories, devices, tags…"
      titleState={<StatePill tone="run">docker</StatePill>}
      activity="factories"
      badges={{ factories: factories.length }}
      sidebar={
        <SideBar title="Factories">
          <SideSection title="Workspace">
            <Tree
              items={factories.map((factory, index) => ({
                label: `▸ ${factory.name}`,
                meta: STATE_SHORT[factory.state],
                href: factory.href ?? undefined,
                active: index === 0,
              }))}
            />
          </SideSection>
          <SideSection title="Host">
            <KeyValue
              rows={[
                ["Docker Engine", <span key="v" className="mono">{`${host.dockerEngine} · ok`}</span>],
                [
                  "OpenPLC image",
                  <span key="v" className="mono">
                    {host.openPlcImageDigest}
                  </span>,
                ],
                [
                  "Ports free",
                  <span key="v" className="mono">
                    {host.freePortRange}
                  </span>,
                ],
              ]}
            />
          </SideSection>
        </SideBar>
      }
      status={{
        left: ["⎇ develop", `${factories.length} factories`, "SSE connected"],
        right: [`Docker ${host.dockerEngine}`, "Postgres ok"],
      }}
    >
      <EditorTabs tabs={[{ label: "Factories", active: true }]} crumb="workspace › factories" />
      <Content>
        <div className="flex items-end justify-between gap-3">
          <div>
            <div className="zf-k">Workspace</div>
            <h1 className="zf-h mt-1.5">Factories</h1>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost">Import JSON</Button>
            <Button variant="primary" href={routes.newFactory()}>
              + New factory
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="zf-in w-65">Filter…</div>
          {SUMMARY_STATES.map((state) => (
            <RuntimeStatePill key={state} state={state}>
              {`${runtimeStateLabel(state)} ${countByState(state)}`}
            </RuntimeStatePill>
          ))}
        </div>
        <table className="zf-tbl">
          <thead>
            <tr>
              <th>Factory</th>
              <th>Devices</th>
              <th>Network</th>
              <th>PLCs</th>
              <th>State</th>
              <th>Last event</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {factories.map((factory, index) => (
              <tr key={factory.id} aria-selected={index === 0}>
                <td>
                  <b className="text-fg-strong">{factory.name}</b>
                  {factory.summary ? <div className="zf-sub mt-0.5">{factory.summary}</div> : null}
                </td>
                <td className="mono">{factory.deviceCount}</td>
                <td className="mono">{factory.networkName ?? "—"}</td>
                <td className="mono">{factory.plcCount}</td>
                <td>
                  <RuntimeStatePill state={factory.state} />
                </td>
                <td className="mono">{factory.lastEvent}</td>
                <td>
                  <Button size="sm" href={factory.href ?? undefined} disabled={!factory.href}>
                    Open
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-auto flex flex-wrap items-center gap-2">
          <span className="zf-k">Runtime states</span>
          {RUNTIME_STATES.map((state) => (
            <RuntimeStatePill key={state} state={state} />
          ))}
        </div>
      </Content>
    </AppShell>
  );
}
