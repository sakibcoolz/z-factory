import type { Metadata } from "next";
import { FactoryExplorer } from "@/components/factories/factory-explorer";
import { Welcome } from "@/components/factories/welcome";
import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs } from "@/components/shell/editor";
import { Button } from "@/components/ui/button";
import { RuntimeStatePill } from "@/components/ui/state-pill";
import { requireActor } from "@/lib/auth/actor";
import { getDb } from "@/lib/db/client";
import { getDocker } from "@/lib/docker/client";
import { getDockerEngineStatus } from "@/lib/docker/status";
import { RUNTIME_STATES, type RuntimeState, runtimeStateLabel } from "@/lib/domain/runtime-state";
import { formatUtc } from "@/lib/factories/format";
import { routes } from "@/lib/navigation/routes";
import { listFactories } from "@/lib/services/factory-service";

export const metadata: Metadata = { title: "Factories" };

// Reads the database on every request; never prerendered at build time.
export const dynamic = "force-dynamic";

const SUMMARY_STATES: readonly RuntimeState[] = ["RUNNING", "DEGRADED", "FAULTED", "STOPPED"];

/** 2a — Factories: explorer + factory list. 2b — first run, when the owner has no factories. */
export default async function FactoriesPage() {
  const actor = await requireActor();
  const [factories, docker] = await Promise.all([listFactories(getDb(), actor), getDockerEngineStatus(getDocker())]);
  const countByState = (state: RuntimeState) => factories.filter((factory) => factory.runtimeStatus === state).length;
  const isEmpty = factories.length === 0;

  return (
    <AppShell
      title="Z-FACTORY"
      activity="factories"
      badges={{ factories: factories.length }}
      sidebar={<FactoryExplorer factories={factories} docker={docker} />}
      status={{
        tone: isEmpty ? "off" : "ok",
        left: [isEmpty ? "no factory yet" : `${factories.length} ${factories.length === 1 ? "factory" : "factories"}`],
        right: ["PostgreSQL connected", docker.reachable ? `Docker ${docker.version}` : "Docker unreachable"],
      }}
    >
      <EditorTabs tabs={[{ label: isEmpty ? "Welcome" : "Factories", active: true }]} crumb="workspace › factories" />
      {isEmpty ? (
        <Content plain className="gap-4.5">
          <Welcome docker={docker} />
        </Content>
      ) : (
        <Content>
          <div className="flex items-end justify-between gap-3">
            <div>
              <div className="zf-k">Workspace</div>
              <h1 className="zf-h mt-1.5">Factories</h1>
            </div>
            <div className="flex gap-2">
              <Button href={routes.llmIndex()}>LLM Index</Button>
              <Button variant="primary" href={routes.newFactory()}>
                + New factory
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
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
                <th>Subnet</th>
                <th>PLCs</th>
                <th>State</th>
                <th>Last event</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {factories.map((factory) => (
                <tr key={factory.id}>
                  <td>
                    <b className="text-fg-strong">{factory.name}</b>
                    {factory.description ? <div className="zf-sub mt-0.5">{factory.description}</div> : null}
                  </td>
                  <td className="mono">{factory.deviceCount}</td>
                  <td className="mono">{factory.subnetCidr}</td>
                  <td className="mono">{factory.plcCount}</td>
                  <td>
                    <RuntimeStatePill state={factory.runtimeStatus} />
                  </td>
                  <td className="mono">
                    {factory.lastEvent ? `${factory.lastEvent.type} · ${formatUtc(factory.lastEvent.occurredAt)}` : "—"}
                  </td>
                  <td>
                    <Button size="sm" href={routes.factory(factory.id)}>
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
      )}
    </AppShell>
  );
}
