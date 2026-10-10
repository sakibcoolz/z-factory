import Link from "next/link";
import { notFound } from "next/navigation";
import { LlmContextPanel } from "@/components/agent/llm-context";
import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs } from "@/components/shell/editor";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { type OperationButton, OperationForm } from "@/components/ui/operation-form";
import { SectionRule } from "@/components/ui/primitives";
import { RuntimeStatePill, StatePill } from "@/components/ui/state-pill";
import { buildSimulatorContext } from "@/lib/agent/contexts/factory-operations";
import { requireActor } from "@/lib/auth/actor";
import { getDb } from "@/lib/db/client";
import { isDomainError } from "@/lib/domain/errors";
import type { SimulatedDeviceView, SimulatedSignalView } from "@/lib/domain/simulation-view";
import { formatUtc } from "@/lib/factories/format";
import { routes } from "@/lib/navigation/routes";
import { getFactory } from "@/lib/services/factory-service";
import { getSimulationDeps } from "@/lib/services/runtime-deps";
import { getSimulationView } from "@/lib/services/simulation-service";
import { deviceFaultAction, simulationAction } from "./actions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function signalValue(signal: SimulatedSignalView): string {
  if (signal.value === null) return "—";
  if (typeof signal.value === "boolean") return signal.value ? "ON" : "OFF";
  const rounded = Number.isInteger(signal.value) ? String(signal.value) : signal.value.toFixed(2);
  return signal.unit ? `${rounded} ${signal.unit}` : rounded;
}

function Signals({ signals, live }: { signals: readonly SimulatedSignalView[]; live: boolean }) {
  if (signals.length === 0) return <span className="zf-sub">none</span>;
  return (
    <table className="zf-tbl">
      <tbody>
        {signals.map((signal) => (
          <tr key={signal.key} data-muted={signal.tag === null}>
            <td>{signal.label}</td>
            <td className="mono text-fg-strong">{live ? signalValue(signal) : "—"}</td>
            <td className="mono text-fg-dim">{signal.tag ?? "not wired"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function faultButtons(device: SimulatedDeviceView, running: boolean): OperationButton[] {
  const stopped = running ? undefined : "Start the simulation first.";
  return [
    ...device.faults.map((fault): OperationButton =>
      fault.active
        ? {
            operation: `clear:${fault.code}`,
            label: `Clear ${fault.name.toLowerCase()}`,
            pendingLabel: "Clearing…",
            disabled: !running,
            title: stopped,
          }
        : {
            operation: `inject:${fault.code}`,
            label: `Inject ${fault.name.toLowerCase()}`,
            pendingLabel: "Injecting…",
            disabled: !running,
            title: stopped ?? (fault.latching ? "Trips the device until it is reset." : undefined),
          },
    ),
    {
      operation: "reset",
      label: "Reset",
      pendingLabel: "Resetting…",
      variant: "ghost",
      disabled: !running || !device.tripped,
      title: stopped ?? (device.tripped ? "Operator reset at the device." : "The device is not tripped."),
    },
  ];
}

function DeviceCard({
  factoryId,
  device,
  running,
}: {
  factoryId: string;
  device: SimulatedDeviceView;
  running: boolean;
}) {
  return (
    <article className="zf-cell" aria-label={device.name}>
      <div className="flex items-center justify-between gap-2">
        <span>
          <b className="mono text-fg-strong">{device.name}</b>
          <span className="zf-k ml-2">{device.type}</span>
        </span>
        <span className="flex items-center gap-1.5">
          {device.quality === "BAD" ? <StatePill tone="flt">bad quality</StatePill> : null}
          {device.faults
            .filter((fault) => fault.active)
            .map((fault) => (
              <StatePill key={fault.code} tone="flt">{`fault · ${fault.name.toLowerCase()}`}</StatePill>
            ))}
          {running ? (
            <StatePill tone={device.faulted ? "flt" : "run"}>
              {`${device.state?.toLowerCase() ?? "running"}${device.tripped ? " · tripped" : ""}`}
            </StatePill>
          ) : (
            <StatePill tone="off">not running</StatePill>
          )}
        </span>
      </div>
      <SectionRule>
        <span className="zf-k">Command / setpoint</span>
        <span className="zf-k text-info">from PLC logic</span>
      </SectionRule>
      <Signals signals={device.inputs} live={running} />
      <SectionRule>
        <span className="zf-k">Actual feedback</span>
        <span className="zf-k text-ok">from simulator</span>
      </SectionRule>
      <Signals signals={device.outputs} live={running} />
      <OperationForm
        label={`Faults of ${device.name}`}
        size="sm"
        action={deviceFaultAction.bind(null, factoryId, device.deviceId)}
        buttons={faultButtons(device, running)}
      />
    </article>
  );
}

/**
 * 2k for a stored factory: start and stop the device simulation, and see what each
 * simulated device gets from PLC logic and what it answers. Faults are injected on the
 * simulated equipment; nothing here writes a PLC tag.
 */
export async function StoredSimulator({ factoryId }: { factoryId: string }) {
  if (!UUID.test(factoryId)) notFound();
  const actor = await requireActor();
  const factory = await getFactory(getDb(), actor, factoryId).catch((error: unknown) => {
    if (isDomainError(error, "NOT_FOUND")) notFound();
    throw error;
  });
  const view = await getSimulationView(getSimulationDeps(), actor, factory.id);
  const faulted = view.devices.filter((device) => device.faulted).length;

  const buttons: OperationButton[] = view.running
    ? [
        {
          operation: "stop",
          label: "Stop simulation",
          pendingLabel: "Stopping…",
          variant: "danger",
          confirm: "Stop the device simulation? The PLCs keep running, but their devices stop answering.",
        },
      ]
    : [
        {
          operation: "start",
          label: "Start simulation",
          pendingLabel: "Starting…",
          variant: "primary",
          disabled: view.blocker !== null,
          title: view.blocker ?? undefined,
        },
      ];

  return (
    <AppShell
      title={`Simulator — ${factory.name}`}
      command={view.running && view.tickMs ? `tick ${view.tickMs} ms` : undefined}
      titleState={<StatePill tone={view.running ? "run" : "off"}>{view.running ? "Simulating" : "Stopped"}</StatePill>}
      activity="factories"
      status={{
        tone: faulted > 0 ? "flt" : view.running ? "ok" : "off",
        left: [`⎇ ${factory.slug}`, "simulator", `${view.devices.length} simulated devices`],
        right: [faulted > 0 ? `${faulted} faulted` : "no faults"],
      }}
    >
      {view.running ? <AutoRefresh intervalMs={2000} /> : null}
      <EditorTabs
        tabs={[
          { label: factory.name, href: routes.factory(factory.id) },
          { label: "Simulator", active: true },
          { label: "Scenarios", href: routes.scenarios(factory.id) },
          { label: "Runtime", href: routes.runtime(factory.id) },
        ]}
        crumb="approximation for control testing · not certification"
      />
      <Content plain>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="zf-k">{`Factory · ${factory.slug}`}</div>
            <h1 className="zf-h mt-1.5">Device simulation</h1>
          </div>
          <OperationForm label="Simulation" action={simulationAction.bind(null, factory.id)} buttons={buttons} />
        </div>
        {view.blocker ? (
          <p className="zf-error" role="alert">
            {view.blocker}
          </p>
        ) : null}
        {view.lastError ? (
          <p className="zf-error" role="alert">
            {view.lastError}
          </p>
        ) : null}
        <div className="grid grid-cols-3 gap-2.5">
          <div className="zf-cell">
            <span className="zf-k">Simulation</span>
            <span className="mono">
              {view.running && view.startedAt ? `running since ${formatUtc(view.startedAt)}` : "not running"}
            </span>
            <span className="mono text-fg-dim">
              {view.running ? `${view.ticks ?? 0} cycles · every ${view.tickMs} ms` : "live values appear once started"}
            </span>
          </div>
          <div className="zf-cell">
            <span className="zf-k">{`PLCs driving devices · ${view.plcs.length}`}</span>
            {view.plcs.length === 0 ? <span className="zf-sub">No device signal is wired to a PLC yet.</span> : null}
            {view.plcs.map((plc) => (
              <span key={plc.id} className="flex items-center justify-between gap-2">
                <Link className="mono" href={routes.plcRuntime(factory.id, plc.id)}>
                  {plc.name}
                </Link>
                <span className="flex items-center gap-1.5">
                  {plc.endpointReady ? null : <StatePill tone="deg">never started</StatePill>}
                  <RuntimeStatePill state={plc.runtimeStatus} />
                </span>
              </span>
            ))}
          </div>
          <div className="zf-cell">
            <span className="zf-k">Control authority</span>
            <span className="zf-sub">
              Devices take commands from PLC logic only. A PLC that is not running drives nothing: its devices see every
              command as off.
            </span>
          </div>
        </div>
        {view.devices.length > 0 ? (
          <div className="grid grid-cols-2 gap-2.5">
            {view.devices.map((device) => (
              <DeviceCard key={device.deviceId} factoryId={factory.id} device={device} running={view.running} />
            ))}
          </div>
        ) : (
          <p className="zf-sub">
            This factory has no simulated devices yet. Add drives, motors, valves or sensors in the designer or from a
            PLC&apos;s Connections.
          </p>
        )}
        {view.skipped.length > 0 ? (
          <>
            <SectionRule>
              <span className="zf-k">{`Not simulated · ${view.skipped.length}`}</span>
            </SectionRule>
            <ul className="zf-sub">
              {view.skipped.map((device) => (
                <li key={device.deviceId}>{`${device.name}: ${device.reason}`}</li>
              ))}
            </ul>
          </>
        ) : null}
        <LlmContextPanel document={buildSimulatorContext({ factory, view })} />
      </Content>
    </AppShell>
  );
}
