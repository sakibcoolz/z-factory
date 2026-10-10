import Link from "next/link";
import { DeviceShell } from "@/components/device/device-shell";
import { ParametersForm } from "@/components/device/parameters-form";
import { Button } from "@/components/ui/button";
import { KeyValue, SectionRule } from "@/components/ui/primitives";
import { RuntimeStatePill } from "@/components/ui/state-pill";
import { DEVICE_CAPABILITY_LABELS } from "@/lib/domain/device-capabilities";
import { formatUtc } from "@/lib/factories/format";
import { routes } from "@/lib/navigation/routes";
import type { DeviceDetailView } from "@/lib/domain/device-detail-view";
import { saveParametersAction } from "./actions";
import { buildDeviceContext } from "@/lib/agent/contexts/design-pages";
import { loadDevice } from "./load-device";

type Ids = { factoryId: string; deviceId: string };

const protocolName = (protocol: string) => protocol.replace("MODBUS_TCP", "Modbus TCP");

function WiresTable({ device }: { device: DeviceDetailView }) {
  if (device.wires.length === 0) return <p className="zf-sub">Nothing is wired to this device yet.</p>;
  return (
    <table className="zf-tbl">
      <thead>
        <tr>
          <th>From</th>
          <th>To</th>
          <th>Kind</th>
          <th>Address · tag</th>
        </tr>
      </thead>
      <tbody>
        {device.wires.map((wire) => (
          <tr key={wire.id}>
            <td className="mono">{wire.from.name}</td>
            <td className="mono">{wire.to.name}</td>
            <td>{wire.kind.toLowerCase()}</td>
            <td className="mono">
              {wire.logicalAddress ? `${wire.logicalAddress} · ${wire.tagName ?? "no tag"}` : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Overview: identity, capabilities and what the device has, with the way to each screen. */
export async function StoredDeviceOverview({ factoryId, deviceId }: Ids) {
  const { device } = await loadDevice(factoryId, deviceId, "overview");
  return (
    <DeviceShell device={device} section="overview" llmContext={buildDeviceContext({ device, section: "overview" })}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="zf-k">{`Device · ${device.categoryName}`}</div>
          <h1 className="zf-h mt-1.5">{device.name}</h1>
        </div>
        <Button size="sm" href={routes.designer(device.factoryId)}>
          Open designer
        </Button>
      </div>
      <KeyValue
        rows={[
          ["State", <RuntimeStatePill key="v" state={device.runtimeStatus} />],
          ["Role", device.role ?? "—"],
          ["Location", device.location ?? "—"],
          ["Model", `${device.manufacturer} ${device.modelName}`],
          ["Runtime", device.runtimeSupport === "DEVICE_SIM" ? "device simulator" : "none"],
          [
            "Capabilities",
            device.capabilities.length > 0
              ? device.capabilities.map((capability) => DEVICE_CAPABILITY_LABELS[capability]).join(", ")
              : "none declared",
          ],
        ]}
      />
      {device.programNote ? <p className="zf-sub">{device.programNote}</p> : null}
      <SectionRule>
        <span className="zf-k">Screens of this model</span>
      </SectionRule>
      <p className="zf-sub">
        {`This device has ${device.sections.map((section) => section.label.toLowerCase()).join(", ")}. `}
        What a device shows follows the capabilities of its exact catalog model, never its category alone.
      </p>
      <SectionRule>
        <span className="zf-k">{`Wires · ${device.wires.length}`}</span>
      </SectionRule>
      <WiresTable device={device} />
    </DeviceShell>
  );
}

/** Connections: the device's wires, read from the factory's wiring; edited in the designer. */
export async function StoredDeviceConnections({ factoryId, deviceId }: Ids) {
  const { device } = await loadDevice(factoryId, deviceId, "connections");
  return (
    <DeviceShell
      device={device}
      section="connections"
      llmContext={buildDeviceContext({ device, section: "connections" })}
    >
      <h1 className="zf-h">Connections</h1>
      <WiresTable device={device} />
      <div>
        <Button size="sm" variant="primary" href={routes.designer(device.factoryId)}>
          Edit wiring in the designer
        </Button>
      </div>
      <p className="zf-sub">This list is read from the factory&apos;s wiring (ADR-0014).</p>
    </DeviceShell>
  );
}

/** Parameters: the behaviour parameters of a configurable device, stored as immutable versions. */
export async function StoredDeviceParameters({ factoryId, deviceId }: Ids) {
  const { device } = await loadDevice(factoryId, deviceId, "parameters");
  const parameters = device.parameters;
  return (
    <DeviceShell
      device={device}
      section="parameters"
      llmContext={buildDeviceContext({ device, section: "parameters" })}
    >
      <h1 className="zf-h">Parameters</h1>
      {!parameters || parameters.fields.length === 0 ? (
        <p className="zf-sub">
          {`${device.modelName} is parameter-configurable, but no parameter set is defined for its kind of device yet.`}
        </p>
      ) : (
        <>
          <p className="zf-sub">
            {parameters.applied
              ? "These parameters drive the device's behaviour model. A simulation that is running keeps its values until it is started again."
              : "This model is not simulated; its parameters are kept for the record and drive nothing."}
          </p>
          <ParametersForm
            fields={parameters.fields}
            values={parameters.values}
            action={saveParametersAction.bind(null, device.factoryId, device.id)}
          />
          <SectionRule>
            <span className="zf-k">{`Versions · ${parameters.versions.length}`}</span>
          </SectionRule>
          {parameters.versions.length > 0 ? (
            <table className="zf-tbl">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Saved</th>
                  <th>By</th>
                  <th>Values</th>
                </tr>
              </thead>
              <tbody>
                {parameters.versions.map((entry) => (
                  <tr key={entry.version}>
                    <td className="mono">{`v${entry.version}`}</td>
                    <td className="mono">{formatUtc(entry.createdAt)}</td>
                    <td className="mono">{entry.createdBy}</td>
                    <td className="mono whitespace-normal">
                      {parameters.fields.map((field) => `${field.key} ${entry.values[field.key]}`).join(" · ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="zf-sub">No version saved yet; the generic defaults apply.</p>
          )}
        </>
      )}
    </DeviceShell>
  );
}

/** Registers: the tags that carry this device's signals, at the controller's Modbus addresses. */
export async function StoredDeviceRegisters({ factoryId, deviceId }: Ids) {
  const { device } = await loadDevice(factoryId, deviceId, "registers");
  return (
    <DeviceShell device={device} section="registers" llmContext={buildDeviceContext({ device, section: "registers" })}>
      <h1 className="zf-h">Registers</h1>
      {device.registers.length === 0 ? (
        <p className="zf-sub">
          No tag carries a signal of this device yet. Wire it to a controller in the designer; each wire to a channel
          gets its tag and Modbus address.
        </p>
      ) : (
        <table className="zf-tbl">
          <thead>
            <tr>
              <th>Tag</th>
              <th>Controller</th>
              <th>Signal</th>
              <th>Role</th>
              <th>Type</th>
              <th>Program address</th>
              <th>Modbus</th>
            </tr>
          </thead>
          <tbody>
            {device.registers.map((register) => (
              <tr key={register.tagName}>
                <td className="mono">{register.tagName}</td>
                <td className="mono">
                  <Link href={routes.plc(device.factoryId, register.plcId)}>{register.plcName}</Link>
                </td>
                <td className="mono">{register.signal ?? "—"}</td>
                <td>{register.role.toLowerCase()}</td>
                <td className="mono">{register.dataType}</td>
                <td className="mono">{register.logicalAddress ?? "—"}</td>
                <td className="mono">{register.displayAddress ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="zf-sub">
        The registers are the controller&apos;s: a device has no address space of its own in Z-Factory.
      </p>
    </DeviceShell>
  );
}

/** Communications: the device's ports and the links on them. */
export async function StoredDeviceCommunications({ factoryId, deviceId }: Ids) {
  const { device } = await loadDevice(factoryId, deviceId, "communications");
  const links = device.wires.filter((wire) => wire.kind === "BUS");
  return (
    <DeviceShell
      device={device}
      section="communications"
      llmContext={buildDeviceContext({ device, section: "communications" })}
    >
      <h1 className="zf-h">Communications</h1>
      <table className="zf-tbl">
        <thead>
          <tr>
            <th>Port</th>
            <th>Physical</th>
            <th>Protocols</th>
            <th>Links</th>
          </tr>
        </thead>
        <tbody>
          {device.ports.map((port) => (
            <tr key={port.name}>
              <td className="mono">{port.name}</td>
              <td>{port.physicalType}</td>
              <td>{port.protocols.map(protocolName).join(", ") || "—"}</td>
              <td className="mono">{`${links.filter((wire) => wire.from.label === port.name || wire.to.label === port.name).length} of ${port.maxConnections}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {links.length > 0 ? (
        <ul className="mono text-xs">
          {links.map((wire) => (
            <li key={wire.id}>{`${wire.from.name} ↔ ${wire.to.name}`}</li>
          ))}
        </ul>
      ) : (
        <p className="zf-sub">No link on these ports yet. Connect the device over a shared protocol in the designer.</p>
      )}
    </DeviceShell>
  );
}
