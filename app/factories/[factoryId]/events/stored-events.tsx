import Link from "next/link";
import { LiveEventLog } from "@/components/live/live-event-log";
import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs } from "@/components/shell/editor";
import { SideBar, SideSection, Tree } from "@/components/shell/side-bar";
import { OperationForm } from "@/components/ui/operation-form";
import { KeyValue, SectionRule } from "@/components/ui/primitives";
import { StatePill, type Tone } from "@/components/ui/state-pill";
import { getDb } from "@/lib/db/client";
import { alarmCodeLabel, type AlarmState } from "@/lib/domain/alarms";
import { EVENT_FAMILIES, type EventFamily, type EventSeverity } from "@/lib/domain/events";
import { formatUtc } from "@/lib/factories/format";
import { routes } from "@/lib/navigation/routes";
import { countEventsBySeverity, listAlarms, listEvents } from "@/lib/services/event-service";
import { listFactoryDevices } from "@/lib/services/plc-config-service";
import { getLiveDeps } from "@/lib/services/runtime-deps";
import { acknowledgeAlarmAction } from "../live-actions";
import { loadStoredFactory } from "../load-stored-factory";

const SEVERITIES: readonly EventSeverity[] = ["CRITICAL", "WARNING", "INFO"];
const SEVERITY_TONE: Record<EventSeverity, Tone> = { CRITICAL: "flt", WARNING: "deg", INFO: "neutral" };
const DAY_MS = 86_400_000;

const ALARM_STATE: Record<AlarmState, { label: string; tone: Tone }> = {
  ACTIVE_UNACKNOWLEDGED: { label: "active · not acknowledged", tone: "flt" },
  ACTIVE_ACKNOWLEDGED: { label: "active · acknowledged", tone: "deg" },
  CLEARED_UNACKNOWLEDGED: { label: "cleared · not acknowledged", tone: "start" },
  CLEARED: { label: "cleared", tone: "off" },
};

const FAMILY_LABEL: Record<EventFamily, string> = {
  LIFECYCLE: "Lifecycle",
  PROGRAM: "Program",
  DEVICE: "Device state",
  FAULT: "Faults",
  ALARM: "Alarms",
  COMMAND: "Commands",
  LINK: "Connections",
  OTHER: "Other",
};

type Filter = { family?: string; severity?: string; device?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 2m for a stored factory: alarms with their state and acknowledgement, and the
 * recorded event history with new events added as they happen.
 */
export async function StoredEvents({ factoryId, filter }: { factoryId: string; filter: Filter }) {
  const { actor, factory } = await loadStoredFactory(factoryId);
  const db = getDb();
  const family = EVENT_FAMILIES.find((candidate) => candidate === filter.family);
  const severity = SEVERITIES.find((candidate) => candidate === filter.severity);
  const deviceId = filter.device && UUID.test(filter.device) ? filter.device : undefined;

  const [alarms, events, counts, devices] = await Promise.all([
    listAlarms(db, actor, factory.id),
    listEvents(db, actor, factory.id, { family, severities: severity ? [severity] : undefined, deviceId }),
    countEventsBySeverity(db, actor, factory.id, DAY_MS),
    listFactoryDevices(db, actor, factory.id),
  ]);
  const { retention } = getLiveDeps();
  const active = alarms.filter((alarm) => alarm.clearedAt === null);
  const unacknowledged = active.filter((alarm) => alarm.acknowledgedAt === null).length;
  const device = devices.find((candidate) => candidate.id === deviceId);
  const query = (change: Filter) =>
    routes.events(factory.id, { family, severity, device: deviceId, ...change } as Record<string, string | undefined>);

  return (
    <AppShell
      title={`Events — ${factory.name}`}
      titleState={
        <StatePill tone={unacknowledged > 0 ? "flt" : active.length > 0 ? "deg" : "run"}>
          {active.length > 0 ? `${active.length} active alarm${active.length === 1 ? "" : "s"}` : "no active alarms"}
        </StatePill>
      }
      activity="factories"
      sidebar={
        <SideBar title="Events">
          <SideSection title="Event type">
            <Tree
              items={[
                { label: "All types", href: query({ family: undefined }), active: !family },
                ...EVENT_FAMILIES.map((candidate) => ({
                  label: FAMILY_LABEL[candidate],
                  href: query({ family: candidate }),
                  active: candidate === family,
                  level: 1 as const,
                })),
              ]}
            />
          </SideSection>
          <SideSection title="Severity · last 24 h">
            <Tree
              items={[
                { label: "All severities", href: query({ severity: undefined }), active: !severity },
                ...SEVERITIES.map((candidate) => ({
                  label: candidate.charAt(0) + candidate.slice(1).toLowerCase(),
                  meta: counts[candidate],
                  href: query({ severity: candidate }),
                  active: candidate === severity,
                  level: 1 as const,
                })),
              ]}
            />
          </SideSection>
          <SideSection title="Retention">
            <KeyValue
              rows={[
                [
                  "Events",
                  <span key="v" className="mono">{`${Math.round((retention?.eventsMs ?? 0) / DAY_MS)} days`}</span>,
                ],
                [
                  "Telemetry",
                  <span key="v" className="mono">{`${Math.round((retention?.telemetryMs ?? 0) / 3_600_000)} h`}</span>,
                ],
                [
                  "Active alarms",
                  <span key="v" className="mono">
                    kept
                  </span>,
                ],
              ]}
            />
          </SideSection>
        </SideBar>
      }
      status={{
        tone: unacknowledged > 0 ? "flt" : active.length > 0 ? "deg" : "ok",
        left: [`⎇ ${factory.slug}`, "events", `⊗ ${counts.CRITICAL} critical · ⚠ ${counts.WARNING} warning in 24 h`],
        right: ["SSE"],
      }}
    >
      <EditorTabs
        tabs={[
          { label: factory.name, href: routes.factory(factory.id) },
          { label: "Events", active: true },
          { label: "Live Tags", href: routes.tags(factory.id) },
        ]}
        crumb="ALARM_RAISED · ACKNOWLEDGED · CLEARED"
      />
      <Content plain>
        <div>
          <div className="zf-k">{`Factory · ${factory.slug}`}</div>
          <h1 className="zf-h mt-1.5">Alarms &amp; events</h1>
        </div>
        <SectionRule>
          <span className="zf-k">{`Alarms · ${active.length} active`}</span>
        </SectionRule>
        {alarms.length > 0 ? (
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
                <tr key={alarm.id} data-tone={alarm.state === "ACTIVE_UNACKNOWLEDGED" ? "fault" : undefined}>
                  <td>
                    <StatePill tone={SEVERITY_TONE[alarm.severity]}>{alarm.severity.toLowerCase()}</StatePill>
                  </td>
                  <td>
                    <b className="text-fg-strong">{alarm.message}</b>
                    <div className="mono text-fg-dim">
                      {alarm.tagName ? `PLC tag ${alarm.tagName}` : alarmCodeLabel(alarm.code)}
                    </div>
                  </td>
                  <td className="mono">
                    {alarm.deviceId ? (
                      <Link href={query({ device: alarm.deviceId })}>{alarm.deviceName ?? "device"}</Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="mono">
                    {formatUtc(alarm.startedAt)}
                    {alarm.clearedAt ? (
                      <div className="text-fg-dim">{`cleared ${formatUtc(alarm.clearedAt)}`}</div>
                    ) : null}
                  </td>
                  <td>
                    <StatePill tone={ALARM_STATE[alarm.state].tone}>{ALARM_STATE[alarm.state].label}</StatePill>
                  </td>
                  <td>
                    {alarm.acknowledgedAt === null ? (
                      <OperationForm
                        label={`Alarm ${alarm.message}`}
                        size="sm"
                        action={acknowledgeAlarmAction.bind(null, factory.id, alarm.id)}
                        buttons={[{ operation: "acknowledge", label: "Acknowledge", pendingLabel: "Acknowledging…" }]}
                      />
                    ) : (
                      <span className="zf-k">{`ack ${formatUtc(alarm.acknowledgedAt)}`}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="zf-sub">
            No alarms. A device fault, a failed PLC runtime or an alarm tag set by a PLC raises one.
          </p>
        )}
        <p className="zf-sub">
          Acknowledging says an operator has seen the alarm. It does not end it: an alarm clears when its cause is gone.
        </p>
        {family || severity || device ? (
          <p className="zf-k flex flex-wrap items-center gap-2">
            <span>Showing</span>
            {family ? <StatePill>{FAMILY_LABEL[family]}</StatePill> : null}
            {severity ? <StatePill tone={SEVERITY_TONE[severity]}>{severity.toLowerCase()}</StatePill> : null}
            {device ? <StatePill>{device.name}</StatePill> : null}
            <Link href={routes.events(factory.id)}>show everything</Link>
          </p>
        ) : null}
        <LiveEventLog
          events={events}
          streamUrl={routes.stream(factory.id)}
          filter={{ family, severity, deviceId }}
          deviceNames={Object.fromEntries(devices.map((candidate) => [candidate.id, candidate.name]))}
        />
      </Content>
    </AppShell>
  );
}
