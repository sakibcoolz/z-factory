import type { Metadata } from "next";
import Link from "next/link";
import { BrokerBanner } from "@/components/connectivity";
import { AlarmTable, LiveOrgAlarms } from "@/components/live-alarms";
import { can } from "@/lib/auth/roles";
import { requireActor } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { toJson } from "@/lib/live/json";
import { brokerStatus, connectivityLimits } from "@/lib/mqtt/boundary";
import { load } from "@/lib/page";
import { listAlarms } from "@/lib/services/alarm-service";
import { liveView } from "@/lib/services/live-service";

export const metadata: Metadata = { title: "Alarms" };
export const dynamic = "force-dynamic";

const RANGES = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 } as const;

/** An organization's alarms: active ones live, and the history of a range. */
export default async function AlarmsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const { orgId } = await params;
  const { range: requested } = await searchParams;
  const range = requested && requested in RANGES ? (requested as keyof typeof RANGES) : "24h";
  const actor = await requireActor();
  const now = new Date();
  const live = await load(liveView(getDb(), actor, { kind: "org", id: orgId }, connectivityLimits(), now));
  const history = await listAlarms(getDb(), actor, orgId, {
    state: "history",
    from: new Date(now.getTime() - RANGES[range]).toISOString(),
    limit: 500,
  });
  const organization = await getDb().organization.findUniqueOrThrow({ where: { id: orgId } });
  const canAcknowledge = can(live.role, "command");
  return (
    <>
      <div>
        <div className="crumbs">
          <Link href={`/orgs/${organization.id}`}>{organization.name}</Link>
          <span>/</span>
          <span>Alarms</span>
        </div>
        <h1>Alarms</h1>
        <p className="muted">
          Raised by PLC alarm tags (the PLC program decides), by a PLC whose connection is down and by an agent that is
          offline or degraded. {canAcknowledge ? "" : "Operators and admins acknowledge them."}
        </p>
      </div>
      <BrokerBanner broker={brokerStatus()} />
      <LiveOrgAlarms initial={toJson(live)} canAcknowledge={canAcknowledge} />
      <section className="card" aria-label="History">
        <div className="row">
          <h2>History</h2>
          {(Object.keys(RANGES) as Array<keyof typeof RANGES>).map((key) => (
            <Link
              key={key}
              href={`?range=${key}`}
              className={key === range ? "pill ok" : "pill"}
              aria-current={key === range}
            >
              {key === "24h" ? "24 h" : key === "7d" ? "7 days" : "30 days"}
            </Link>
          ))}
        </div>
        <AlarmTable
          alarms={toJson(history.alarms)}
          now={now.getTime()}
          canAcknowledge={false}
          showSite
          empty="No alarm raised in this range."
        />
      </section>
    </>
  );
}
