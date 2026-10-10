import { SideBar, SideSection, Tree } from "@/components/shell/side-bar";
import { KeyValue } from "@/components/ui/primitives";
import { StatePill } from "@/components/ui/state-pill";
import type { RuntimeState } from "@/lib/domain/runtime-state";
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

/** Docker Engine reachability and the pinned OpenPLC image, probed on the server and passed down as plain data. */
export type DockerHostStatus = { reachable: boolean; version?: string; openPlcImage?: string };

/** The pinned OpenPLC runtime image, by its tag: what a PLC starts with. */
export function openPlcImageLabel(docker: DockerHostStatus): string {
  return docker.openPlcImage ? `${docker.openPlcImage} · pinned` : "not configured";
}

type FactoryExplorerProps = {
  factories: ReadonlyArray<{ id: string; name: string; runtimeStatus: RuntimeState }>;
  activeFactoryId?: string;
  docker: DockerHostStatus;
};

export function dockerStatusLabel(docker: DockerHostStatus): string {
  return docker.reachable ? `${docker.version ?? "engine"} · ok` : "unreachable";
}

/** Side bar of the factory screens: the owner's factories and host status. */
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
                {openPlcImageLabel(docker)}
              </StatePill>,
            ],
          ]}
        />
      </SideSection>
    </SideBar>
  );
}
