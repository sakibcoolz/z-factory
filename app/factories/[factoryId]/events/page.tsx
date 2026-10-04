import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs, Panel } from "@/components/shell/editor";
import { SideBar, SideSection } from "@/components/shell/side-bar";
import { Button } from "@/components/ui/button";
import { KeyValue, Log, type LogLevel } from "@/components/ui/primitives";
import { RuntimeStatePill, StatePill } from "@/components/ui/state-pill";
import { demoContext, isDemoFactory } from "@/lib/fixtures";
import { events, factory } from "@/lib/fixtures/pump-house-demo";

export const metadata: Metadata = { title: "Events" };

type EventsPageProps = {
  params: Promise<{ factoryId: string }>;
};

const LEVEL_LABEL: Record<LogLevel, string> = { info: "EVENT", warn: "WARN", crit: "CRIT" };

/** 2m — Events / Alarms / Logs: alarm list with acknowledge, typed event stream. */
export default async function EventsPage({ params }: EventsPageProps) {
  const { factoryId } = await params;
  if (!isDemoFactory(factoryId)) notFound();

  const { severity, alarms, stream } = events;
  const total = severity.critical + severity.warning + severity.info;

  return (
    <AppShell
      title={`Events — ${factory.name}`}
      command="filter type, device, severity…"
      titleState={<RuntimeStatePill state={events.state} />}
      activity="events"
      context={demoContext}
      badges={{ events: alarms.length }}
      sidebar={
        <SideBar title="Events">
          <SideSection title="Event types">
            <div className="zf-chips">
              {events.typeFilters.map((filter) => (
                <StatePill key={filter.label} tone={filter.tone}>
                  {filter.label}
                </StatePill>
              ))}
            </div>
          </SideSection>
          <SideSection title="Severity">
            <KeyValue
              rows={[
                [
                  "Critical",
                  <span key="v" className="mono text-fault-fg">
                    {severity.critical}
                  </span>,
                ],
                [
                  "Warning",
                  <span key="v" className="mono text-warn-fg">
                    {severity.warning}
                  </span>,
                ],
                [
                  "Info",
                  <span key="v" className="mono">
                    {severity.info}
                  </span>,
                ],
              ]}
            />
          </SideSection>
          <SideSection title="Retention">
            <KeyValue
              rows={events.retention.map(
                ([label, value]) =>
                  [
                    label,
                    <span key="v" className="mono">
                      {value}
                    </span>,
                  ] as const,
              )}
            />
          </SideSection>
        </SideBar>
      }
      status={{
        tone: "deg",
        left: [`⊗ ${severity.critical} critical`, `⚠ ${severity.warning} warning`, `${total} events`],
        right: ["SSE"],
      }}
    >
      <EditorTabs
        tabs={[{ label: "Alarms", active: true }, { label: "Events" }, { label: "Logs" }]}
        crumb="ALARM_RAISED · ACKNOWLEDGED · CLEARED"
      />
      <Content plain flush className="flex-none">
        <table className="zf-tbl">
          <thead>
            <tr>
              <th>Sev</th>
              <th>Alarm</th>
              <th>Device</th>
              <th>Raised</th>
              <th>State</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {alarms.map((alarm) => (
              <tr key={alarm.title} data-tone={alarm.status === "unacked" ? "fault" : undefined}>
                <td>
                  <StatePill tone={alarm.tone}>{alarm.severity}</StatePill>
                </td>
                <td>
                  <b className="text-fg-strong">{alarm.title}</b>
                  <div className="mono text-fg-dim">{alarm.detail}</div>
                </td>
                <td className="mono">{alarm.device}</td>
                <td className="mono">{alarm.raised}</td>
                <td>
                  <StatePill tone={alarm.tone}>{alarm.status}</StatePill>
                </td>
                <td>
                  <Button size="sm" variant={alarm.status === "unacked" ? "default" : "ghost"}>
                    {alarm.action}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Content>
      <Panel
        grow
        tabs={["Problems", "Event stream", "Container logs"]}
        active="Event stream"
        end={<StatePill tone="run">live</StatePill>}
      >
        <Log
          rows={stream.map((event) => ({
            time: event.time,
            level: event.level,
            label: LEVEL_LABEL[event.level],
            message: (
              <>
                <span className="syn-type">{event.type}</span> {event.detail}
              </>
            ),
          }))}
        />
      </Panel>
    </AppShell>
  );
}
