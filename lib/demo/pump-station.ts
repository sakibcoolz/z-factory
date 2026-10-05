/**
 * The pump station of the MVP demo (docs/demo-runbook.md): what it is made of and the
 * control program of its PLC. Pure data and text; the demo service builds a factory from
 * it out of catalog models, with the same services a person uses on the screens.
 *
 *   PT-101 -> PLC-01 -> VFD-01 -> MOTOR-01 -> PUMP-01 -> pressure -> PT-101
 *   GATEWAY-01 <-> PLC-01: writes start, reset and speed setpoint; reads feedback
 */

export const DEMO_FACTORY_NAME = "Pump Station Demo";

/** Catalog models the demo is built from, by their names in the shipped catalog. */
export const DEMO_MODELS = {
  plc: "CPU 1511-1 PN",
  /** In slot order: the channels the drive and the transmitter are wired to. */
  modules: ["DI 16x24VDC BA", "DQ 16x24VDC/0.5A BA", "AI 8xU/I/RTD/TC ST", "AQ 4xU/I ST"],
  vfd: "Generic VFD, hardwired control",
  motor: "Generic three-phase motor",
  pump: "Generic centrifugal pump",
  transmitter: "Generic pressure transmitter, 4–20 mA",
} as const;

export const DEMO_DEVICES = {
  plc: "PLC-01",
  vfd: "VFD-01",
  motor: "MOTOR-01",
  pump: "PUMP-01",
  transmitter: "PT-101",
} as const;

/** Where the devices stand on the designer canvas and, with it, in the 3D view. */
export const DEMO_POSITIONS: Record<keyof typeof DEMO_DEVICES | "gateway", readonly [number, number]> = {
  gateway: [40, 40],
  plc: [300, 40],
  vfd: [560, 40],
  motor: [560, 300],
  pump: [820, 300],
  transmitter: [820, 40],
};

/** The pump trips above this pressure and stays tripped until it is reset. */
export const DEMO_TRIP_BAR = 3;
/** The drive is never given more than this, whatever is asked for. */
export const DEMO_MAX_HZ = 50;

/**
 * What an operator or a gateway may write, and what the program reports. They sit on
 * addresses away from the I/O points, which belong to the wired devices.
 */
export const DEMO_OPERATOR_TAGS = [
  { name: "Pump_Start", dataType: "BOOL", role: "COMMAND", logicalAddress: "%QX100.0" },
  { name: "Pump_Reset", dataType: "BOOL", role: "COMMAND", logicalAddress: "%QX100.1" },
  { name: "Pump_Speed_SP", dataType: "INT16", role: "SETPOINT", logicalAddress: "%QW100", scale: 0.01, unit: "Hz" },
  { name: "High_Pressure_Trip", dataType: "BOOL", role: "ALARM", logicalAddress: "%QX100.2" },
] as const;

/** Simulation parameters of the demo devices; everything not named keeps its generic default. */
export const DEMO_PROFILES = {
  vfd: { maxFrequencyHz: DEMO_MAX_HZ, accelTimeS: 4, decelTimeS: 4 },
  // The transmitter measures what the pump produces: this closes the loop.
  transmitter: { source: { kind: "MEASURED", signal: "pressure" }, rangeMin: 0, rangeMax: 10 },
} as const;

export type DemoVariable = { name: string; address: string; type: string; comment?: string };

/** Tags of the wired devices as the wiring names them: `<device>_<terminal>`. */
const tag = (device: string, terminal: string) => `${device}_${terminal}`.replace(/[^A-Za-z0-9]+/g, "_");

/**
 * The control program. A gateway or an operator asks (start, reset, speed setpoint); the
 * program decides what the drive gets: it limits the speed, stops on a drive fault and
 * trips on high pressure. Raw values: frequencies in 0.01 Hz, pressure in 0.1 bar.
 */
export function demoProgram(variables: readonly DemoVariable[]): string {
  const vfd = (terminal: string) => tag(DEMO_DEVICES.vfd, terminal);
  const pressure = tag(DEMO_DEVICES.transmitter, "OUT");
  const required = [vfd("RUN"), vfd("REV"), vfd("RESET"), vfd("REF"), vfd("FAULT"), pressure];
  const missing = required.filter((name) => !variables.some((variable) => variable.name === name));
  if (missing.length > 0) throw new Error(`The demo program needs the tags ${missing.join(", ")}.`);

  const width = Math.max(...variables.map((variable) => variable.name.length));
  const declarations = variables.map(
    (variable) =>
      `    ${variable.name.padEnd(width)} AT ${variable.address} : ${variable.type};${variable.comment ? ` (* ${variable.comment} *)` : ""}`,
  );
  return [
    "PROGRAM pump_station",
    "  VAR",
    ...declarations,
    "  END_VAR",
    "",
    `  (* Interlock: above ${DEMO_TRIP_BAR} bar the pump trips and stays tripped until it is reset. *)`,
    `  IF ${pressure} > ${DEMO_TRIP_BAR * 10} THEN`,
    "    High_Pressure_Trip := TRUE;",
    "  END_IF;",
    "  IF Pump_Reset THEN",
    "    High_Pressure_Trip := FALSE;",
    "  END_IF;",
    "",
    "  (* The drive runs when it is asked to and nothing forbids it. *)",
    `  ${vfd("RESET")} := Pump_Reset;`,
    `  ${vfd("REV")} := FALSE;`,
    `  ${vfd("RUN")} := Pump_Start AND NOT ${vfd("FAULT")} AND NOT High_Pressure_Trip;`,
    "",
    `  (* The setpoint is a request: the drive gets 0 to ${DEMO_MAX_HZ} Hz, and nothing while it must not run. *)`,
    `  IF NOT ${vfd("RUN")} THEN`,
    `    ${vfd("REF")} := 0;`,
    `  ELSIF Pump_Speed_SP > ${DEMO_MAX_HZ * 100} THEN`,
    `    ${vfd("REF")} := ${DEMO_MAX_HZ * 100};`,
    "  ELSIF Pump_Speed_SP < 0 THEN",
    `    ${vfd("REF")} := 0;`,
    "  ELSE",
    `    ${vfd("REF")} := Pump_Speed_SP;`,
    "  END_IF;",
    "END_PROGRAM",
    "",
    "CONFIGURATION Config0",
    "  RESOURCE Res0 ON PLC",
    "    TASK task0(INTERVAL := T#50ms, PRIORITY := 0);",
    "    PROGRAM instance0 WITH task0 : pump_station;",
    "  END_RESOURCE",
    "END_CONFIGURATION",
    "",
  ].join("\n");
}
