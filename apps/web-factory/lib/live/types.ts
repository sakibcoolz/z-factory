/**
 * The live views as the browser receives them (JSON: times are ISO strings). Types only:
 * nothing here runs, so client components may import it without reaching a server module.
 */
import type { LiveView } from "@/lib/services/live-service";

/** A value after JSON.stringify and JSON.parse. */
export type Jsonify<T> = T extends Date
  ? string
  : T extends Array<infer U>
    ? Array<Jsonify<U>>
    : T extends object
      ? { [K in keyof T]: Jsonify<T[K]> }
      : T;

export type LiveViewJson = Jsonify<LiveView>;
export type PlcLiveView = Extract<LiveViewJson, { plc: unknown }>;
export type AgentLiveView = Extract<LiveViewJson, { agent: unknown }>;
export type SiteLiveView = Extract<LiveViewJson, { agents: unknown }>;
export type AlarmJson = LiveViewJson["alarms"][number];
