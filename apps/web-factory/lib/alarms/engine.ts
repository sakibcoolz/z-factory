import "server-only";
import { type AlarmCondition, type AlarmFacts, desiredAlarms } from "@/lib/domain/alarms";
import type { ConnectivityLimits } from "@/lib/domain/connectivity";
import { shownValue } from "@/lib/domain/telemetry";
import { Prisma, type PrismaClient } from "@/lib/generated/prisma/client";

/**
 * The alarm sweep (TASK-904, ADR-0021): every few seconds it compares the alarms that
 * should be active (lib/domain/alarms.ts) with those that are, raises what is missing,
 * clears what ended and updates a changed message. One active alarm per condition is kept
 * by the database (`activeKey` is unique), so several Web Factory processes may sweep at
 * once, and a sweep can be repeated.
 */

export type SweepResult = { raised: number; cleared: number; updated: number };

export type SweepOptions = {
  now?: Date;
  limits?: ConnectivityLimits;
  /**
   * Whether connectivity can be judged: false while Web Factory itself is not (or not yet
   * long enough) connected to the broker, when every agent would look silent. Connection
   * alarms are then left as they are; tag alarms are still judged.
   */
  judgeConnectivity?: boolean;
};

export async function loadAlarmFacts(db: PrismaClient): Promise<AlarmFacts[]> {
  const agents = await db.edgeAgent.findMany({
    include: {
      site: { select: { organizationId: true } },
      plcs: {
        select: {
          id: true,
          name: true,
          edgeState: true,
          edgeLastError: true,
          mappings: { where: { role: "ALARM" }, select: { externalId: true, name: true } },
          latest: { select: { tag: true, valueNum: true, valueBool: true } },
        },
      },
    },
  });
  return agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    organizationId: agent.site.organizationId,
    siteId: agent.siteId,
    status: agent.status,
    lastSeenAt: agent.lastSeenAt,
    heartbeat: agent.heartbeatJson,
    credentialRevokedAt: agent.credentialRevokedAt,
    plcs: agent.plcs.map((plc) => {
      const latest = new Map(plc.latest.map((row) => [row.tag, row]));
      return {
        id: plc.id,
        name: plc.name,
        edgeState: plc.edgeState,
        edgeLastError: plc.edgeLastError,
        alarmTags: plc.mappings.map((mapping) => {
          const row = latest.get(mapping.externalId);
          return {
            tag: mapping.externalId,
            name: mapping.name,
            value: row ? shownValue({ num: row.valueNum, bool: row.valueBool }) : null,
          };
        }),
      };
    }),
  }));
}

export async function sweepAlarms(db: PrismaClient, options: SweepOptions = {}): Promise<SweepResult> {
  const now = options.now ?? new Date();
  const judgeConnectivity = options.judgeConnectivity ?? true;
  const desired = desiredAlarms(await loadAlarmFacts(db), now, { limits: options.limits, judgeConnectivity });
  const wanted = new Map<string, AlarmCondition>(desired.map((alarm) => [alarm.key, alarm]));
  const active = await db.alarm.findMany({ where: { activeKey: { not: null } } });
  const result: SweepResult = { raised: 0, cleared: 0, updated: 0 };

  for (const alarm of active) {
    const key = alarm.activeKey!;
    const condition = wanted.get(key);
    if (!condition) {
      // A connection alarm stays while connectivity cannot be judged.
      if (!judgeConnectivity && alarm.source !== "PLC_TAG") continue;
      const { count } = await db.alarm.updateMany({
        where: { id: alarm.id, activeKey: key },
        data: { activeKey: null, clearedAt: now },
      });
      result.cleared += count;
      continue;
    }
    wanted.delete(key);
    if (condition.message !== alarm.message || condition.severity !== alarm.severity) {
      await db.alarm.update({
        where: { id: alarm.id },
        data: { message: condition.message, severity: condition.severity },
      });
      result.updated += 1;
    }
  }

  for (const condition of wanted.values()) {
    try {
      await db.alarm.create({
        data: {
          organizationId: condition.organizationId,
          siteId: condition.siteId,
          agentId: condition.agentId,
          plcId: condition.plcId,
          source: condition.source,
          subject: condition.subject,
          severity: condition.severity,
          message: condition.message,
          activeKey: condition.key,
          raisedAt: now,
        },
      });
      result.raised += 1;
    } catch (error) {
      // Another sweep raised it first.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
    }
  }
  return result;
}
