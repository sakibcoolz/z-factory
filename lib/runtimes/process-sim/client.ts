import "server-only";
import { DomainError } from "@/lib/domain/errors";
import type {
  DeviceSimConfig,
  DeviceSimDeviceConfig,
  DeviceSimDeviceSnapshot,
  DeviceSimEvent,
  DeviceSimProfile,
  DeviceSimRegisterMap,
  DeviceSimSnapshot,
  DeviceSimSummary,
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

type Problem = { error: string; code: string; rule?: string };

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
          // The service prefixes its refusals; the reason itself is what a person needs. The
          // device runtime names the rule it applied (TASK-1009); the process engine does not.
          throw new DomainError("VALIDATION", message.replace(/^invalid configuration: /, ""), {
            rule: problem?.rule ?? "process-sim-configuration",
          });
        case "wrong-state":
          throw new DomainError("CONFLICT", message, { rule: problem?.rule ?? "process-sim-state" });
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
  const factory = (id: string) => `/v1/factories/${encodeURIComponent(id)}`;
  const device = (factoryId: string, deviceId: string) =>
    `${factory(factoryId)}/devices/${encodeURIComponent(deviceId)}`;

  /** The catalog device runtime (TASK-1009): factories of devices, each with its behaviour profile. */
  const devices = {
    profiles: () => request<{ profiles: DeviceSimProfile[] }>("GET", "/v1/profiles").then((body) => body.profiles),
    profile: (key: string) => request<DeviceSimProfile>("GET", `/v1/profiles/${encodeURIComponent(key)}`),
    registerMaps: () =>
      request<{ registerMaps: DeviceSimRegisterMap[] }>("GET", "/v1/register-maps").then((body) => body.registerMaps),
    registerMap: (key: string) => request<DeviceSimRegisterMap>("GET", `/v1/register-maps/${encodeURIComponent(key)}`),
    list: () => request<{ factories: DeviceSimSummary[] }>("GET", "/v1/factories").then((body) => body.factories),
    load: (config: DeviceSimConfig) => request<DeviceSimSnapshot>("PUT", factory(config.factoryId), config),
    inspect: (factoryId: string) => request<DeviceSimSnapshot>("GET", factory(factoryId)),
    unload: (factoryId: string) => request<void>("DELETE", factory(factoryId)),
    start: (factoryId: string) => request<DeviceSimSnapshot>("POST", `${factory(factoryId)}/start`),
    stop: (factoryId: string) => request<DeviceSimSnapshot>("POST", `${factory(factoryId)}/stop`),
    reset: (factoryId: string) => request<DeviceSimSnapshot>("POST", `${factory(factoryId)}/reset`),
    step: (factoryId: string, ticks = 1) =>
      request<DeviceSimSnapshot>("POST", `${factory(factoryId)}/step?ticks=${ticks}`),
    events: (factoryId: string, after = 0) =>
      request<{ events: DeviceSimEvent[] }>("GET", `${factory(factoryId)}/events?after=${after}`).then(
        (body) => body.events,
      ),
    upsertDevice: (factoryId: string, config: DeviceSimDeviceConfig) =>
      request<DeviceSimSnapshot>("PUT", device(factoryId, config.deviceId), config),
    device: (factoryId: string, deviceId: string) =>
      request<DeviceSimDeviceSnapshot>("GET", device(factoryId, deviceId)),
    removeDevice: (factoryId: string, deviceId: string) =>
      request<DeviceSimSnapshot>("DELETE", device(factoryId, deviceId)),
    setInputs: (factoryId: string, deviceId: string, inputs: Record<string, number>) =>
      request<DeviceSimDeviceSnapshot>("PUT", `${device(factoryId, deviceId)}/inputs`, inputs),
    injectFault: (factoryId: string, deviceId: string, code: string) =>
      request<DeviceSimDeviceSnapshot>("POST", `${device(factoryId, deviceId)}/faults/${encodeURIComponent(code)}`),
    clearFault: (factoryId: string, deviceId: string, code: string) =>
      request<DeviceSimDeviceSnapshot>("DELETE", `${device(factoryId, deviceId)}/faults/${encodeURIComponent(code)}`),
    resetDevice: (factoryId: string, deviceId: string) =>
      request<DeviceSimDeviceSnapshot>("POST", `${device(factoryId, deviceId)}/reset`),
    force: (factoryId: string, deviceId: string, value: number | null) =>
      value === null
        ? request<DeviceSimDeviceSnapshot>("DELETE", `${device(factoryId, deviceId)}/force`)
        : request<DeviceSimDeviceSnapshot>("PUT", `${device(factoryId, deviceId)}/force`, { value }),
  };

  return {
    devices,
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
