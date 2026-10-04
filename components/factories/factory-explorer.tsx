import { SideBar, SideSection, Tree } from "@/components/shell/side-bar";
import { KeyValue } from "@/components/ui/primitives";
import { StatePill } from "@/components/ui/state-pill";
import type { RuntimeState } from "@/lib/domain/runtime-state";
import { DEMO_FACTORY_ID, MODULAR_BENCH_FACTORY_ID } from "@/lib/fixtures/factories";
import { routes } from "@/lib/navigation/routes";

const STATE_SHORT: Record<RuntimeState, string> = {
  STOPPED: "—",
  STARTING: "…",
  RUNNING: "RUN",
  DEGRADED: "DEG",
  FAULTED: "FLT",
  STOPPING: "…",
  DISCONNECTED: "DISC",
};

/** Docker Engine reachability, probed on the server and passed down as plain data. */
export type DockerHostStatus = { reachable: boolean; version?: string };

type FactoryExplorerProps = {
  factories: ReadonlyArray<{ id: string; name: string; runtimeStatus: RuntimeState }>;
  activeFactoryId?: string;
  docker: DockerHostStatus;
};

export function dockerStatusLabel(docker: DockerHostStatus): string {
  return docker.reachable ? `${docker.version ?? "engine"} · ok` : "unreachable";
}

/** Side bar of the factory screens: the owner's factories, the design fixtures and host status. */
export function FactoryExplorer({ factories, activeFactoryId, docker }: FactoryExplorerProps) {
  return (
    <SideBar title="Factories">
      <SideSection title="Workspace">
        {factories.length > 0 ? (
          <Tree
            items={factories.map((factory) => ({
              label: `▸ ${factory.name}`,
              meta: STATE_SHORT[factory.runtimeStatus],
              href: routes.factory(factory.id),
              active: factory.id === activeFactoryId,
            }))}
          />
        ) : (
          <div className="zf-box m-3 h-20">no factories yet</div>
        )}
      </SideSection>
      <SideSection title="Design fixtures">
        {/* Static wireframe data (TASK-104); not stored in the database. */}
        <Tree
          items={[
            { label: "▸ Pump House Demo", meta: "fixture", href: routes.designer(DEMO_FACTORY_ID) },
            {
              label: "▸ Modular S7-1500 bench",
              meta: "fixture",
              href: routes.newDevice(MODULAR_BENCH_FACTORY_ID, "modular"),
            },
          ]}
        />
      </SideSection>
      <SideSection title="Host">
        <KeyValue
          rows={[
            [
              "PostgreSQL",
              <StatePill key="v" tone="run">
                connected
              </StatePill>,
            ],
            [
              "Docker Engine",
              <StatePill key="v" tone={docker.reachable ? "run" : "flt"}>
                {dockerStatusLabel(docker)}
              </StatePill>,
            ],
            [
              "OpenPLC image",
              <StatePill key="v" tone="off">
                TASK-202
              </StatePill>,
            ],
          ]}
        />
      </SideSection>
    </SideBar>
  );
}
