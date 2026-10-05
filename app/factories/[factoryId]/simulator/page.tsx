import type { Metadata } from "next";
import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs, Panel } from "@/components/shell/editor";
import { SideBar, SideSection, Tree } from "@/components/shell/side-bar";
import { Button } from "@/components/ui/button";
import { Gauge, KeyValue, SectionRule, Spark } from "@/components/ui/primitives";
import { RuntimeStatePill, StatePill } from "@/components/ui/state-pill";
import { demoContext, isDemoFactory } from "@/lib/fixtures";
import { devices, factory, simulator } from "@/lib/fixtures/pump-house-demo";
import { routes } from "@/lib/navigation/routes";
import { StoredSimulator } from "./stored-simulator";

export const metadata: Metadata = { title: "Simulator" };

// Stored factories read the database and the simulator on every request.
export const dynamic = "force-dynamic";

type SimulatorPageProps = {
  params: Promise<{ factoryId: string }>;
};

/**
 * 2k — Simulator / Debug. Command/setpoint values (from PLC logic) and actual feedback
 * (from the device simulator) are deliberately separate sections.
 */
export default async function SimulatorPage({ params }: SimulatorPageProps) {
  const { factoryId } = await params;
  // Stored factories show their real simulation; the demo factory keeps its fixture screen.
  if (!isDemoFactory(factoryId)) return StoredSimulator({ factoryId });

  const device = simulator.selectedDevice;

  return (
    <AppShell
      title={`Simulator — ${factory.name}`}
      command={simulator.tick}
      titleState={<RuntimeStatePill state={simulator.state} />}
      activity="runtime"
      context={demoContext}
      sidebar={
        <SideBar title="Devices">
          <Tree
            items={devices.map((item) => ({
              label: item.name,
              meta: item.external ? "ext" : item.kind,
              active: item.name === device,
            }))}
          />
          <SideSection title="Fault injection · explicit & audited">
            <Tree items={simulator.faultInjections.map((fault) => ({ label: `⚡ ${fault}` }))} />
          </SideSection>
        </SideBar>
      }
      status={{
        left: [
          `simulator ${simulator.tick}`,
          `${simulator.summary.stateMachines} state machines · ${simulator.summary.processes} process`,
        ],
        right: [`faults ${simulator.summary.faults}`],
      }}
    >
      <EditorTabs
        tabs={[
          { label: `Simulator · ${device}`, active: true },
          { label: "Runtime", href: routes.runtime(factoryId) },
        ]}
        crumb="approximation for control testing · not certification"
      />
      <Content plain>
        <SectionRule>
          <span className="zf-k">{`${device} · command / setpoint`}</span>
          <span className="zf-k text-info">from PLC logic</span>
        </SectionRule>
        <div className="grid grid-cols-4 gap-2.5">
          {simulator.commands.map((command) => (
            <div key={command.label} className="zf-cell">
              <span className="zf-k">{command.label}</span>
              <span className="mono syn-num text-stat">{command.value}</span>
              {command.source ? <span className="mono text-fg-dim">{command.source}</span> : null}
              {command.percent !== undefined ? <Gauge percent={command.percent} label={command.label} /> : null}
            </div>
          ))}
        </div>
        <SectionRule>
          <span className="zf-k">{`${device} · actual feedback`}</span>
          <span className="zf-k text-ok">from simulator</span>
        </SectionRule>
        <div className="grid grid-cols-5 gap-2.5">
          {simulator.feedback.map((value) => (
            <div key={value.label} className="zf-cell">
              <span className="zf-k">{value.label}</span>
              <span className="mono text-stat text-ok">{value.value}</span>
              <Spark trend={value.trend} />
            </div>
          ))}
          <div className="zf-cell">
            <span className="zf-k">Status</span>
            <StatePill tone="run">{simulator.status.label}</StatePill>
            <span className="mono text-fg-dim">{simulator.status.ramp}</span>
          </div>
          <div className="zf-cell">
            <span className="zf-k">Fault</span>
            <StatePill tone="off">none</StatePill>
            <Button size="sm" variant="danger" className="mt-0.5 w-max">
              Inject overcurrent
            </Button>
          </div>
        </div>
        <SectionRule>
          <span className="zf-k">Downstream · one VFD drives one motor</span>
        </SectionRule>
        <div className="grid grid-cols-2 gap-2.5">
          <div className="zf-cell">
            <div className="flex justify-between">
              <span className="zf-k">MOTOR-01</span>
              <RuntimeStatePill state="RUNNING" dot />
            </div>
            <KeyValue
              bare
              rows={[
                [
                  "RPM setpoint / actual",
                  <span key="v" className="mono">
                    1450 / <span className="text-ok">1438</span>
                  </span>,
                ],
                [
                  "Current · torque",
                  <span key="v" className="mono">
                    6.2 A · 71 %
                  </span>,
                ],
                [
                  "Temperature",
                  <span key="v" className="mono">
                    58 °C
                  </span>,
                ],
              ]}
            />
          </div>
          <div className="zf-cell">
            <div className="flex justify-between">
              <span className="zf-k">PUMP-01</span>
              <RuntimeStatePill state="RUNNING" dot />
            </div>
            <KeyValue
              bare
              rows={[
                [
                  "Run status",
                  <span key="v" className="mono syn-num">
                    RUNNING
                  </span>,
                ],
                [
                  "Flow · pressure",
                  <span key="v" className="mono">
                    14.2 m³/h · <span className="text-ok">3.1 bar</span>
                  </span>,
                ],
                [
                  "→ PT-101 feedback",
                  <span key="v" className="mono">
                    3.08 bar · GOOD
                  </span>,
                ],
              ]}
            />
          </div>
        </div>
      </Content>
      <Panel tabs={["Watch", "Loop trace", "Audit"]} active="Loop trace">
        <div className="zf-log">{simulator.loopTrace}</div>
      </Panel>
    </AppShell>
  );
}
