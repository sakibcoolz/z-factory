/**
 * Static design fixtures transcribed from the Claude Design wireframes (turn 2).
 *
 * Fixtures of the PLC configuration screens (2f, 2g). Order numbers, I/O counts and module
 * compatibility below are wireframe placeholders, NOT catalog records: the catalog itself
 * lives in the database (lib/catalog, TASK-301). TASK-302 replaces these with it.
 */
import type { PinState, StepState } from "@/components/ui/primitives";
import type { Tone } from "@/components/ui/state-pill";

type WizardStep = { marker: string; label: string; state: StepState };

const wizardSteps = (labels: readonly string[], current: number): WizardStep[] =>
  labels.map((label, index) => ({
    marker: String(index + 1),
    label,
    state: index < current ? "done" : index === current ? "current" : "todo",
  }));

const pins = (count: number, states: Partial<Record<number, PinState>> = {}, labels?: readonly string[]) =>
  Array.from({ length: count }, (_, index) => ({
    label: labels?.[index] ?? String(index),
    state: states[index] ?? ("free" as PinState),
  }));

/** 2f — compact PLC configuration (built-in I/O, pin view). */
export const compactConfig = {
  instanceName: "S7-1200-1214C-01",
  role: "Pump Station Ctrl",
  steps: wizardSteps(
    [
      "Manufacturer",
      "Family",
      "Model",
      "Architecture · compact",
      "Role / name",
      "Peripherals & I/O",
      "Tags & protocol",
      "Runtime config",
    ],
    5,
  ),
  power: "24 V DC · 12 W",
  commPort: { label: "Comm port X1 · PROFINET", address: "172.20.1.10 /24" },
  occupancy: { label: "DI 2/14 · DO 1/10 · AI 1/2", percent: 18 },
  banks: [
    {
      label: "DI a.0–a.7 · b.0–b.5",
      kind: "24 V sink/source",
      pins: pins(14, { 0: "occupied", 1: "occupied" }, [
        "0",
        "1",
        "2",
        "3",
        "4",
        "5",
        "6",
        "7",
        "0",
        "1",
        "2",
        "3",
        "4",
        "5",
      ]),
    },
    {
      label: "DO a.0–a.7 · b.0–b.1",
      kind: "transistor",
      pins: pins(10, { 0: "occupied" }, ["0", "1", "2", "3", "4", "5", "6", "7", "0", "1"]),
    },
    { label: "AI 0–1", kind: "0–10 V", pins: pins(2, { 0: "selected" }) },
  ],
  selectedChannel: {
    title: "AI 0 · selected",
    device: "PT-101 · pressure sensor",
    signal: "4–20 mA",
    signalError:
      "AI0 accepts 0–10 V. Add 250 Ω shunt or pick a 4–20 mA channel. Incompatible signal types are blocked.",
    logicalAddress: "%IW100",
    tag: "PT101_Pressure",
  },
  validationErrors: 1,
} as const;

type RackSlot =
  | {
      kind: "module";
      slot: number;
      name: string;
      sku: string;
      emphasis?: "psu" | "cpu";
      port?: string;
      selected?: boolean;
    }
  | { kind: "empty"; label: string; target?: boolean };

type ModuleOption = {
  name: string;
  sku: string;
  channels: string;
  power: string;
  check: { tone: Tone; label: string };
  compatible: boolean;
};

/** 2g — modular PLC configuration (CPU › rack › slots › modules). */
export const modularConfig = {
  factoryName: "Modular S7-1500 bench",
  instanceName: "S7-1500-1511PN-01",
  steps: wizardSteps(
    [
      "Manufacturer",
      "Family",
      "Model",
      "Architecture · modular",
      "Role / name",
      "Rack & modules",
      "Channels & terminals",
      "Tags & protocol",
      "Runtime config",
    ],
    5,
  ),
  budget: {
    rows: [
      ["Slots", "5 / 32"],
      ["Backplane power", "14.2 / 25 W"],
      ["Address space", "IW100–IW131"],
    ],
    percent: 57,
  },
  slots: [
    { kind: "module", slot: 0, name: "PS 25 W", sku: "6ES7505-0KA00", emphasis: "psu" },
    { kind: "module", slot: 1, name: "CPU 1511-1 PN", sku: "6ES7511-1AK02", emphasis: "cpu", port: "PN X1" },
    { kind: "module", slot: 2, name: "DI 16×24VDC", sku: "6ES7521-1BH00" },
    { kind: "module", slot: 3, name: "DQ 16×24VDC", sku: "6ES7522-1BH01" },
    { kind: "module", slot: 4, name: "AI 8×U/I HS", sku: "6ES7531-7NF10", selected: true },
    { kind: "empty", label: "Slot 5 — drop here", target: true },
    { kind: "empty", label: "Slot 6" },
    { kind: "empty", label: "Slot 7 · … 31" },
  ] satisfies RackSlot[] as readonly RackSlot[],
  targetSlot: 5,
  moduleOptions: [
    {
      name: "AQ 4×U/I ST",
      sku: "6ES7532-5HD00",
      channels: "4 AO",
      power: "0.9 W",
      check: { tone: "run", label: "ok" },
      compatible: true,
    },
    {
      name: "CM PtP RS422/485",
      sku: "6ES7540-1AB00",
      channels: "1 serial",
      power: "1.1 W",
      check: { tone: "run", label: "ok" },
      compatible: true,
    },
    {
      name: "SM 1231 AI ×4 (S7-1200)",
      sku: "6ES7231-4HD32",
      channels: "4 AI",
      power: "—",
      check: { tone: "flt", label: "family" },
      compatible: false,
    },
    {
      name: "PS 60 W",
      sku: "6ES7507-0RA00",
      channels: "—",
      power: "—",
      check: { tone: "flt", label: "slot 0 only" },
      compatible: false,
    },
  ] satisfies ModuleOption[] as readonly ModuleOption[],
  selectedModule: {
    title: "Slot 4 · AI 8×U/I · channels",
    pins: pins(8, { 0: "selected", 1: "occupied" }),
    fields: [
      { label: "Ch 0 range", value: "4–20 mA · 2-wire", mono: true },
      { label: "Terminals", value: "3 (+) · 4 (−)", mono: true },
      { label: "Device", value: "FT-201 · flow", mono: false },
      { label: "Tag", value: "FT201_Flow", mono: true },
    ],
  },
} as const;
