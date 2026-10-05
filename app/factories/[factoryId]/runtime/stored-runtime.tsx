import Link from "next/link";
import { LiveRefresh } from "@/components/live/live-refresh";
import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs } from "@/components/shell/editor";
import { Button } from "@/components/ui/button";
import { RuntimeStatePill, StatePill } from "@/components/ui/state-pill";
import { getDb } from "@/lib/db/client";
import { routes } from "@/lib/navigation/routes";
import { listFactoryDevices } from "@/lib/services/plc-config-service";
import { getSimulationDeps } from "@/lib/services/runtime-deps";
import { getSimulationState } from "@/lib/services/simulation-service";
import { loadFactory } from "../load-factory";

/**
 * 2n for a stored factory: its PLC runtimes with their last known state, and the device
 * simulation. Each PLC is operated from its own Runtime screen.
 */
export async function StoredFactoryRuntime({ factoryId }: { factoryId: string }) {
  const { factory, docker, actor } = await loadFactory(factoryId);
  const [devices, simulation] = await Promise.all([
    listFactoryDevices(getDb(), actor, factory.id),
    getSimulationState(getSimulationDeps(), actor, factory.id),
  ]);
  const plcs = devices.filter((device) => device.architectureType !== null);
  const started = plcs.filter((plc) => plc.runtimeStatus !== "STOPPED").length;

  return (
    <AppShell
      title={`Runtime — ${factory.name}`}
      titleState={<RuntimeStatePill state={factory.runtimeStatus} />}
      activity="factories"
      status={{
        tone: factory.runtimeStatus === "STOPPED" ? "off" : factory.runtimeStatus === "RUNNING" ? "ok" : "deg",
        left: [`⎇ ${factory.slug}`, "runtime", `${started}/${plcs.length} PLC runtimes started`],
        right: [docker.reachable ? `Docker ${docker.version}` : "Docker unreachable"],
      }}
    >
      <LiveRefresh streamUrl={routes.stream(factory.id)} />
      <EditorTabs
        tabs={[
          { label: factory.name, href: routes.factory(factory.id) },
          { label: "Runtime", active: true },
          { label: "Simulator", href: routes.simulator(factory.id) },
        ]}
        crumb={`${factory.slug} › runtime`}
      />
      <Content plain>
        <div>
          <div className="zf-k">{`Factory · ${factory.slug}`}</div>
          <h1 className="zf-h mt-1.5">Runtime</h1>
        </div>
        {docker.reachable ? null : (
          <p className="zf-error" role="alert">
            The Docker Engine is not reachable. PLC runtimes cannot be started or read until it is.
          </p>
        )}
        <div className="grid grid-cols-3 gap-2.5">
          <div className="zf-cell">
            <span className="zf-k">Factory</span>
            <RuntimeStatePill state={factory.runtimeStatus} />
            <span className="mono text-fg-dim">last stored state of its PLC runtimes</span>
          </div>
          <div className="zf-cell">
            <span className="zf-k">Device simulation</span>
            <StatePill tone={simulation.running ? "run" : "off"}>
              {simulation.running ? "running" : "stopped"}
            </StatePill>
            <Button size="sm" variant="ghost" href={routes.simulator(factory.id)} className="w-max">
              Open simulator
            </Button>
          </div>
          <div className="zf-cell">
            <span className="zf-k">Host</span>
            <StatePill tone={docker.reachable ? "run" : "flt"}>
              {docker.reachable ? `Docker ${docker.version}` : "Docker unreachable"}
            </StatePill>
            <span className="mono text-fg-dim">one isolated network per factory</span>
          </div>
        </div>
        {plcs.length > 0 ? (
          <table className="zf-tbl">
            <thead>
              <tr>
                <th>PLC</th>
                <th>Model</th>
                <th>Role</th>
                <th>State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {plcs.map((plc) => (
                <tr key={plc.id}>
                  <td className="mono">
                    <Link href={routes.plc(factory.id, plc.id)}>{plc.name}</Link>
                  </td>
                  <td>{`${plc.manufacturer} ${plc.modelName}`}</td>
                  <td>{plc.role ?? "—"}</td>
                  <td>
                    <RuntimeStatePill state={plc.runtimeStatus} />
                  </td>
                  <td>
                    <span className="flex gap-1.5">
                      <Button size="sm" href={routes.plcRuntime(factory.id, plc.id)}>
                        Runtime
                      </Button>
                      <Button size="sm" variant="ghost" href={routes.plcProgram(factory.id, plc.id)}>
                        Program
                      </Button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="zf-sub">This factory has no PLC yet. Add one from the factory overview or the designer.</p>
        )}
        <p className="zf-sub">
          States are the last ones Z-Factory stored. A PLC&apos;s Runtime screen reads the live state and starts, stops
          or removes its runtime.
        </p>
      </Content>
    </AppShell>
  );
}
