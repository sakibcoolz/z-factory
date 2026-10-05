"use server";

import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/auth/actor";
import { DomainError, isDomainError } from "@/lib/domain/errors";
import { routes } from "@/lib/navigation/routes";
import { type OperationState, toOperationState } from "@/lib/plc/operation-state";
import { acknowledgeAlarm } from "@/lib/services/event-service";
import { getLiveDeps, getRuntimeDeps } from "@/lib/services/runtime-deps";
import { writeTag } from "@/lib/services/tag-service";

/**
 * Operator actions on the live screens: writing a command or setpoint tag, and
 * acknowledging an alarm. A write goes to the PLC tag and nowhere else: what a device
 * then does is decided by PLC logic and shows up in its feedback tags.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function logUnexpected(action: string, error: unknown) {
  if (!isDomainError(error)) console.error(JSON.stringify({ level: "error", action, error: String(error) }));
}

/** `true` / `false` for a BOOL tag, a number otherwise. The tag service checks type and range. */
function parseValue(raw: FormDataEntryValue | null): number | boolean {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "true") return true;
  if (text === "false") return false;
  const number = Number(text.replace(",", "."));
  if (text === "" || !Number.isFinite(number)) {
    throw new DomainError("VALIDATION", "Enter a number.", { rule: "tag-value" });
  }
  return number;
}

export async function writeTagAction(
  factoryId: string,
  plcId: string,
  tagName: string,
  _previous: OperationState,
  formData: FormData,
): Promise<OperationState> {
  try {
    const actor = await requireActor();
    if (!UUID.test(plcId)) throw new DomainError("NOT_FOUND", "The PLC does not exist.");
    const value = parseValue(formData.get("value"));
    await writeTag(getRuntimeDeps(), actor, plcId, tagName, value, "UI");
    return {
      notice: `Accepted by the PLC: ${tagName} = ${typeof value === "boolean" ? (value ? "ON" : "OFF") : value}. PLC logic decides what follows.`,
    };
  } catch (error) {
    logUnexpected("tag.write", error);
    return toOperationState(error);
  }
}

export async function acknowledgeAlarmAction(
  factoryId: string,
  alarmId: string,
  _previous: OperationState,
): Promise<OperationState> {
  try {
    const actor = await requireActor();
    if (!UUID.test(alarmId)) throw new DomainError("NOT_FOUND", "The alarm does not exist.");
    const { db, bus } = getLiveDeps();
    await acknowledgeAlarm({ db, bus }, actor, alarmId);
    return { notice: "Acknowledged." };
  } catch (error) {
    logUnexpected("alarm.acknowledge", error);
    return toOperationState(error);
  } finally {
    revalidatePath(routes.events(factoryId));
  }
}
