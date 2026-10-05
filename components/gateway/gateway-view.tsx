import type { ReactNode } from "react";
import { FieldsForm } from "@/components/ui/fields-form";
import { type OperationButton, OperationForm } from "@/components/ui/operation-form";
import { SectionRule } from "@/components/ui/primitives";
import { RuntimeStatePill, StatePill, type Tone } from "@/components/ui/state-pill";
import type { GatewayConnectionView, GatewaysView, GatewayView } from "@/lib/domain/gateway-view";
import type { OperationState } from "@/lib/plc/operation-state";

type Action = (state: OperationState, formData: FormData) => Promise<OperationState>;

/** The server actions of the screen, bound to what they act on by the page. */
export type GatewayActions = {
  add: Action;
  connect: (gatewayDeviceId: string) => Action;
  connection: (connectionId: string) => Action;
  mapTag: (connectionId: string) => Action;
  /** Where the register map of a connection is downloaded from. */
  mapHref: (connectionId: string) => string;
};

const AREA_LABEL: Record<string, string> = {
  COIL: "coil",
  DISCRETE_INPUT: "discrete input",
  HOLDING_REGISTER: "holding register",
  INPUT_REGISTER: "input register",
};

function endpointPill(connection: GatewayConnectionView): { tone: Tone; text: string } {
  if (!connection.enabled) return { tone: "off", text: "closed" };
  if (connection.endpoint.listening) {
    const clients = connection.endpoint.clients;
    return clients > 0
      ? { tone: "run", text: `open · ${clients} device${clients === 1 ? "" : "s"} connected` }
      : { tone: "start", text: "open · no device connected" };
  }
  return { tone: "flt", text: "not open" };
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="zf-f">
      <label htmlFor={htmlFor} className="zf-k">
        {label}
      </label>
      {children}
    </div>
  );
}

function Connection({ connection, actions }: { connection: GatewayConnectionView; actions: GatewayActions }) {
  const pill = endpointPill(connection);
  const { endpoint } = connection;
  const buttons: OperationButton[] = [
    connection.enabled
      ? {
          operation: "disable",
          label: "Close endpoint",
          pendingLabel: "Closing…",
          confirm: "Close the endpoint? The gateway loses its connection; the mappings are kept.",
        }
      : { operation: "enable", label: "Open endpoint", pendingLabel: "Opening…", variant: "primary" },
    {
      operation: "map-all",
      label: "Map all tags",
      pendingLabel: "Mapping…",
      disabled: connection.unmappedTags.length === 0,
      title: "Commands and setpoints become writable; everything else is mapped for reading.",
    },
    {
      operation: "remove",
      label: "Remove",
      pendingLabel: "Removing…",
      variant: "danger",
      confirm: "Remove this connection and its mappings?",
    },
  ];
  const id = (name: string) => `${name}-${connection.id}`;

  return (
    <section className="flex flex-col gap-2" aria-label={`Connection to ${connection.plcName}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <b className="mono text-fg-strong">{`${connection.host}:${connection.port}`}</b>
          <span className="mono text-fg-dim">{`unit ${connection.unitId} · read every ${connection.pollIntervalMs} ms`}</span>
          <StatePill tone={pill.tone}>{pill.text}</StatePill>
          <span className="zf-k">{`→ ${connection.plcName}`}</span>
          <RuntimeStatePill state={connection.plcState} />
        </div>
        <OperationForm
          label={`Connection to ${connection.plcName}`}
          size="sm"
          action={actions.connection(connection.id)}
          buttons={buttons}
        />
      </div>
      {endpoint.error ? (
        <p className="zf-error" role="alert">
          {endpoint.error}
        </p>
      ) : null}
      <p className="zf-sub">
        {`${endpoint.requests} requests · ${endpoint.refused} refused`}
        {endpoint.lastRequestAt ? ` · last at ${endpoint.lastRequestAt.slice(11, 19)} UTC` : ""}
        {" · "}
        <a href={actions.mapHref(connection.id)} className="underline">
          Register map for the gateway (JSON)
        </a>
      </p>

      {connection.registers.length > 0 ? (
        <table className="zf-tbl">
          <thead>
            <tr>
              <th>Name for the gateway</th>
              <th>Tag</th>
              <th>Role</th>
              <th>Type</th>
              <th>Modbus address</th>
              <th>Gateway may</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {connection.registers.map((register) => (
              <tr key={register.mappingId}>
                <td className="mono">{register.externalName}</td>
                <td className="mono">{register.tagName}</td>
                <td className="mono">{register.role.toLowerCase().replace("_", " ")}</td>
                <td className="mono">{register.dataType}</td>
                <td className="mono">
                  {`${AREA_LABEL[register.area] ?? register.area} ${register.address}`}
                  <span className="syn-comment">{` · ${register.displayAddress}${register.wordCount > 1 ? ` · ${register.wordCount} words` : ""}`}</span>
                </td>
                <td className="mono">
                  <StatePill tone={register.access === "READ_WRITE" ? "deg" : "off"}>
                    {register.access === "READ_WRITE" ? "read and write" : "read"}
                  </StatePill>
                </td>
                <td>
                  <OperationForm
                    label={`Mapping of ${register.tagName}`}
                    size="sm"
                    action={actions.connection(connection.id)}
                    buttons={[
                      {
                        operation: `unmap:${register.mappingId}`,
                        label: "Unmap",
                        pendingLabel: "Unmapping…",
                        variant: "ghost",
                      },
                    ]}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="zf-sub">No tag is mapped yet: the gateway can connect but is given nothing.</p>
      )}

      {connection.unmappedTags.length > 0 ? (
        <FieldsForm
          label={`Map a tag of ${connection.plcName}`}
          action={actions.mapTag(connection.id)}
          submitLabel="Map tag"
          pendingLabel="Mapping…"
        >
          <Field label="Tag" htmlFor={id("tagId")}>
            <select id={id("tagId")} name="tagId" className="zf-input mono">
              {connection.unmappedTags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {`${tag.name} · ${tag.role.toLowerCase().replace("_", " ")}${tag.writable ? "" : " · read only"}`}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Gateway may" htmlFor={id("access")}>
            <select id={id("access")} name="access" className="zf-input" defaultValue="READ">
              <option value="READ">read</option>
              <option value="READ_WRITE">read and write (commands and setpoints only)</option>
            </select>
          </Field>
          <Field label="Name for the gateway (optional)" htmlFor={id("externalName")}>
            <input id={id("externalName")} name="externalName" className="zf-input mono" placeholder="tag name" />
          </Field>
        </FieldsForm>
      ) : null}
    </section>
  );
}

function Gateway({ gateway, view, actions }: { gateway: GatewayView; view: GatewaysView; actions: GatewayActions }) {
  const id = (name: string) => `${name}-${gateway.deviceId}`;
  return (
    <article className="zf-cell" aria-label={gateway.name}>
      <div className="flex items-center justify-between gap-2">
        <span>
          <b className="mono text-fg-strong">{gateway.name}</b>
          <span className="zf-k ml-2">{gateway.modelName}</span>
        </span>
        <span className="zf-k">{`${gateway.connections.length} PLC connection${gateway.connections.length === 1 ? "" : "s"}`}</span>
      </div>
      {gateway.connections.map((connection) => (
        <Connection key={connection.id} connection={connection} actions={actions} />
      ))}
      {gateway.availablePlcs.length > 0 ? (
        <>
          <SectionRule>
            <span className="zf-k">Connect to a PLC</span>
          </SectionRule>
          <FieldsForm
            label={`Connect ${gateway.name} to a PLC`}
            action={actions.connect(gateway.deviceId)}
            submitLabel="Open endpoint"
            pendingLabel="Opening…"
            disabled={view.suggestedPort === null}
          >
            <Field label="PLC" htmlFor={id("plcId")}>
              <select id={id("plcId")} name="plcId" className="zf-input mono">
                {gateway.availablePlcs.map((plc) => (
                  <option key={plc.id} value={plc.id}>
                    {plc.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Address of this host" htmlFor={id("host")}>
              <select id={id("host")} name="host" className="zf-input mono">
                {view.bindAddresses.map((address) => (
                  <option key={address} value={address}>
                    {address === "127.0.0.1" ? `${address} · this machine only` : address}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={`Port · ${view.portRange.min}–${view.portRange.max}`} htmlFor={id("port")}>
              <input
                id={id("port")}
                name="port"
                type="number"
                className="zf-input mono w-28"
                min={view.portRange.min}
                max={view.portRange.max}
                defaultValue={view.suggestedPort ?? undefined}
                required
              />
            </Field>
            <Field label="Unit id" htmlFor={id("unitId")}>
              <input
                id={id("unitId")}
                name="unitId"
                type="number"
                className="zf-input mono w-20"
                min={1}
                max={247}
                defaultValue={1}
              />
            </Field>
            <Field label="Read every (ms)" htmlFor={id("pollIntervalMs")}>
              <input
                id={id("pollIntervalMs")}
                name="pollIntervalMs"
                type="number"
                className="zf-input mono w-28"
                min={100}
                max={60000}
                step={100}
                defaultValue={1000}
              />
            </Field>
          </FieldsForm>
        </>
      ) : null}
    </article>
  );
}

/**
 * The external gateways of a stored factory: where each edge device connects, what it is
 * given to read, and which commands and setpoints it may write. The screen configures;
 * the endpoint enforces, and PLC logic decides what a written command does.
 */
export function GatewaysScreen({ view, actions }: { view: GatewaysView; actions: GatewayActions }) {
  const lanAddresses = view.bindAddresses.filter((address) => address !== "127.0.0.1");
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="zf-k">{`Factory · ${view.factory.name}`}</div>
          <h1 className="zf-h mt-1.5">External gateways</h1>
        </div>
        <OperationForm
          label="Gateways"
          action={actions.add}
          buttons={[{ operation: "add", label: "Add gateway", pendingLabel: "Adding…", variant: "primary" }]}
        />
      </div>
      <p className="zf-sub">
        An edge device connects to an endpoint of this host, never to a PLC directly. Through it the device reads the
        tags mapped here and writes only command and setpoint tags. A write is recorded as a command; PLC logic decides
        what it does, and the result is read back from feedback tags.
      </p>
      {lanAddresses.length === 0 ? (
        <p className="zf-sub" role="note">
          Endpoints can only listen on 127.0.0.1 now, so only programs on this machine reach them. To let a device on
          the network connect, add this host&apos;s LAN address to <span className="mono">RUNTIME_BIND_ADDRESSES</span>{" "}
          and allow the endpoint&apos;s TCP port from that device in the host firewall (docs/gateway-modbus.md).
        </p>
      ) : null}
      {!view.hasPlc ? <p className="zf-sub">This factory has no PLC yet: a gateway connects to a PLC.</p> : null}
      {view.gateways.length === 0 ? (
        <p className="zf-sub">No gateway yet. Add one here, or place a gateway device in the designer.</p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {view.gateways.map((gateway) => (
            <Gateway key={gateway.deviceId} gateway={gateway} view={view} actions={actions} />
          ))}
        </div>
      )}
    </>
  );
}
