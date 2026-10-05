import type { LocatedVariableView } from "@/lib/domain/plc-runtime-view";
import type { TagDataType } from "@/lib/domain/tag";

/**
 * The program a PLC without a program version starts from: every tag of the PLC declared
 * as a located variable, an empty body and the task configuration the runtime needs.
 */

const IEC_TYPE: Record<TagDataType, string> = {
  BOOL: "BOOL",
  INT16: "INT",
  UINT16: "UINT",
  INT32: "DINT",
  UINT32: "UDINT",
  FLOAT32: "REAL",
};

export function iecTypeFor(dataType: TagDataType): string {
  return IEC_TYPE[dataType];
}

/** IEC 61131-3 identifier: letters, digits and single underscores, not starting with a digit. */
const IEC_IDENTIFIER = /^[A-Za-z](?:_?[A-Za-z0-9])*$/;

export function isIecIdentifier(name: string): boolean {
  return IEC_IDENTIFIER.test(name);
}

/** `PLC-01` → `plc_01`; a name that cannot start an identifier gets a `p_` prefix. */
export function programNameFor(plcName: string): string {
  const name = plcName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!name) return "main";
  return /^[a-z]/.test(name) ? name : `p_${name}`;
}

export function starterProgram(plcName: string, variables: readonly LocatedVariableView[]): string {
  const program = programNameFor(plcName);
  // IEC identifiers are case-insensitive; `Scans` is the starter's own variable.
  const declared = variables.filter(
    (variable) => isIecIdentifier(variable.name) && variable.name.toLowerCase() !== "scans",
  );
  const width = Math.max(0, ...declared.map((variable) => variable.name.length));
  const lines = declared.map((variable) => {
    const comment = variable.source ? ` (* ${variable.source} *)` : "";
    return `    ${variable.name.padEnd(width)} AT ${variable.address} : ${variable.type};${comment}`;
  });

  return [
    `PROGRAM ${program}`,
    "  VAR",
    ...lines,
    "    Scans : DINT;",
    "  END_VAR",
    "",
    "  (* Control logic goes here. Outputs (%Q) are what this program decides; inputs (%M) come from the field. *)",
    "  Scans := Scans + 1;",
    "END_PROGRAM",
    "",
    "CONFIGURATION Config0",
    "  RESOURCE Res0 ON PLC",
    "    TASK task0(INTERVAL := T#50ms, PRIORITY := 0);",
    `    PROGRAM instance0 WITH task0 : ${program};`,
    "  END_RESOURCE",
    "END_CONFIGURATION",
    "",
  ].join("\n");
}
