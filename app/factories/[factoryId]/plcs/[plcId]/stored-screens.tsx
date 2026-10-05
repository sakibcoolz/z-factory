import { PinDetails, PinView } from "@/components/plc/pin-view";
import { ModuleInstallForm } from "@/components/plc/module-install-form";
import { PeripheralForm } from "@/components/plc/peripheral-form";
import { StoredPlcShell } from "@/components/plc/stored-plc-shell";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Gauge, SectionRule } from "@/components/ui/primitives";
import { StatePill } from "@/components/ui/state-pill";
import { signalTypeLabel } from "@/lib/catalog/format";
import { isDomainError } from "@/lib/domain/errors";
import type { PlcConfigurationView } from "@/lib/domain/plc-config-view";
import { routes } from "@/lib/navigation/routes";
import { modbusDisplayAddress, parseLocatedAddress, toModbusLocation } from "@/lib/protocols/modbus/located-address";
import {
  getPeripheralOptions,
  listAddablePeripherals,
  listInstallableModules,
} from "@/lib/services/plc-config-service";
import {
  addPeripheralAction,
  deletePlcAction,
  installModuleAction,
  removeModuleAction,
  removePeripheralAction,
} from "../actions";
import { loadPlc } from "./load-plc";

/**
 * Screens of a PLC stored in the database: overview, hardware, connections and I/O
 * mapping. The Pump House Demo PLC keeps its fixture screens until its sections are wired.
 */

type Ids = { factoryId: string; plcId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function Header({ view, title }: { view: PlcConfigurationView; title: string }) {
  const { model, plc } = view;
  return (
    <div className="flex items-end justify-between">
      <div>
        <div className="zf-k">{[model.manufacturer, model.family, plc.architectureType.toLowerCase()].join(" · ")}</div>
        <h1 className="zf-h mt-1.5">{title}</h1>
      </div>
      <StatePill tone="deg">simulated via OpenPLC</StatePill>
    </div>
  );
}

function supplyText(view: PlcConfigurationView): string {
  const electrical = view.electrical;
  if (!electrical) return "not recorded";
  const range =
    electrical.voltageMin != null && electrical.voltageMax != null
      ? `(${electrical.voltageMin}–${electrical.voltageMax} V)`
      : "";
  return [electrical.nominalVoltage != null ? `${electrical.nominalVoltage} V` : "", electrical.supplyType, range]
    .filter(Boolean)
    .join(" ");
}

function HardwareFacts({ view }: { view: PlcConfigurationView }) {
  const { occupancy } = view;
  const percent = occupancy.total === 0 ? 0 : Math.round((occupancy.occupied / occupancy.total) * 100);
  return (
    <div className="grid grid-cols-3 gap-2.5">
      <div className="zf-cell">
        <span className="zf-k">Power</span>
        <span className="mono">{supplyText(view)}</span>
      </div>
      <div className="zf-cell">
        <span className="zf-k">Communication</span>
        {view.ports.length === 0 ? <span className="mono">none recorded</span> : null}
        {view.ports.map((port) => (
          <span key={port.name} className="mono">
            {`${port.name} ×${port.portCount}${port.protocols.length > 0 ? ` · ${port.protocols.join(", ").replace("MODBUS_TCP", "Modbus TCP")}` : ""}`}
          </span>
        ))}
      </div>
      <div className="zf-cell">
        <span className="zf-k">Occupancy</span>
        <span className="mono">{`${occupancy.occupied} of ${occupancy.total} channels`}</span>
        <Gauge percent={percent} label="Channel occupancy" />
      </div>
    </div>
  );
}

/** 2h — PLC overview. */
export async function StoredPlcOverview({ factoryId, plcId }: Ids) {
  const { factory, view } = await loadPlc(factoryId, plcId);
  const { plc, model } = view;
  return (
    <StoredPlcShell factory={factory} view={view} section="overview">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="zf-k">
            {[model.manufacturer, model.family, model.modelName, model.sku].filter(Boolean).join(" · ")}
          </div>
          <h1 className="zf-h mt-1.5">{plc.name}</h1>
          <p className="mt-1 text-fg-muted">{plc.role ?? "No process role set"}</p>
        </div>
        <div className="flex items-start gap-1.5">
          <Button size="sm" href={routes.catalog({ model: model.id })}>
            Catalog model
          </Button>
          <ConfirmAction
            label="Delete"
            question={`Delete ${plc.name} with its I/O, tags and wiring? Connected devices stay in the factory.`}
            confirmLabel="Confirm delete"
            action={deletePlcAction.bind(null, factoryId, plcId)}
          />
        </div>
      </div>
      <HardwareFacts view={view} />
      <SectionRule>
        <span className="zf-k">{`Connected devices · ${view.peripherals.length}`}</span>
      </SectionRule>
      {view.peripherals.length > 0 ? (
        <table className="zf-tbl">
          <thead>
            <tr>
              <th>Device</th>
              <th>Model</th>
              <th>Connection</th>
            </tr>
          </thead>
          <tbody>
            {view.peripherals.map((peripheral) => (
              <tr key={peripheral.deviceId}>
                <td className="mono">{peripheral.name}</td>
                <td>{peripheral.modelName}</td>
                <td className="mono">
                  {peripheral.connection === "PROTOCOL"
                    ? peripheral.protocols.join(", ").replace("MODBUS_TCP", "Modbus TCP")
                    : `${peripheral.wires.length} channel${peripheral.wires.length === 1 ? "" : "s"}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="zf-sub">Nothing is connected yet.</p>
      )}
      <div className="mt-auto flex gap-2 border-t border-line pt-2.5">
        <Button variant="primary" href={routes.plcConnections(factoryId, plcId)}>
          Connect devices
        </Button>
        <Button href={routes.plcHardware(factoryId, plcId)}>
          {plc.architectureType === "MODULAR" ? "Rack & modules" : "Pin view"}
        </Button>
        <Button variant="ghost" href={routes.plcIoMapping(factoryId, plcId)}>
          I/O mapping
        </Button>
      </div>
    </StoredPlcShell>
  );
}

/** 2f / 2g — hardware: pin view, and for a modular PLC its rack and modules. */
export async function StoredPlcHardware({ factoryId, plcId, pin }: Ids & { pin?: string }) {
  const { actor, db, factory, view } = await loadPlc(factoryId, plcId);
  const modules = view.rack ? await listInstallableModules(db, actor, plcId) : [];
  const selected = view.banks.flatMap((bank) => bank.points).find((point) => point.id === pin);
  const freeSlots = view.rack?.slots.filter((slot) => !slot.module).map((slot) => slot.slotIndex) ?? [];
  const installed = view.rack?.slots.filter((slot) => slot.module) ?? [];

  return (
    <StoredPlcShell factory={factory} view={view} section="hardware">
      <Header view={view} title={view.rack ? "Rack, modules & channels" : "Built-in I/O & pin view"} />
      <HardwareFacts view={view} />
      {view.rack ? (
        <>
          <SectionRule>
            <span className="zf-k">{`${view.rack.name} · ${installed.length} of ${view.rack.slotCount} slots used`}</span>
          </SectionRule>
          {installed.length > 0 ? (
            <table className="zf-tbl">
              <thead>
                <tr>
                  <th>Slot</th>
                  <th>Module</th>
                  <th>Order no.</th>
                  <th>Channels used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {installed.map((slot) =>
                  slot.module ? (
                    <tr key={slot.slotIndex}>
                      <td className="mono">{slot.slotIndex}</td>
                      <td className="mono">{slot.module.modelName}</td>
                      <td className="mono">{slot.module.sku}</td>
                      <td className="mono">{`${slot.module.occupiedCount}/${slot.module.pointCount}`}</td>
                      <td>
                        <ConfirmAction
                          label="Remove"
                          question={`Remove ${slot.module.modelName} from slot ${slot.slotIndex}?`}
                          confirmLabel="Remove module"
                          action={removeModuleAction.bind(null, factoryId, plcId, slot.module.id)}
                        />
                      </td>
                    </tr>
                  ) : null,
                )}
              </tbody>
            </table>
          ) : (
            <p className="zf-sub">The rack is empty. A modular PLC gets its I/O from modules.</p>
          )}
          <ModuleInstallForm
            action={installModuleAction.bind(null, factoryId, plcId)}
            modules={modules}
            freeSlots={freeSlots}
          />
        </>
      ) : null}
      <div className="grid grid-cols-[1fr_18.75rem] gap-3">
        <PinView
          banks={view.banks}
          selectedId={selected?.id}
          pinHref={(pointId) => routes.plcHardware(factoryId, plcId, pointId)}
        />
        {selected ? (
          <PinDetails point={selected} />
        ) : (
          <div className="zf-cell">
            <span className="zf-k">Channel</span>
            <span className="zf-sub">Select a channel to see its signal, address, tag and connected device.</span>
          </div>
        )}
      </div>
    </StoredPlcShell>
  );
}

/** Connections: devices wired to the PLC, and the catalog peripherals it still has room for. */
export async function StoredPlcConnections({ factoryId, plcId, add }: Ids & { add?: string }) {
  const { actor, db, factory, view } = await loadPlc(factoryId, plcId);
  const addable = await listAddablePeripherals(db, actor, plcId);
  const options =
    add && UUID.test(add)
      ? await getPeripheralOptions(db, actor, plcId, add).catch((error: unknown) => {
          if (isDomainError(error, "NOT_FOUND")) return undefined;
          throw error;
        })
      : undefined;

  return (
    <StoredPlcShell factory={factory} view={view} section="connections">
      <Header view={view} title="Connected devices" />
      {options ? (
        <PeripheralForm
          // A new key resets the form when another model is chosen.
          key={options.model.id}
          action={addPeripheralAction.bind(null, factoryId, plcId, options.model.id)}
          options={options}
          cancelHref={routes.plcConnections(factoryId, plcId)}
        />
      ) : null}
      {view.peripherals.length > 0 ? (
        <table className="zf-tbl">
          <thead>
            <tr>
              <th>Device</th>
              <th>Model</th>
              <th>Terminal → channel · address · tag</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {view.peripherals.map((peripheral) => (
              <tr key={peripheral.deviceId}>
                <td className="mono">{peripheral.name}</td>
                <td>{peripheral.modelName}</td>
                <td className="mono whitespace-normal">
                  {peripheral.connection === "PROTOCOL" ? (
                    <span>{`over ${peripheral.protocols.join(", ").replace("MODBUS_TCP", "Modbus TCP")}`}</span>
                  ) : (
                    peripheral.wires.map((wire) => (
                      <span key={wire.logicalAddress} className="block">
                        {`${wire.terminalLabel ?? "—"} → ${wire.ioType} ${wire.pointLabel} · ${wire.logicalAddress} · ${wire.tagName ?? "no tag"}`}
                      </span>
                    ))
                  )}
                </td>
                <td>
                  <ConfirmAction
                    label="Remove"
                    question={`Remove ${peripheral.name}? Its channels are freed and its tags deleted.`}
                    confirmLabel="Remove device"
                    action={removePeripheralAction.bind(null, factoryId, plcId, peripheral.deviceId)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="zf-sub">Nothing is connected yet. Choose a device below.</p>
      )}
      <SectionRule>
        <span className="zf-k">Add a device from the catalog</span>
      </SectionRule>
      <table className="zf-tbl">
        <thead>
          <tr>
            <th>Type</th>
            <th>Model</th>
            <th>Needs</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {addable.map((peripheral) => (
            <tr key={peripheral.modelId} data-muted={!peripheral.fits}>
              <td>{peripheral.categoryName}</td>
              <td className="mono">{peripheral.modelName}</td>
              <td className="mono">{peripheral.detail}</td>
              <td>
                {peripheral.fits ? (
                  <Button size="sm" href={routes.plcConnections(factoryId, plcId, peripheral.modelId)}>
                    Add
                  </Button>
                ) : (
                  <StatePill tone="off">no room</StatePill>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </StoredPlcShell>
  );
}

/** 2j — I/O mapping: channel › program address › Modbus address › tag › device. */
export async function StoredPlcIoMapping({ factoryId, plcId }: Ids) {
  const { factory, view } = await loadPlc(factoryId, plcId);
  const rows = view.banks.flatMap((bank) => bank.points.map((point) => ({ bank, point })));
  const modbus = (address: string) => {
    const location = toModbusLocation(parseLocatedAddress(address));
    return `${location.area.toLowerCase().replace("_", " ")} ${location.address} (${modbusDisplayAddress(location.area, location.address)})`;
  };

  return (
    <StoredPlcShell factory={factory} view={view} section="io-mapping">
      <Header view={view} title="I/O mapping" />
      <p className="zf-sub">
        Outputs use the output image (%Q). Inputs use memory addresses (%M): the OpenPLC runtime takes simulated field
        values only there. Modbus addresses are zero-based; the 5-digit notation is shown in brackets.
      </p>
      {rows.length > 0 ? (
        <table className="zf-tbl">
          <thead>
            <tr>
              <th>Channel</th>
              <th>Signal</th>
              <th>Vendor address</th>
              <th>Address in program</th>
              <th>Modbus</th>
              <th>Tag</th>
              <th>Device</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ bank, point }) => (
              <tr key={point.id} data-muted={point.status === "FREE"}>
                <td className="mono">{`${bank.slotIndex ? `S${bank.slotIndex} ` : ""}${point.ioType} ${point.label}`}</td>
                <td className="mono">{signalTypeLabel(point.signalTypes[0] ?? "")}</td>
                <td className="mono">{point.vendorAddress ?? "—"}</td>
                <td className="mono">{point.logicalAddress}</td>
                <td className="mono">{modbus(point.logicalAddress)}</td>
                <td className="mono">{point.tagName ?? "—"}</td>
                <td className="mono">
                  {point.device ? `${point.device.name} · ${point.device.terminalLabel ?? ""}` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="zf-sub">No I/O yet. Install a module to get channels.</p>
      )}
    </StoredPlcShell>
  );
}
