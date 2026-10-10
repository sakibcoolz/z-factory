import Link from "next/link";
import { LlmContextPanel } from "@/components/agent/llm-context";
import { LiveRefresh } from "@/components/live/live-refresh";
import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs } from "@/components/shell/editor";
import { Button } from "@/components/ui/button";
import { OperationForm } from "@/components/ui/operation-form";
import { RuntimeStatePill, StatePill } from "@/components/ui/state-pill";
import { buildFactoryRuntimeContext } from "@/lib/agent/contexts/factory-operations";
import { getDb } from "@/lib/db/client";
import { routes } from "@/lib/navigation/routes";
import { listFactoryDevices } from "@/lib/services/plc-config-service";
import { getSimulationDeps } from "@/lib/services/runtime-deps";
import { getSimulationState } from "@/lib/services/simulation-service";
import { loadFactory } from "../load-factory";
import { factoryRuntimeAction } from "./actions";

/**
 * 2n for a stored factory: its PLC runtimes with their last known state, and the device
 * simulation, with one start and one stop for the factory as a whole. A single PLC is
 * operated from its own Runtime screen.
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
          { label: "Gateways", href: routes.gateways(factory.id) },
        ]}
        crumb={`${factory.slug} › runtime`}
      />
      <Content plain>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="zf-k">{`Factory · ${factory.slug}`}</div>
            <h1 className="zf-h mt-1.5">Runtime</h1>
          </div>
          <OperationForm
            label="Factory"
            action={factoryRuntimeAction.bind(null, factory.id)}
            pendingHint="Starting a PLC downloads the runtime image the first time and builds its program: this can take minutes."
            buttons={[
              {
                operation: "start",
                label: "Start factory",
                pendingLabel: "Starting…",
                variant: "primary",
                disabled: plcs.length === 0 || !docker.reachable,
                title: "Starts every PLC runtime, then the device simulation, then the gateway endpoints.",
              },
              {
                operation: "stop",
                label: "Stop factory",
                pendingLabel: "Stopping…",
                variant: "danger",
                disabled: started === 0 && !simulation.running,
                confirm: "Stop the device simulation and every PLC runtime of this factory?",
              },
            ]}
          />
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
          States are the last ones Z-Factory stored. &quot;Start factory&quot; starts every PLC, then the simulation,
          then the gateway endpoints; a PLC&apos;s own Runtime screen reads its live state and starts, stops or removes
          that one runtime.
        </p>
        <LlmContextPanel document={buildFactoryRuntimeContext({ factory, devices, simulation, docker })} />
      </Content>
    </AppShell>
  );
}
