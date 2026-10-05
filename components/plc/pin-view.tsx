import Link from "next/link";
import { PinKey } from "@/components/ui/primitives";
import { signalTypeLabel } from "@/lib/catalog/format";
import type { PlcBankView, PlcPointView } from "@/lib/domain/plc-config-view";

type PinViewProps = {
  banks: readonly PlcBankView[];
  selectedId?: string;
  /** Link that selects a pin. */
  pinHref: (pointId: string) => string;
};

const pinState = (point: PlcPointView, selectedId: string | undefined) =>
  point.id === selectedId ? "selected" : point.status === "FREE" ? "free" : "occupied";

const pinTitle = (point: PlcPointView) =>
  [
    `${point.ioType} ${point.label}`,
    point.logicalAddress,
    point.device ? `wired to ${point.device.name}` : point.status.toLowerCase(),
  ].join(" · ");

/** 2f / 2g — pin and channel view, drawn from the PLC's I/O points. */
export function PinView({ banks, selectedId, pinHref }: PinViewProps) {
  return (
    <div className="zf-cell gap-2.5">
      {banks.map((bank) => (
        <div key={bank.key} className="flex flex-col gap-2.5">
          <div className="flex justify-between">
            <span className="mono">{bank.label}</span>
            <span className="zf-k">{`${bank.ioType} · ${bank.points.filter((point) => point.status !== "FREE").length}/${bank.points.length} used`}</span>
          </div>
          <div className="zf-pins">
            {bank.points.map((point) => (
              <Link
                key={point.id}
                href={pinHref(point.id)}
                className="zf-pin"
                data-state={pinState(point, selectedId)}
                title={pinTitle(point)}
                aria-label={pinTitle(point)}
                aria-current={point.id === selectedId ? "true" : undefined}
              >
                {point.label}
              </Link>
            ))}
          </div>
        </div>
      ))}
      {banks.length === 0 ? <p className="zf-sub">No I/O yet. Install a module to get channels.</p> : null}
      <div className="zf-k flex gap-2.5">
        <PinKey state="occupied">occupied</PinKey>
        <PinKey state="selected">selected</PinKey>
        <PinKey state="free">free</PinKey>
      </div>
    </div>
  );
}

/** Details of one selected channel. */
export function PinDetails({ point }: { point: PlcPointView }) {
  const rows: Array<[string, string]> = [
    ["Signal", point.signalTypes.map(signalTypeLabel).join(" / ")],
    ["Address in program", point.logicalAddress],
    ["Vendor address", point.vendorAddress ?? "not documented"],
    [
      "Connected device",
      point.device
        ? `${point.device.name}${point.device.terminalLabel ? ` · ${point.device.terminalLabel}` : ""}`
        : "none",
    ],
    ["Tag", point.tagName ?? "none"],
  ];
  return (
    <div className="zf-cell gap-2" data-selected="true">
      <span className="zf-k">{`${point.ioType} ${point.label} · ${point.status.toLowerCase()}`}</span>
      {rows.map(([label, value]) => (
        <div key={label} className="flex flex-col gap-1">
          <span className="zf-k">{label}</span>
          <span className="mono">{value}</span>
        </div>
      ))}
    </div>
  );
}
