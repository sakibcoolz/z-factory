import "server-only";
import { DomainError } from "@/lib/domain/errors";
import type {
  ProcessSimConfig,
  ProcessSimEvent,
  ProcessSimHealth,
  ProcessSimMetrics,
  ProcessSimOverrideRequest,
  ProcessSimSignalState,
  ProcessSimSnapshot,
} from "@/lib/domain/process-sim";

/**
 * The server's client of the process simulation service (docs/process-simulation.md).
 * Server-only: the token is sent by this module alone, and nothing under `app/` calls the
 * service from a browser. The service's refusals come back as domain errors.
 */

export type ProcessSimClient = ReturnType<typeof createProcessSimClient>;

type Problem = { error: string; code: string };

export function createProcessSimClient(options: {
  url: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}) {
  const base = options.url.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5000;

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${options.token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new DomainError("RUNTIME_FAILURE", "The process simulation service cannot be reached.", {
        rule: "process-sim-unreachable",
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as unknown) : undefined;
    if (!response.ok) {
      const problem = parsed as Problem | undefined;
      const message = problem?.error ?? `The process simulation service answered ${response.status}.`;
      switch (problem?.code) {
        case "not-found":
          throw new DomainError("NOT_FOUND", message, { rule: "process-sim" });
        case "invalid-configuration":
          throw new DomainError("VALIDATION", message, { rule: "process-sim-configuration" });
        case "wrong-state":
          throw new DomainError("CONFLICT", message, { rule: "process-sim-state" });
        case "unauthorized":
          throw new DomainError("RUNTIME_FAILURE", "The process simulation service refused the token.", {
            rule: "process-sim-token",
          });
        default:
          throw new DomainError("RUNTIME_FAILURE", message, { rule: "process-sim", status: response.status });
      }
    }
    return parsed as T;
  }

  const instance = (id: string) => `/v1/instances/${encodeURIComponent(id)}`;

  return {
    health: () => request<ProcessSimHealth>("GET", "/healthz"),
    metrics: () => request<ProcessSimMetrics>("GET", "/metrics"),
    list: () => request<{ instances: ProcessSimSnapshot[] }>("GET", "/v1/instances").then((body) => body.instances),
    load: (config: ProcessSimConfig) => request<ProcessSimSnapshot>("PUT", instance(config.instanceId), config),
    inspect: (id: string) => request<ProcessSimSnapshot>("GET", instance(id)),
    unload: (id: string) => request<void>("DELETE", instance(id)),
    start: (id: string) => request<ProcessSimSnapshot>("POST", `${instance(id)}/start`),
    stop: (id: string) => request<ProcessSimSnapshot>("POST", `${instance(id)}/stop`),
    reset: (id: string) => request<ProcessSimSnapshot>("POST", `${instance(id)}/reset`),
    step: (id: string, ticks = 1) => request<ProcessSimSnapshot>("POST", `${instance(id)}/step?ticks=${ticks}`),
    setInputs: (id: string, inputs: Record<string, number>) =>
      request<ProcessSimSnapshot>("PUT", `${instance(id)}/inputs`, inputs),
    overrides: (id: string) =>
      request<{ signals: ProcessSimSignalState[] }>("GET", `${instance(id)}/overrides`).then((body) => body.signals),
    setOverride: (id: string, signal: string, override: ProcessSimOverrideRequest) =>
      request<ProcessSimSignalState>("PUT", `${instance(id)}/overrides/${encodeURIComponent(signal)}`, override),
    clearOverride: (id: string, signal: string, source?: string) =>
      request<ProcessSimSignalState>(
        "DELETE",
        `${instance(id)}/overrides/${encodeURIComponent(signal)}${source ? `?source=${encodeURIComponent(source)}` : ""}`,
      ),
    events: (id: string, after = 0) =>
      request<{ events: ProcessSimEvent[] }>("GET", `${instance(id)}/events?after=${after}`).then(
        (body) => body.events,
      ),
  };
}
