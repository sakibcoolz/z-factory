/**
 * CSV schedules of a PLC export (docs/plc-export.md → Machine-readable exports). Pure.
 */
import type { PlcExportDocument } from "@/lib/export/plc-export";

type Cell = string | number | null | undefined;

/**
 * One CSV cell (RFC 4180). Text that a spreadsheet would run as a formula is prefixed
 * with an apostrophe: names and roles are typed by users.
 */
export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers: readonly string[], rows: ReadonlyArray<readonly Cell[]>): string {
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** Every channel of the PLC: where it is, its addresses, and what is wired to it. */
export function ioScheduleCsv(document: PlcExportDocument): string {
  return toCsv(
    [
      "Source",
      "Slot",
      "Module",
      "Type",
      "Channel",
      "Vendor address",
      "Program address",
      "Signal",
      "Status",
      "Device",
      "Terminal",
      "Tag",
    ],
    document.ioPoints.map((point) => [
      point.source,
      point.slot,
      point.module,
      point.ioType,
      point.channel,
      point.vendorAddress,
      point.programAddress,
      point.signalTypes.join(" / "),
      point.status,
      point.device,
      point.deviceTerminal,
      point.tag,
    ]),
  );
}

/** The tag list with its Modbus register map. */
export function tagScheduleCsv(document: PlcExportDocument): string {
  return toCsv(
    [
      "Tag",
      "Role",
      "Data type",
      "Direction",
      "Program address",
      "Modbus area",
      "Modbus address (zero-based)",
      "Modbus address (display)",
      "Words",
      "Access",
      "Byte order",
      "Word order",
      "Scale",
      "Offset",
      "Unit",
      "Device",
      "Device signal",
    ],
    document.tags.map((tag) => [
      tag.name,
      tag.role,
      tag.dataType,
      tag.direction,
      tag.programAddress,
      tag.modbusArea,
      tag.modbusAddress,
      tag.modbusDisplayAddress,
      tag.wordCount,
      tag.accessMode,
      tag.byteOrder,
      tag.wordOrder,
      tag.scale,
      tag.offset,
      tag.unit,
      tag.sourceDevice,
      tag.sourceSignal,
    ]),
  );
}

/** The connected-device schedule, in the column order of docs/plc-export.md. */
export function deviceScheduleCsv(document: PlcExportDocument): string {
  return toCsv(
    ["PLC Point", "Tag", "Device Instance", "Model", "Relationship", "Signal/Protocol", "Address", "Unit"],
    document.connectedDevices.map((row) => [
      row.plcPoint,
      row.tag,
      row.device,
      row.model,
      row.relationship,
      row.signalOrProtocol,
      row.address,
      row.unit,
    ]),
  );
}
