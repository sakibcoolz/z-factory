import "server-only";
import { decideGatewayRead, decideGatewayWrite, type GatewayRefusal, type GatewayRegister } from "@/lib/domain/gateway";
import { isDomainError } from "@/lib/domain/errors";
import type { ModbusArea } from "@/lib/domain/tag";
import {
  createModbusServer,
  MODBUS_EXCEPTION,
  ModbusException,
  type ModbusServer,
} from "@/lib/protocols/modbus/server";

/**
 * The endpoints external gateways connect to (ADR-0013). Each enabled gateway connection
 * gets one Modbus TCP listener in the server process. It hands out the registers mapped
 * to that gateway and nothing else: a read of an unmapped address and a write of anything
 * but a writable mapping are refused here, before the PLC is asked.
 *
 * The runtime knows the protocol and the rules. Reading a PLC, writing a tag and
 * recording what happened are the backend's, so the control path stays the tag service's.
 */

export type GatewayEndpointSpec = {
  connectionId: string;
  factoryId: string;
  /** The device instance that stands for the external gateway. */
  gatewayDeviceId: string;
  plcId: string;
  /** Address and port of the Docker host the gateway connects to. */
  host: string;
  port: number;
  unitId: number;
  registers: GatewayRegister[];
};

export type GatewayBackend = {
  /** Raw values of a range of the PLC's registers; fails when the PLC cannot be read. */
  read(spec: GatewayEndpointSpec, area: ModbusArea, address: number, count: number): Promise<Array<number | boolean>>;
  /** Writes one mapped, writable tag from the raw values the gateway sent. */
  write(spec: GatewayEndpointSpec, register: GatewayRegister, raw: Array<number | boolean>): Promise<void>;
  /** A write the rules refused; it reached no PLC. */
  refused(
    spec: GatewayEndpointSpec,
    refusal: { rule: GatewayRefusal; area: ModbusArea; address: number; count: number; register?: GatewayRegister },
  ): Promise<void>;
  /**
   * An edge device started or stopped talking to the endpoint. A device that opens a
   * connection per request is one visit, not one per request.
   */
  client(spec: GatewayEndpointSpec, event: "connected" | "disconnected", remoteAddress: string): void;
};

export type GatewayEndpointStatus = {
  listening: boolean;
  /** Why the endpoint is not listening, when it should be. */
  error: string | null;
  /** Edge devices talking to the endpoint now, by address. */
  clients: number;
  requests: number;
  refused: number;
  lastRequestAt: string | null;
};

/** One edge device at an endpoint: its open connections and the wait before it counts as gone. */
type Visit = { open: number; leaving: ReturnType<typeof setTimeout> | null };

type Endpoint = {
  spec: GatewayEndpointSpec;
  signature: string;
  server: ModbusServer | null;
  status: GatewayEndpointStatus;
  backend: GatewayBackend;
  visits: Map<string, Visit>;
};

/** How long a device may be silent between two connections and still be the same visit. */
const DEFAULT_VISIT_QUIET_MS = 15_000;

const STOPPED: GatewayEndpointStatus = {
  listening: false,
  error: null,
  clients: 0,
  requests: 0,
  refused: 0,
  lastRequestAt: null,
};

/** What makes a listener have to be opened anew: where it listens and for whom. */
const signatureOf = (spec: GatewayEndpointSpec) => `${spec.host}:${spec.port}/${spec.unitId}`;

export class GatewayEndpointRuntime {
  private readonly endpoints = new Map<string, Endpoint>();
  private readonly visitQuietMs: number;

  constructor(options: { visitQuietMs?: number } = {}) {
    this.visitQuietMs = options.visitQuietMs ?? DEFAULT_VISIT_QUIET_MS;
  }

  /** Turns connections into visits: the first one of a device is its arrival, a silence its leaving. */
  private track(endpoint: Endpoint, event: "connected" | "disconnected", remoteAddress: string): void {
    const visit = endpoint.visits.get(remoteAddress);
    if (event === "connected") {
      if (visit) {
        if (visit.leaving) clearTimeout(visit.leaving);
        visit.leaving = null;
        visit.open += 1;
        return;
      }
      endpoint.visits.set(remoteAddress, { open: 1, leaving: null });
      endpoint.backend.client(endpoint.spec, "connected", remoteAddress);
      return;
    }
    if (!visit) return;
    visit.open = Math.max(0, visit.open - 1);
    if (visit.open > 0 || visit.leaving) return;
    visit.leaving = setTimeout(() => {
      if (endpoint.visits.get(remoteAddress) !== visit) return;
      endpoint.visits.delete(remoteAddress);
      endpoint.backend.client(endpoint.spec, "disconnected", remoteAddress);
    }, this.visitQuietMs);
    // A pending goodbye must not keep the server process alive.
    visit.leaving.unref?.();
  }

  /**
   * Brings the endpoint of a connection in line with its configuration: opens it,
   * moves it when its address changed, and takes over a changed register map at once.
   */
  async ensure(spec: GatewayEndpointSpec, backend: GatewayBackend): Promise<GatewayEndpointStatus> {
    const existing = this.endpoints.get(spec.connectionId);
    if (existing?.server && existing.signature === signatureOf(spec)) {
      existing.spec = spec;
      return this.status(spec.connectionId);
    }
    if (existing) await this.stop(spec.connectionId);

    const endpoint: Endpoint = {
      spec,
      signature: signatureOf(spec),
      server: null,
      status: { ...STOPPED },
      backend,
      visits: new Map(),
    };
    this.endpoints.set(spec.connectionId, endpoint);
    const count = (refused = false) => {
      endpoint.status.requests += 1;
      if (refused) endpoint.status.refused += 1;
      endpoint.status.lastRequestAt = new Date().toISOString();
    };
    const fromPlc = async <Result>(action: () => Promise<Result>): Promise<Result> => {
      try {
        return await action();
      } catch (error) {
        // A tag the PLC side refuses is the gateway's mistake; anything else is a PLC that does not answer.
        const refusedByRule = isDomainError(error, "INVARIANT") || isDomainError(error, "VALIDATION");
        throw new ModbusException(
          refusedByRule ? MODBUS_EXCEPTION.ILLEGAL_DATA_VALUE : MODBUS_EXCEPTION.GATEWAY_TARGET_FAILED,
        );
      }
    };

    const server = createModbusServer({
      unitId: spec.unitId,
      onClient: (event, remoteAddress) => this.track(endpoint, event, remoteAddress),
      handler: {
        read: async (area, address, quantity) => {
          const current = endpoint.spec;
          const decision = decideGatewayRead(current.registers, area, address, quantity);
          count(!decision.allowed);
          if (!decision.allowed) throw new ModbusException(MODBUS_EXCEPTION.ILLEGAL_DATA_ADDRESS);
          return fromPlc(() => backend.read(current, area, address, quantity));
        },
        write: async (area, address, values) => {
          const current = endpoint.spec;
          const decision = decideGatewayWrite(current.registers, area, address, values.length);
          count(!decision.allowed);
          if (!decision.allowed) {
            await backend
              .refused(current, {
                rule: decision.rule,
                area,
                address,
                count: values.length,
                register: decision.register,
              })
              .catch(() => undefined);
            throw new ModbusException(MODBUS_EXCEPTION.ILLEGAL_DATA_ADDRESS);
          }
          for (const register of decision.registers) {
            const offset = register.address - address;
            await fromPlc(() => backend.write(current, register, values.slice(offset, offset + register.wordCount)));
          }
        },
      },
    });
    try {
      await server.listen(spec.host, spec.port);
      endpoint.server = server;
      endpoint.status.listening = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      endpoint.status.error =
        code === "EADDRINUSE"
          ? "The port is in use by another program on this host."
          : code === "EADDRNOTAVAIL"
            ? "This host has no network interface with that address."
            : "The endpoint could not be opened.";
    }
    return this.status(spec.connectionId);
  }

  async stop(connectionId: string): Promise<void> {
    const endpoint = this.endpoints.get(connectionId);
    if (!endpoint) return;
    this.endpoints.delete(connectionId);
    // Whoever was talking to the endpoint is gone with it.
    for (const [remoteAddress, visit] of endpoint.visits) {
      if (visit.leaving) clearTimeout(visit.leaving);
      endpoint.backend.client(endpoint.spec, "disconnected", remoteAddress);
    }
    endpoint.visits.clear();
    await endpoint.server?.close();
  }

  /** Closes every endpoint of a factory that is not in the list: removed or disabled connections. */
  async stopOthers(factoryId: string, keep: ReadonlySet<string>): Promise<void> {
    const stale = [...this.endpoints.values()].filter(
      (endpoint) => endpoint.spec.factoryId === factoryId && !keep.has(endpoint.spec.connectionId),
    );
    await Promise.all(stale.map((endpoint) => this.stop(endpoint.spec.connectionId)));
  }

  status(connectionId: string): GatewayEndpointStatus {
    const endpoint = this.endpoints.get(connectionId);
    if (!endpoint) return { ...STOPPED };
    return { ...endpoint.status, clients: endpoint.visits.size };
  }

  /** The port an endpoint really listens on (a test may ask for any free port with 0). */
  port(connectionId: string): number | null {
    return this.endpoints.get(connectionId)?.server?.port() ?? null;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.endpoints.keys()].map((connectionId) => this.stop(connectionId)));
  }
}

const globalRuntime = globalThis as typeof globalThis & { zfactoryGatewayEndpoints?: GatewayEndpointRuntime };

/** The shared endpoints of this server process (kept across development reloads). */
export function getGatewayEndpoints(): GatewayEndpointRuntime {
  globalRuntime.zfactoryGatewayEndpoints ??= new GatewayEndpointRuntime();
  return globalRuntime.zfactoryGatewayEndpoints;
}
