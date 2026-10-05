/**
 * Display helpers for catalog facts. Pure; importable anywhere.
 */
import { SIGNAL_TYPE_LABELS, type SignalType } from "@/lib/domain/catalog";

const UNIT_SUFFIXES: ReadonlyArray<readonly [suffix: string, unit: string]> = [
  ["Kb", "KB"],
  ["Mb", "MB"],
  ["W", "W"],
  ["V", "V"],
  ["A", "A"],
];

export function signalTypeLabel(signalType: string): string {
  return SIGNAL_TYPE_LABELS[signalType as SignalType] ?? signalType;
}

/** `workMemoryKb: 100` → `["Work memory", "100 KB"]`; `signalModulesMax: 8` → `["Signal modules, max.", "8"]`. */
export function formatFact(key: string, value: unknown): [label: string, text: string] {
  let name = key;
  let unit = "";
  for (const [suffix, symbol] of UNIT_SUFFIXES) {
    if (name.length > suffix.length && name.endsWith(suffix) && /[a-z]/.test(name.at(-suffix.length - 1) ?? "")) {
      name = name.slice(0, -suffix.length);
      unit = ` ${symbol}`;
      break;
    }
  }
  let qualifier = "";
  for (const [suffix, text] of [
    ["Max", ", max."],
    ["Typ", ", typ."],
    ["Min", ", min."],
    ["Rated", ", rated"],
  ] as const) {
    if (name.endsWith(suffix) && name.length > suffix.length) {
      name = name.slice(0, -suffix.length);
      qualifier = text;
      break;
    }
  }
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  const label = `${words.charAt(0).toUpperCase()}${words.slice(1)}${qualifier}`;
  const text = Array.isArray(value) ? value.join(", ") : String(value);
  return [label, `${text}${unit}`];
}
