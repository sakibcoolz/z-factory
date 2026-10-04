/**
 * Static design fixtures for the "Pump House Demo" factory, transcribed from the
 * Claude Design wireframes (turn 2, screens 2d–2q).
 *
 * This is NOT live runtime state: the runtime/simulator layer is the live authority and
 * arrives with Phase 02/04. Each screen fixture captures the moment its wireframe shows,
 * so the factory is RUNNING on some screens and DEGRADED (injected VFD fault) on others.
 */
import type { StageEdge, StageNode } from "@/components/canvas/stage";
import type { LogLevel, StepState } from "@/components/ui/primitives";
import type { Tone } from "@/components/ui/state-pill";
import type { RuntimeState } from "@/lib/domain/runtime-state";
import type { TagQuality, TagRole } from "@/lib/domain/tag";
import { DEMO_FACTORY_ID, DEMO_PLC_ID } from "./factories";

export const factory = {
  id: DEMO_FACTORY_ID,
  name: "Pump House Demo",
  slug: "pump-house-demo",
  network: { name: "zfactory_factory_001", subnet: "172.20.1.0/24" },
} as const;

export const plc = {
  id: DEMO_PLC_ID,
  name: "S7-1200-1214C-01",
  role: "Pump Station Controller",
  profile: "Siemens SIMATIC S7-1200 CPU 1214C",
  architecture: "compact",
  runtime: "OpenPLC",
} as const;

export type DeviceKind = "sensor" | "plc" | "vfd" | "motor" | "pump" | "gateway";

/** Factory device instances; names are unique within the factory. */
export const devices: ReadonlyArray<{ name: string; kind: DeviceKind; external?: boolean }> = [
  { name: "PT-101", kind: "sensor" },
  { name: plc.name, kind: "plc" },
  { name: "VFD-01", kind: "vfd" },
  { name: "MOTOR-01", kind: "motor" },
  { name: "PUMP-01", kind: "pump" },
  { name: "gateway-01", kind: "gateway", external: true },
];

/* ── 2d Designer ─────────────────────────────────────────────── */

export const paletteGroups: ReadonlyArray<{ title: string; items: readonly string[] }> = [
  { title: "Controllers", items: ["PLC", "Remote I/O", "Gateway"] },
  {
    title: "Drives & actuators",
    items: ["VFD / drive", "Motor", "Pump", "Fan / blower", "Conveyor", "Valve", "Relay / contactor"],
  },
  { title: "Sensing & network", items: ["Sensor", "Switch", "Encoder", "Network switch"] },
];

export const designer = {
  stage: { width: 610, height: 470 },
  state: "RUNNING" as RuntimeState,
  nodes: [
    { name: "PT-101", x: 40, y: 80, state: "RUNNING", lines: ["pressure · 4–20 mA", "→ AI0 · %IW100"] },
    {
      name: plc.name,
      x: 230,
      y: 80,
      state: "RUNNING",
      lines: ["OpenPLC · compact", "172.20.1.10 :502"],
      selected: true,
    },
    { name: "VFD-01", x: 420, y: 80, state: "RUNNING", lines: ["setpoint 45.0 Hz", "actual 44.8 Hz"] },
    { name: "MOTOR-01", x: 420, y: 190, state: "RUNNING", lines: ["1438 rpm · 6.2 A"] },
    { name: "PUMP-01", x: 420, y: 300, state: "RUNNING", lines: ["14.2 m³/h · 3.1 bar"] },
    {
      name: "gateway-01",
      x: 40,
      y: 360,
      state: "DISCONNECTED",
      lines: ["external · host:15021", "poll 500 ms"],
      external: true,
    },
  ] satisfies StageNode[] as readonly StageNode[],
  edges: [
    { path: "M190 110 H230", kind: "ok" },
    { path: "M380 110 H420", kind: "ok" },
    { path: "M495 130 V190", kind: "ok" },
    { path: "M495 230 V300", kind: "ok" },
    { path: "M305 130 V390 H190", kind: "network" },
    { path: "M420 335 H115 V130", kind: "feedback" },
  ] satisfies StageEdge[] as readonly StageEdge[],
  inspector: {
    connections: [
      ["PT-101", "AI0 · %IW100"],
      ["VFD-01", "HR 1 · FLOAT32"],
      ["gateway-01", "Modbus TCP :502"],
    ],
  },
  validation: { errors: 0, warnings: 1 },
  scan: "scan 50 ms",
} as const;

/* ── 2h PLC overview ─────────────────────────────────────────── */

export const plcSections: ReadonlyArray<{
  label: string;
  meta?: string;
  key?: "overview" | "program" | "io-mapping" | "simulator" | "tags" | "events" | "runtime" | "export";
  muted?: boolean;
}> = [
  { label: "Overview", key: "overview" },
  { label: "Hardware / Pinout" },
  { label: "Rack & Modules", meta: "compact", muted: true },
  { label: "Connections", meta: "3" },
  { label: "Program", meta: "v7", key: "program" },
  { label: "I/O Mapping", key: "io-mapping" },
  { label: "Simulator", key: "simulator" },
  { label: "Live Tags", meta: "8", key: "tags" },
  { label: "Events", meta: "2", key: "events" },
  { label: "Logs" },
  { label: "Versions" },
  { label: "Runtime", key: "runtime" },
  { label: "Export", key: "export" },
];

export const plcOverview = {
  state: "RUNNING" as RuntimeState,
  uptime: "uptime 00:14:22",
  program: { label: "pump_control.st · v7", deployed: "deployed 13:47:03" },
  scan: { label: "50 ms · avg 3.1 ms", percent: 7 },
  endpoint: { internal: "172.20.1.10:502", published: "host:15021 → :502" },
  versions: [
    ["Program", "v7 · 2f9a1c"],
    ["I/O mapping", "v3"],
    ["Modbus map", "v3"],
    ["Runtime image", "openplc:2024.11 · sha256:9f2…"],
    ["Container", "zf-001-s7-1200-1214c-01"],
  ],
  connectedDevices: [
    ["PT-101", "AI0 · %IW100 · 4–20 mA"],
    ["VFD-01", "Modbus TCP · HR 1–2"],
    ["gateway-01", "Modbus TCP client · unit 1"],
    ["MOTOR-01 / PUMP-01", "via VFD-01 (indirect)"],
  ],
  versionSummary: "v7 · io v3 · modbus v3",
} as const;

/* ── 2i Program & versions ───────────────────────────────────── */

export type SyntaxKind = "plain" | "kw" | "var" | "str" | "num" | "type" | "fn" | "comment";
type Token = readonly [kind: SyntaxKind, text: string];

const p = (text: string): Token => ["plain", text];
const kw = (text: string): Token => ["kw", text];
const v = (text: string): Token => ["var", text];
const str = (text: string): Token => ["str", text];
const num = (text: string): Token => ["num", text];
const typ = (text: string): Token => ["type", text];
const fn = (text: string): Token => ["fn", text];
const cm = (text: string): Token => ["comment", text];

export const program = {
  file: "pump_control.st",
  draftVersion: "v8",
  runningVersion: "v7",
  files: [{ label: "pump_control.st", meta: "● M", active: true }, { label: "alarms.st" }, { label: "pid_lib.st" }],
  versions: [
    { version: "v8", note: "draft · unsaved", when: "now" },
    { version: "v7", note: "deployed", when: "13:47" },
    { version: "v6", note: "clamp speed ref", when: "13:21" },
    { version: "v5", note: "add PID", when: "yday" },
  ],
  locatedVariables: [
    ["PT101_Pressure", "%IW100"],
    ["Pump01_StartCommand", "%QX100.0"],
    ["VFD01_FrequencySetpoint", "%QD100"],
    ["VFD01_ActualFrequency", "%ID104"],
  ],
  activeLine: 11,
  source: [
    [kw("PROGRAM"), p(" "), fn("pump_control")],
    [p("  "), kw("VAR")],
    [
      p("    "),
      v("PT101_Pressure"),
      p("          "),
      kw("AT"),
      p(" "),
      str("%IW100"),
      p("  : "),
      typ("INT"),
      p(";    "),
      cm("(* 4–20 mA scaled *)"),
    ],
    [
      p("    "),
      v("Pump01_StartCommand"),
      p("     "),
      kw("AT"),
      p(" "),
      str("%QX100.0"),
      p(": "),
      typ("BOOL"),
      p(";   "),
      cm("(* coil 0 · gateway writes *)"),
    ],
    [
      p("    "),
      v("VFD01_FrequencySetpoint"),
      p(" "),
      kw("AT"),
      p(" "),
      str("%QD100"),
      p("  : "),
      typ("REAL"),
      p(";   "),
      cm("(* HR 1–2 FLOAT32 *)"),
    ],
    [p("    "), v("VFD01_ActualFrequency"), p("   "), kw("AT"), p(" "), str("%ID104"), p("  : "), typ("REAL"), p(";")],
    [p("    "), v("Interlock_OK"), p("            : "), typ("BOOL"), p(";")],
    [p("  "), kw("END_VAR")],
    [],
    [
      p("  "),
      v("Interlock_OK"),
      p(" := "),
      v("PT101_Pressure"),
      p(" > "),
      num("120"),
      p(";   "),
      cm("(* low-level permissive *)"),
    ],
    [
      p("  "),
      kw("IF"),
      p(" "),
      v("Pump01_StartCommand"),
      p(" "),
      kw("AND"),
      p(" "),
      v("Interlock_OK"),
      p(" "),
      kw("THEN"),
    ],
    [
      p("    "),
      v("VFD01_FrequencySetpoint"),
      p(" := "),
      fn("LIMIT"),
      p("("),
      num("0.0"),
      p(", "),
      fn("PID_Out"),
      p(", "),
      num("50.0"),
      p(");"),
    ],
    [p("  "), kw("ELSE")],
    [p("    "), v("VFD01_FrequencySetpoint"), p(" := "), num("0.0"), p(";")],
    [p("  "), kw("END_IF"), p(";")],
    [kw("END_PROGRAM")],
  ] as ReadonlyArray<readonly Token[]>,
  build: {
    command: "matiec pump_control.st …",
    result: "OK",
    summary: "(0 errors, 1 warning)",
    warning: "⚠ line 12: PID_Out used before assignment",
    artifacts: "4 located variables → io-map.json v3 · modbus-map.json v3",
    note: "deploy reloads runtime artifacts · image rebuild not required",
  },
} as const;

/* ── 2j I/O mapping ──────────────────────────────────────────── */

export type IoMappingRow = {
  source: string;
  logical: string;
  /** Tag name; null when the channel has no valid tag (free, or rejected by validation). */
  tag: string | null;
  dataType?: string;
  direction?: "IN" | "OUT" | "CMD";
  role?: TagRole;
  modbus: string;
  scale?: string;
  access?: "R" | "RW";
  selected?: boolean;
  /** Validation problem reported for the row. */
  problem?: string;
};

export const ioMapping = {
  currentVersion: "v3",
  draftVersion: "v4",
  filters: ["all", "command", "setpoint", "feedback", "alarm", "unmapped"],
  conventions: [
    ["Address base", "zero-based"],
    ["Byte order", "big-endian"],
    ["Word order", "high-first"],
  ],
  rows: [
    {
      source: "AI0 · PT-101",
      logical: "%IW100",
      tag: "PT101_Pressure",
      dataType: "INT→FLOAT32",
      direction: "IN",
      role: "PROCESS_VALUE",
      modbus: "IR · 0–1",
      scale: "×0.01 · bar",
      access: "R",
    },
    {
      source: "— · gateway-01",
      logical: "%QX100.0",
      tag: "Pump01_StartCommand",
      dataType: "BOOL",
      direction: "CMD",
      role: "COMMAND",
      modbus: "Coil · 0",
      scale: "—",
      access: "RW",
    },
    {
      source: "X1 · VFD-01",
      logical: "%QD100",
      tag: "VFD01_FrequencySetpoint",
      dataType: "FLOAT32 · 2w",
      direction: "OUT",
      role: "SETPOINT",
      modbus: "HR · 1–2",
      scale: "×1 · Hz",
      access: "RW",
      selected: true,
    },
    {
      source: "X1 · VFD-01",
      logical: "%ID104",
      tag: "VFD01_ActualFrequency",
      dataType: "FLOAT32 · 2w",
      direction: "IN",
      role: "FEEDBACK",
      modbus: "IR · 2–3",
      scale: "×1 · Hz",
      access: "R",
    },
    {
      source: "sim · MOTOR-01",
      logical: "%IW108",
      tag: "Motor01_ActualRPM",
      dataType: "UINT16",
      direction: "IN",
      role: "FEEDBACK",
      modbus: "IR · 4",
      scale: "×1 · rpm",
      access: "R",
    },
    {
      source: "sim · PUMP-01",
      logical: "%ID110",
      tag: "Pump01_Pressure",
      dataType: "FLOAT32 · 2w",
      direction: "IN",
      role: "PROCESS_VALUE",
      modbus: "IR · 5–6",
      scale: "×1 · bar",
      access: "R",
    },
    {
      source: "sim · PUMP-01",
      logical: "%IX100.1",
      tag: "Pump01_Fault",
      dataType: "BOOL",
      direction: "IN",
      role: "ALARM",
      modbus: "DI · 1",
      scale: "—",
      access: "R",
    },
    {
      source: "DI a.1 · LS-101",
      logical: "%IX100.0",
      tag: null,
      dataType: "BOOL",
      direction: "IN",
      role: "STATUS",
      modbus: "DI · 0",
      scale: "—",
      access: "R",
      problem: "duplicate of PT101_High",
    },
    { source: "DO a.1 · free", logical: "%QX100.1", tag: null, modbus: "Coil · 1" },
  ] satisfies IoMappingRow[] as readonly IoMappingRow[],
} as const;

/* ── 2k Simulator ────────────────────────────────────────────── */

export const simulator = {
  state: "RUNNING" as RuntimeState,
  tick: "tick 100 ms",
  selectedDevice: "VFD-01",
  faultInjections: ["VFD overcurrent trip", "Motor overload", "Sensor bad quality", "Pump dry-run", "Valve stuck"],
  commands: [
    { label: "Run command", value: "TRUE", source: "Pump01_StartCommand" },
    { label: "Direction", value: "FWD" },
    { label: "Frequency setpoint", value: "45.0 Hz", percent: 90 },
    { label: "Reset", value: "FALSE" },
  ] as ReadonlyArray<{ label: string; value: string; source?: string; percent?: number }>,
  feedback: [
    { label: "Actual frequency", value: "44.8 Hz", trend: "▂▃▄▅▆▇▇▇▇▇" },
    { label: "Current", value: "6.2 A", trend: "▃▄▅▆▆▆▆▆▆▆" },
    { label: "Torque", value: "71 %", trend: "▂▄▅▆▆▆▆▆▆▆" },
  ],
  status: { label: "at speed", ramp: "ramp 2.0 Hz/s" },
  loopTrace:
    "PT-101 3.08 bar → PT101_Pressure 308 → PID → VFD01_FrequencySetpoint 45.0 → VFD actual 44.8 Hz → MOTOR 1438 rpm → PUMP 3.1 bar → PT-101 ↺",
  summary: { stateMachines: 6, processes: 1, faults: 0 },
} as const;

/* ── 2l Live tags ────────────────────────────────────────────── */

export type LiveTag = {
  name: string;
  device: string;
  role: TagRole;
  dataType: string;
  value: string;
  trend: string;
  quality: TagQuality;
  age: string;
};

export const liveTags = {
  transport: "SSE · 250 ms",
  poll: "poll 250 ms · last update 0.1 s",
  /** Tag currently open for an inline write, with the value being typed. */
  editing: { tag: "VFD01_FrequencySetpoint", draft: "48.0" },
  tags: [
    {
      name: "PT101_Pressure",
      device: "PT-101",
      role: "PROCESS_VALUE",
      dataType: "FLOAT32",
      value: "3.08 bar",
      trend: "▃▄▅▅▆▆▆▆▆▆",
      quality: "GOOD",
      age: "0.1 s",
    },
    {
      name: "Pump01_StartCommand",
      device: "gateway-01",
      role: "COMMAND",
      dataType: "BOOL",
      value: "TRUE",
      trend: "▁▁▇▇▇▇▇▇▇▇",
      quality: "GOOD",
      age: "0.1 s",
    },
    {
      name: "VFD01_FrequencySetpoint",
      device: "VFD-01",
      role: "SETPOINT",
      dataType: "FLOAT32",
      value: "45.0 Hz",
      trend: "▅▅▆▆▇▇▇▇▇▇",
      quality: "GOOD",
      age: "0.1 s",
    },
    {
      name: "VFD01_ActualFrequency",
      device: "VFD-01",
      role: "FEEDBACK",
      dataType: "FLOAT32",
      value: "44.8 Hz",
      trend: "▄▅▆▆▇▇▇▇▇▇",
      quality: "GOOD",
      age: "0.2 s",
    },
    {
      name: "Motor01_ActualRPM",
      device: "MOTOR-01",
      role: "FEEDBACK",
      dataType: "UINT16",
      value: "1438",
      trend: "▄▅▆▆▇▇▇▇▇▇",
      quality: "GOOD",
      age: "0.2 s",
    },
    {
      name: "Pump01_Pressure",
      device: "PUMP-01",
      role: "PROCESS_VALUE",
      dataType: "FLOAT32",
      value: "3.10 bar",
      trend: "▃▄▅▅▆▆▆▆▆▆",
      quality: "GOOD",
      age: "0.2 s",
    },
    {
      name: "Pump01_Fault",
      device: "PUMP-01",
      role: "ALARM",
      dataType: "BOOL",
      value: "FALSE",
      trend: "▁▁▁▁▁▁▁▁▁▁",
      quality: "GOOD",
      age: "0.2 s",
    },
    {
      name: "GW01_Heartbeat",
      device: "gateway-01",
      role: "STATUS",
      dataType: "UINT16",
      value: "1842",
      trend: "▁▂▃▄▅▆▇▁▂▃",
      quality: "STALE",
      age: "4.1 s",
    },
  ] satisfies LiveTag[] as readonly LiveTag[],
  /** Write lifecycle (docs/gateway-modbus.md): requested → accepted → PLC command → device actual → interlock. */
  lastWrite: {
    tag: "VFD01_FrequencySetpoint",
    stages: [
      { tone: "run", label: "requested 48.0" },
      { tone: "run", label: "write accepted" },
      { tone: "start", label: "PLC command 48.0" },
      { tone: "deg", label: "device actual 44.8 → ramping" },
      { tone: "off", label: "interlock clear" },
    ] satisfies Array<{ tone: Tone; label: string }>,
  },
} as const;

/* ── 2m Events / alarms ──────────────────────────────────────── */

export const events = {
  state: "DEGRADED" as RuntimeState,
  typeFilters: [
    { label: "all", tone: "start" },
    { label: "lifecycle", tone: "off" },
    { label: "modbus", tone: "off" },
    { label: "vfd / motor / pump", tone: "off" },
    { label: "gateway", tone: "off" },
    { label: "fault", tone: "off" },
    { label: "alarm", tone: "flt" },
  ] satisfies Array<{ label: string; tone: Tone }>,
  severity: { critical: 1, warning: 1, info: 214 },
  retention: [
    ["Lifecycle · alarms", "always"],
    ["Modbus r/w", "sampled"],
  ],
  alarms: [
    {
      severity: "CRIT",
      tone: "flt",
      title: "VFD overcurrent trip",
      detail: "FAULT_INJECTED · VFD_STATE_CHANGED → FAULTED",
      device: "VFD-01",
      raised: "13:47:11",
      status: "unacked",
      action: "Acknowledge",
    },
    {
      severity: "WARN",
      tone: "deg",
      title: "Gateway heartbeat stale",
      detail: "CONNECTION_DOWN · gateway-01 · 4.1 s",
      device: "gateway-01",
      raised: "13:47:09",
      status: "acked",
      action: "Clear",
    },
  ] satisfies Array<{
    severity: string;
    tone: Tone;
    title: string;
    detail: string;
    device: string;
    raised: string;
    status: string;
    action: string;
  }>,
  stream: [
    { time: "13:47:02.118", level: "info", type: "FACTORY_STARTED", detail: "zfactory_factory_001" },
    {
      time: "13:47:03.002",
      level: "info",
      type: "PLC_PROGRAM_DEPLOYED",
      detail: "S7-1200-1214C-01 · pump_control.st v7",
    },
    { time: "13:47:05.410", level: "info", type: "GATEWAY_COMMAND_RECEIVED", detail: "gateway-01 → Coil 0 := TRUE" },
    { time: "13:47:05.412", level: "info", type: "MODBUS_WRITE", detail: "accepted · Pump01_StartCommand" },
    { time: "13:47:05.460", level: "info", type: "VFD_COMMAND_CHANGED", detail: "VFD-01 run=TRUE · setpoint 45.0 Hz" },
    { time: "13:47:07.900", level: "info", type: "MOTOR_STATE_CHANGED", detail: "MOTOR-01 1438 rpm" },
    { time: "13:47:09.771", level: "warn", type: "CONNECTION_DOWN", detail: "gateway-01 heartbeat stale" },
    {
      time: "13:47:11.040",
      level: "crit",
      type: "FAULT_INJECTED",
      detail: "VFD-01 overcurrent (user: sakib · audited)",
    },
    { time: "13:47:11.052", level: "crit", type: "ALARM_RAISED", detail: "VFD-01 · factory RUNNING → DEGRADED" },
    { time: "13:47:12.300", level: "info", type: "PUMP_STATE_CHANGED", detail: "PUMP-01 flow 0.0 m³/h" },
  ] satisfies Array<{ time: string; level: LogLevel; type: string; detail: string }>,
} as const;

/* ── 2n Runtime / containers ─────────────────────────────────── */

type RuntimeService = {
  /** Deterministic service name inside the factory network (never a raw Docker ID). */
  service: string;
  detail: string;
  image: string;
  imageDigest?: string;
  container: string;
  address: string;
  hostPort?: string;
  health: { tone: Tone; label: string };
  usage: string;
  state: RuntimeState;
  action?: { label: string; primary?: boolean };
};

export const runtime = {
  state: "DEGRADED" as RuntimeState,
  uptime: "00:14:22",
  network: [
    ["Name", "zfactory_factory_001"],
    ["Driver", "bridge · isolated"],
    ["Published", "15021 → :502"],
  ],
  lifecycle: [
    { marker: "✓", label: "create", state: "done" },
    { marker: "✓", label: "configure", state: "done" },
    { marker: "✓", label: "attach network", state: "done" },
    { marker: "✓", label: "start", state: "done" },
    { marker: "✓", label: "health check", state: "done" },
    { marker: "✓", label: "deploy program", state: "done" },
    { marker: "●", label: "running", state: "current" },
  ] satisfies Array<{ marker: string; label: string; state: StepState }>,
  limits: [
    ["CPU", "1.0 / plc"],
    ["Memory", "256 MB"],
    ["Privileged", "never"],
  ],
  services: [
    {
      service: "s7-1200-1214c-01",
      detail: "OpenPLC · program v7",
      image: "openplc:2024.11",
      imageDigest: "sha256:9f2a…",
      container: "zf-001-s7-1200",
      address: "172.20.1.10 · 502",
      hostPort: "host 15021",
      health: { tone: "run", label: "healthy" },
      usage: "3 % · 84 MB",
      state: "RUNNING",
      action: { label: "Restart" },
    },
    {
      service: "device-simulator",
      detail: "PT-101 · VFD-01 · MOTOR-01 · PUMP-01",
      image: "zf-devsim:0.3",
      container: "zf-001-devsim",
      address: "172.20.1.20 · 502",
      health: { tone: "deg", label: "1 fault" },
      usage: "2 % · 41 MB",
      state: "DEGRADED",
      action: { label: "Restart" },
    },
    {
      service: "gateway-sim-01",
      detail: "optional · Modbus client",
      image: "zf-gwsim:0.1",
      container: "zf-001-gw",
      address: "172.20.1.30",
      health: { tone: "off", label: "—" },
      usage: "—",
      state: "STOPPED",
      action: { label: "Start", primary: true },
    },
    {
      service: "gateway-01",
      detail: "external edge hardware",
      image: "—",
      container: "—",
      address: "192.168.1.44 → host:15021",
      health: { tone: "deg", label: "stale 4.1 s" },
      usage: "—",
      state: "DISCONNECTED",
    },
  ] satisfies RuntimeService[] as readonly RuntimeService[],
  logs: [
    { time: "13:47:02.118", level: "info", label: "INFO", message: "Modbus TCP server listening on :502" },
    { time: "13:47:03.002", level: "info", label: "INFO", message: "program pump_control v7 loaded · cycle 50 ms" },
    { time: "13:47:05.412", level: "info", label: "INFO", message: "write coil 0 ← 1 (client 172.20.1.1:15021)" },
    {
      time: "13:47:11.040",
      level: "warn",
      label: "WARN",
      message: "input IR 2–3 stale from device-simulator (VFD-01 faulted)",
    },
  ] satisfies Array<{ time: string; level: LogLevel; label: string; message: string }>,
  summary: { healthy: 2, total: 3 },
} as const;

/* ── 2o Topology ─────────────────────────────────────────────── */

export const topology = {
  state: "DEGRADED" as RuntimeState,
  stage: { width: 820, height: 500 },
  networkZone: {
    left: 20,
    top: 24,
    width: 780,
    height: 340,
    label: "docker network · zfactory_factory_001 · 172.20.1.0/24",
  },
  layers: [
    { label: "◉ Network · Modbus TCP", active: true },
    { label: "◎ Wiring · I/O signals" },
    { label: "◎ Control authority" },
    { label: "◎ Power" },
  ],
  nodes: [
    { name: "PT-101", x: 40, y: 80, state: "RUNNING", lines: ["sim · AI0 4–20 mA", "wired → PLC"] },
    {
      name: plc.name,
      x: 250,
      y: 80,
      state: "RUNNING",
      lines: ["172.20.1.10 :502", "Modbus server · 2 clients"],
      emphasis: true,
    },
    { name: "VFD-01", x: 450, y: 80, state: "FAULTED", lines: ["172.20.1.20 :502 (devsim)", "no response · 11 s"] },
    { name: "MOTOR-01", x: 650, y: 80, state: "DEGRADED", lines: ["0 rpm · coasting"], narrow: true },
    { name: "PUMP-01", x: 650, y: 220, state: "DEGRADED", lines: ["0.0 m³/h"], narrow: true },
    { name: "bridge · host", x: 250, y: 250, state: "RUNNING", lines: ["host:15021 → :502", "validated publish"] },
    {
      name: "gateway-01",
      x: 40,
      y: 410,
      state: "DISCONNECTED",
      lines: ["192.168.1.44 · unit 1", "writes → command tags only"],
      external: true,
    },
  ] satisfies StageNode[] as readonly StageNode[],
  edges: [
    { path: "M190 110 H250", kind: "ok" },
    { path: "M400 110 H450", kind: "fault" },
    { path: "M600 110 H650", kind: "idle" },
    { path: "M710 130 V220", kind: "idle" },
    { path: "M325 130 V250", kind: "ok" },
    { path: "M325 300 V440 H190", kind: "network" },
    { path: "M710 260 V340 H115 V130", kind: "feedback" },
  ] satisfies StageEdge[] as readonly StageEdge[],
  legend: [
    { sample: "— solid", tone: "ok", meaning: "link up" },
    { sample: "— red", tone: "fault", meaning: "link faulted" },
    { sample: "- - dashed", tone: "plain", meaning: "published port" },
    { sample: "· · dotted", tone: "info", meaning: "feedback path" },
  ],
  selected: {
    name: "VFD-01",
    state: "FAULTED" as RuntimeState,
    rows: [
      ["Cause", "overcurrent (injected)"],
      ["Upstream", "S7-1200-1214C-01"],
      ["Downstream", "MOTOR-01 → PUMP-01"],
    ],
  },
  summary: "1 faulted link · 2 degraded devices",
} as const;

/* ── 2p Export ───────────────────────────────────────────────── */

export const plcExport = {
  formats: [
    { label: "▣ PDF engineering report", active: true },
    { label: "▢ CSV · I/O & tag schedules" },
    { label: "▢ JSON · normalized config" },
    { label: "▢ Config package (.zip) · program + runtime maps" },
  ],
  /** The 15 report sections of docs/plc-export.md. */
  sections: [
    { title: "Factory & PLC identity", included: true },
    { title: "Model / SKU / architecture", included: true },
    { title: "Role & runtime", included: true },
    { title: "Power & communication", included: true },
    { title: "Built-in I/O structure", included: true },
    { title: "Pin / terminal occupancy", included: true },
    { title: "Full tag list", included: true },
    { title: "Modbus register map", included: true },
    { title: "Connected-device schedule", included: true },
    { title: "Control relationships", included: true },
    { title: "Gateway / network", included: true },
    { title: "Versions", included: true },
    { title: "Runtime health snapshot", included: false },
    { title: "Topology diagram", included: true },
    { title: "Timestamp & revision", included: true },
  ],
  pinned: [
    ["Program", "v7"],
    ["I/O · Modbus", "v3 · v3"],
    ["Secrets", "redacted"],
  ],
  sheet: {
    revision: "rev 2f9a1c · 2026-10-04 16:13 UTC",
    page: "1 / 6",
    identity: [
      ["Factory", "Pump House Demo · zfactory_factory_001"],
      ["Model", "Siemens SIMATIC S7-1200 CPU 1214C DC/DC/DC · 6ES7214-1AG40-0XB0 · compact"],
      ["Runtime", "OpenPLC (virtual) · program v7 · io v3 · modbus v3"],
    ],
    scheduleColumns: ["PLC point", "Tag", "Device", "Model", "Relationship", "Signal", "Addr", "Unit"],
    schedule: [
      ["AI0", "PT101_Pressure", "PT-101", "Generic PT", "process value", "4–20 mA", "IR 0–1", "bar"],
      ["X1", "VFD01_FrequencySetpoint", "VFD-01", "Generic VFD", "setpoint", "Modbus TCP", "HR 1–2", "Hz"],
      ["X1", "VFD01_ActualFrequency", "VFD-01", "Generic VFD", "feedback", "Modbus TCP", "IR 2–3", "Hz"],
      ["—", "Pump01_StartCommand", "gateway-01", "edge gateway", "command", "Modbus TCP", "Coil 0", "—"],
    ],
  },
} as const;

/* ── 2q 3D view ──────────────────────────────────────────────── */

export const scene = {
  state: "RUNNING" as RuntimeState,
  selected: "PUMP-01",
  cameras: [
    { label: "orbit", active: true },
    { label: "top", active: false },
    { label: "follow", active: false },
  ],
  selectedRows: [
    ["Drive", "VFD-01 · 44.8 Hz"],
    ["Flow", "14.2 m³/h"],
    ["Pressure", "3.1 bar"],
    ["Tag sync", "250 ms"],
  ],
  render: [
    ["FPS", "60"],
    ["Meshes", "6 primitives"],
  ],
} as const;
