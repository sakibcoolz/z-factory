import type { ReactNode } from "react";
import Link from "next/link";
import { SectionRule } from "@/components/ui/primitives";
import { StatePill } from "@/components/ui/state-pill";
import { formatFact, signalTypeLabel } from "@/lib/catalog/format";
import { CONTROL_CAPABILITY_LABELS } from "@/lib/domain/catalog";
import type { CatalogModelDetail, ChannelSummary, PeripheralCompatibility } from "@/lib/domain/catalog-view";
import { routes } from "@/lib/navigation/routes";

const RUNTIME_LABELS: Record<string, string> = {
  OPENPLC: "OpenPLC (no vendor firmware)",
  DEVICE_SIM: "Device simulator",
  MODBUS_SIM: "Modbus simulator",
  EXTERNAL: "External",
  NONE: "Not executable",
};

const channelText = (group: ChannelSummary) => {
  const signals = [group.signalType, ...group.acceptedSignalTypes].map(signalTypeLabel).join(" / ");
  return `${group.count} × ${group.ioType} · ${signals}`;
};

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="zf-k">{label}</span>
      <span className="mono">{children}</span>
    </div>
  );
}

/** Verified records name their source; generic ones say that they make no vendor claim. */
export function VerificationPill({ model }: { model: Pick<CatalogModelDetail, "verificationStatus" | "source"> }) {
  if (model.verificationStatus === "VERIFIED") {
    return <StatePill tone="run">{`verified ${model.source.verifiedAt ?? ""}`.trim()}</StatePill>;
  }
  if (model.verificationStatus === "GENERIC") return <StatePill tone="off">generic · simulated</StatePill>;
  return <StatePill tone="deg">unverified</StatePill>;
}

function connectionText(peripheral: PeripheralCompatibility): string {
  const parts: string[] = [];
  if (peripheral.directIo) {
    const classes = new Map<string, number>();
    for (const terminal of peripheral.directIo.terminals) {
      const key = `${terminal.required} ${signalTypeLabel(terminal.signalType)}`;
      classes.set(key, (classes.get(key) ?? 0) + 1);
    }
    parts.push([...classes].map(([key, count]) => `${count} × ${key}`).join(", "));
  }
  if (peripheral.protocols.length > 0) parts.push(peripheral.protocols.join(", ").replace("MODBUS_TCP", "Modbus TCP"));
  return parts.join(" · ") || "—";
}

function fitText(peripheral: PeripheralCompatibility): string {
  if (peripheral.directIo?.compatible) {
    const modules = [...new Set(peripheral.directIo.terminals.flatMap((terminal) => terminal.modules))];
    return modules.length > 0 ? `via ${modules.join(", ")}` : "built-in I/O";
  }
  if (peripheral.protocols.length > 0) return "over the network";
  const missing = peripheral.directIo?.terminals.filter((terminal) => !terminal.satisfied) ?? [];
  if (missing.length === 0) return "no shared protocol";
  return `no ${[...new Set(missing.map((terminal) => `${terminal.required} ${signalTypeLabel(terminal.signalType)}`))].join(", ")}`;
}

type CatalogModelViewProps = {
  model: CatalogModelDetail;
  /** Peripheral compatibility; given for PLC models only. */
  peripherals?: readonly PeripheralCompatibility[];
};

/** 2e — one catalog model: identity, documented facts, their source, and what fits it. */
export function CatalogModelView({ model, peripherals }: CatalogModelViewProps) {
  const electrical = model.electrical;
  const facts = Object.entries(model.facts);
  const range =
    electrical?.voltageMin != null && electrical.voltageMax != null
      ? `${electrical.voltageMin}–${electrical.voltageMax} V`
      : null;
  const supply = electrical
    ? [
        electrical.nominalVoltage != null ? `${electrical.nominalVoltage} V` : null,
        electrical.supplyType,
        range && `(${range})`,
      ]
        .filter(Boolean)
        .join(" ")
    : null;

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="zf-k">
            {[model.manufacturer, model.family, model.architectureType?.toLowerCase() ?? model.categoryName].join(
              " · ",
            )}
          </div>
          <h1 className="zf-h mt-1.5">{model.modelName}</h1>
          {model.sku ? <div className="mono mt-1 text-fg-dim">{model.sku}</div> : null}
        </div>
        <VerificationPill model={model} />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="zf-cell">
          <Fact label="Power">{supply ?? "not recorded"}</Fact>
          <Fact label="Communication">
            {model.ports.length === 0
              ? "none recorded"
              : model.ports.map((port) => (
                  <span key={port.name} className="block">
                    {`${port.name} ×${port.portCount} · ${port.physicalType}`}
                    {port.protocols.length > 0
                      ? ` · ${port.protocols.join(", ").replace("MODBUS_TCP", "Modbus TCP")}`
                      : ""}
                  </span>
                ))}
          </Fact>
        </div>
        <div className="zf-cell">
          {model.categoryCode === "PLC" ? (
            <Fact label={model.architectureType === "MODULAR" ? "I/O" : "Built-in I/O"}>
              {model.builtInChannels.length > 0
                ? model.builtInChannels.map((group) => (
                    <span key={`${group.ioType}${group.signalType}`} className="block">
                      {channelText(group)}
                    </span>
                  ))
                : "through modules"}
            </Fact>
          ) : (
            <Fact label="Terminals">
              {model.terminals.length > 0
                ? model.terminals.map((terminal) => (
                    <span key={terminal.terminalLabel} className="block">
                      {`${terminal.terminalLabel} · ${terminal.direction === "INPUT" ? "in" : "out"} · ${signalTypeLabel(terminal.signalType)}`}
                    </span>
                  ))
                : "none (connects to other devices)"}
            </Fact>
          )}
          <Fact label="Control">{CONTROL_CAPABILITY_LABELS[model.controlCapability]}</Fact>
          <div className="flex flex-col gap-1.5">
            <span className="zf-k">Runtime mapping</span>
            <span className="mono syn-type">{RUNTIME_LABELS[model.runtimeSupport] ?? model.runtimeSupport}</span>
          </div>
        </div>
        <div className="zf-cell">
          {facts.length > 0 ? (
            facts.map(([key, value]) => {
              const [label, text] = formatFact(key, value);
              return (
                <Fact key={key} label={label}>
                  {text}
                </Fact>
              );
            })
          ) : (
            <Fact label="Further facts">none recorded</Fact>
          )}
        </div>
      </div>

      <SectionRule>
        <span className="zf-k">Source</span>
      </SectionRule>
      {model.source.url ? (
        <p className="zf-sub">
          <a href={model.source.url} rel="noreferrer" target="_blank" className="underline">
            {model.source.title}
          </a>
          {` · ${model.source.revision} · retrieved ${model.source.retrievedAt}`}
        </p>
      ) : (
        <p className="zf-sub">Generic simulated profile. It makes no claim about any vendor&apos;s device.</p>
      )}

      {model.modules.length > 0 ? (
        <>
          <SectionRule>
            <span className="zf-k">{`Installable modules${model.racks[0] ? ` · ${model.racks[0].name}, ${model.racks[0].slotCount} slots` : ""}`}</span>
          </SectionRule>
          <table className="zf-tbl">
            <thead>
              <tr>
                <th>Module</th>
                <th>Order no.</th>
                <th>Channels</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {model.modules.map((module) => (
                <tr key={module.modelName}>
                  <td className="mono">{module.modelName}</td>
                  <td className="mono">{module.sku}</td>
                  <td className="mono">{module.channels.map(channelText).join("; ")}</td>
                  <td className="mono syn-comment">{module.verificationStatus.toLowerCase()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}

      {peripherals ? (
        <>
          <SectionRule>
            <span className="zf-k">Peripherals (shown in device creation)</span>
          </SectionRule>
          <table className="zf-tbl">
            <thead>
              <tr>
                <th>Type</th>
                <th>Model</th>
                <th>Needs</th>
                <th>Fits</th>
              </tr>
            </thead>
            <tbody>
              {peripherals.map((peripheral) => (
                <tr key={peripheral.modelId} data-muted={!peripheral.compatible}>
                  <td>{peripheral.categoryName}</td>
                  <td className="mono">
                    <Link href={routes.catalog({ model: peripheral.modelId })}>{peripheral.modelName}</Link>
                  </td>
                  <td className="mono">{connectionText(peripheral)}</td>
                  <td className="mono">
                    <StatePill tone={peripheral.compatible ? "run" : "off"}>
                      {peripheral.compatible ? "yes" : "no"}
                    </StatePill>
                    <span className="syn-comment mt-1 block whitespace-normal">{fitText(peripheral)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}

      <p className="zf-sub mt-auto">
        Normalized metadata from manufacturer sources (docs/references/plc-source-policy.md). No vendor firmware
        emulation.
      </p>
    </>
  );
}
