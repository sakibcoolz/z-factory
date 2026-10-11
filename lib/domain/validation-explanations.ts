import { DomainError, type DomainErrorCode } from "./errors";

/**
 * Agent-readable validation (TASK-1007): what a refusal means and what to do about it,
 * from the same `DomainError` the human UI shows. `RULE_EXPLANATIONS` covers the
 * engineering rules (wiring, I/O and tags, PLC configuration, process modules, gateways,
 * factory configuration, export); every other rule gets a generic explanation from its
 * error code. `lib/domain/validation-explanations.test.ts` fails when an engineering
 * rule in the code has no entry. Pure; importable anywhere.
 */

/**
 * - `fixable`: a configuration the agent or user can change so the operation succeeds.
 * - `unsupported`: the product does not do this; no configuration makes it succeed.
 * - `state`: not now: something must be started, stopped, removed or bound first.
 * - `unavailable`: a host, service or runtime did not answer; retry or see the Runtime page.
 */
export type RefusalKind = "fixable" | "unsupported" | "state" | "unavailable";

export const REFUSAL_KINDS: Readonly<Record<RefusalKind, string>> = {
  fixable: "a configuration the agent or the user can change so the operation succeeds",
  unsupported: "the product does not do this; no configuration makes it succeed",
  state: "not now: something must be started, stopped, removed or bound first",
  unavailable: "a host, service or runtime did not answer; retry, or see the Runtime page",
};

export type RuleExplanation = {
  kind: RefusalKind;
  /** The engineering area of the LLM Index where the rule is met. */
  area: string;
  /** The condition the rule requires. */
  expected: string;
  /** What to do, safely, so the operation succeeds; or why it never will. */
  remediation: string;
};

const wiring = (kind: RefusalKind, expected: string, remediation: string): RuleExplanation => ({
  kind,
  area: "designer",
  expected,
  remediation,
});
const plc = (kind: RefusalKind, expected: string, remediation: string): RuleExplanation => ({
  kind,
  area: "plc",
  expected,
  remediation,
});
const tags = (kind: RefusalKind, expected: string, remediation: string): RuleExplanation => ({
  kind,
  area: "tags",
  expected,
  remediation,
});
const modules = (kind: RefusalKind, expected: string, remediation: string): RuleExplanation => ({
  kind,
  area: "modules",
  expected,
  remediation,
});
const gateways = (kind: RefusalKind, expected: string, remediation: string): RuleExplanation => ({
  kind,
  area: "gateways",
  expected,
  remediation,
});
const factory = (kind: RefusalKind, expected: string, remediation: string): RuleExplanation => ({
  kind,
  area: "factory",
  expected,
  remediation,
});
const devices = (kind: RefusalKind, expected: string, remediation: string): RuleExplanation => ({
  kind,
  area: "devices",
  expected,
  remediation,
});
const exportArea = (kind: RefusalKind, expected: string, remediation: string): RuleExplanation => ({
  kind,
  area: "export",
  expected,
  remediation,
});
const catalog = (kind: RefusalKind, expected: string, remediation: string): RuleExplanation => ({
  kind,
  area: "catalog",
  expected,
  remediation,
});
const communication = (kind: RefusalKind, expected: string, remediation: string): RuleExplanation => ({
  kind,
  area: "plc-communication",
  expected,
  remediation,
});

export const RULE_EXPLANATIONS: Readonly<Record<string, RuleExplanation>> = {
  // --- wiring and relationships (lib/validation/connection.ts, topology-service.ts)
  "wire-same-device": wiring(
    "fixable",
    "The two endpoints belong to different devices.",
    "Choose an endpoint of the other device; a device is not wired to itself.",
  ),
  "wire-kind": wiring(
    "fixable",
    "Both endpoints are of one kind: signal to signal, supply to supply, earth to earth, port to port.",
    "Choose an endpoint of the same kind on the other device.",
  ),
  "wire-direction": wiring(
    "fixable",
    "An output is wired to an input.",
    "Choose an input for an output, or an output for an input.",
  ),
  "wire-signal-class": wiring(
    "fixable",
    "Both endpoints are digital, or both analog.",
    "Choose a channel of the terminal's class: DI or DO for a digital signal, AI or AO for an analog one.",
  ),
  "wire-signal-type": wiring(
    "fixable",
    "The electrical standard or range of one end is accepted by the other.",
    "Choose a channel that accepts the terminal's standard (for example 4–20 mA, 0–10 V, 24 V DC).",
  ),
  "wire-protocol": wiring(
    "fixable",
    "Two ports share at least one protocol.",
    "Choose a port with a protocol in common, or a gateway between the two.",
  ),
  "wire-duplicate": wiring(
    "fixable",
    "The two endpoints are not wired to each other yet.",
    "Keep the existing wire; nothing is to add.",
  ),
  "wire-occupied": wiring(
    "fixable",
    "The endpoint has a free wire position left.",
    "Choose a free endpoint, or remove or move the wire that occupies it.",
  ),
  "wire-plc-to-plc": wiring(
    "unsupported",
    "A wire joins a device and a PLC channel, or two devices; two PLCs exchange data over a protocol mapping.",
    "Map the tags between the PLCs on the Communication page instead of wiring their channels.",
  ),
  "io-point-type": wiring(
    "fixable",
    "The PLC channel's class (DI, DO, AI, AO) matches the device signal's.",
    "Wire the terminal to a free channel of the required class; the designer offers only those.",
  ),
  "signal-type": wiring(
    "fixable",
    "The channel accepts the terminal's signal standard.",
    "Choose a channel that accepts the standard, or a device whose terminal uses one the PLC has.",
  ),
  "io-point-free": wiring(
    "fixable",
    "The I/O point is free.",
    "Choose a free point, or disconnect what holds it first.",
  ),
  "distinct-devices": wiring(
    "unsupported",
    "A connection joins two different devices.",
    "Pick another device as the other end.",
  ),
  "same-factory": wiring(
    "unsupported",
    "Both devices are in the factory the connection is made in.",
    "Connect devices of one factory only; create the device in this factory if needed.",
  ),
  "drives-source": wiring(
    "fixable",
    "Only a drive (VFD, servo drive, soft starter) drives a motor.",
    "Connect the motor to a drive, or wire it to a contactor or starter as a controlled device.",
  ),
  "drives-target": wiring(
    "fixable",
    "A drive drives a motor.",
    "Connect the drive to a motor; other equipment is driven by the motor.",
  ),
  "drive-type": wiring(
    "fixable",
    "The motor's preferred drive type matches the drive.",
    "Choose a drive of the required type, or a motor the drive suits.",
  ),
  "one-motor-per-drive": wiring(
    "unsupported",
    "One drive drives one primary motor (MVP invariant).",
    "Add another drive for the second motor.",
  ),
  "one-drive-per-motor": wiring(
    "unsupported",
    "A motor has one drive.",
    "Disconnect the existing drive first if the motor should change drive.",
  ),
  "mechanical-source": wiring(
    "fixable",
    "Only a motor mechanically drives equipment.",
    "Connect the equipment to a motor.",
  ),
  "mechanical-target": wiring(
    "fixable",
    "The target is motor-driven equipment (pump, fan, conveyor, mixer, compressor).",
    "Choose motor-driven equipment as the target.",
  ),
  "no-link": wiring(
    "fixable",
    "The two devices allow a relationship: wiring, drive, mechanical, measurement, control or a shared protocol.",
    "Pick a pair the rules allow; the designer refuses the rest with this reason.",
  ),
  "link-kind": wiring(
    "fixable",
    "The chosen relationship is one the two devices allow.",
    "Choose one of the relationships the canvas offers for these two devices.",
  ),
  "no-plc-connection": wiring(
    "fixable",
    "The device has a terminal to wire or a protocol the PLC shares.",
    "Choose a device with terminals or a protocol port the PLC has; see the catalog's compatible peripherals.",
  ),
  "no-free-channel": wiring(
    "fixable",
    "A free channel of the required class accepts the terminal's standard.",
    "Free a channel, install a module with such channels (modular PLC), or choose a PLC that has them.",
  ),
  "protocol-port": wiring(
    "unsupported",
    "Both sides have a port for the shared protocol.",
    "Use devices whose catalog models document the protocol's port.",
  ),
  "tag-name": wiring(
    "fixable",
    "A free tag name can be derived from the device and terminal.",
    "Rename the device so its tags do not collide, then wire it again.",
  ),

  // --- PLC architecture and configuration (lib/validation/plc-architecture.ts, plc-config-service.ts)
  "plc-programmable": devices(
    "unsupported",
    "A PLC is created from a programmable controller model.",
    "Choose a PLC or RTU model from the catalog.",
  ),
  "plc-architecture-required": devices(
    "unsupported",
    "A programmable controller model declares COMPACT or MODULAR.",
    "The catalog record is incomplete; choose another model.",
  ),
  "architecture-plc-only": devices(
    "unsupported",
    "Only programmable controllers have an architecture.",
    "Create the device in the designer; the new-PLC form is for controllers.",
  ),
  "plc-only": devices(
    "fixable",
    "The operation is on a PLC.",
    "Open the device's own screens; PLC screens are for controllers.",
  ),
  "plc-model": devices("fixable", "The model is a PLC or RTU of the catalog.", "Pick a model from the form's list."),
  "rack-profile": devices(
    "unsupported",
    "The catalog documents a rack for the CPU's family.",
    "Choose another modular CPU; this one's rack is not in the catalog.",
  ),
  "rack-modular-only": plc(
    "unsupported",
    "Only a modular PLC has a rack.",
    "A compact PLC uses its built-in I/O; choose a modular model when modules are needed.",
  ),
  "compact-built-in-only": plc(
    "unsupported",
    "A compact PLC takes I/O from built-in channels.",
    "Use the built-in channels, or choose a modular PLC.",
  ),
  "built-in-requires-onboard-io": plc(
    "fixable",
    "The model documents built-in I/O.",
    "Install a module (modular PLC) or choose a model with built-in I/O.",
  ),
  "modular-only": plc("unsupported", "Only a modular PLC takes modules.", "Choose a modular PLC for modules."),
  "slot-in-range": plc("fixable", "The slot exists in the rack.", "Choose a slot number within the rack's slots."),
  "slot-range": plc(
    "fixable",
    "The module goes in the slots its family allows.",
    "Choose a slot in the module's allowed range.",
  ),
  "module-slot-range": plc(
    "fixable",
    "The slot is one the module may occupy.",
    "Choose a slot in the module's allowed range.",
  ),
  "slot-free": plc("fixable", "The slot is free.", "Choose a free slot, or remove the module in it first."),
  "slot-occupied": plc("fixable", "The slot is free.", "Choose a free slot, or remove the module in it first."),
  "module-cpu-compatible": plc(
    "fixable",
    "The module is compatible with the CPU model.",
    "Choose a module the install form offers; it lists compatible ones only.",
  ),
  "module-compatibility": plc(
    "fixable",
    "The module is compatible with the CPU model.",
    "Choose a module the install form offers.",
  ),
  "module-in-use": plc(
    "state",
    "No wired channel is on the module.",
    "Disconnect the devices wired to the module in the designer, then remove it.",
  ),
  "runtime-exists": plc(
    "state",
    "The PLC has no runtime container.",
    "Remove the runtime on the PLC's Runtime screen, then delete the PLC.",
  ),
  "io-point-limit": plc(
    "unsupported",
    "The PLC has room for another point of that class.",
    "Choose a PLC or module with more points of that class.",
  ),

  // --- tags and addresses (lib/validation/tag.ts, tag-service.ts, located-address.ts)
  "writable-role": tags(
    "unsupported",
    "Only COMMAND and SETPOINT tags are written from outside.",
    "Write the command or setpoint tag the program reads; feedback and status are the program's.",
  ),
  "tag-read-only": tags(
    "unsupported",
    "The tag is externally writable (command or setpoint memory).",
    "Write the matching command or setpoint tag instead.",
  ),
  "writable-area": tags(
    "unsupported",
    "The Modbus area is writable (coils, holding registers).",
    "Map a writable tag to a coil or holding register.",
  ),
  "data-type-area": tags(
    "fixable",
    "The data type fits the Modbus area (BOOL in coils and discrete inputs, numbers in registers).",
    "Choose an area that fits the type, or a type that fits the area.",
  ),
  "data-type-size": tags(
    "fixable",
    "The data type fits the located address's size.",
    "Use a type of the address's size, or an address of the type's size.",
  ),
  "address-overlap": tags(
    "fixable",
    "Registers of different tags do not overlap.",
    "Choose a free address; multi-word values take every word.",
  ),
  "role-area": tags(
    "fixable",
    "A command or setpoint tag sits on a writable address (%Q or %M).",
    "Give the tag a %Q or %M address.",
  ),
  "io-point-read-only": tags(
    "unsupported",
    "A command or setpoint tag is not on a PLC I/O point: the scan cycle owns local I/O (ADR-0015).",
    "Put command memory on a %M address the program reads; the program drives the output.",
  ),
  "io-point-address": tags(
    "fixable",
    "A tag on an I/O point is created by wiring a device to it.",
    "Wire the device in the designer; the tag follows.",
  ),
  "signal-bound": tags("fixable", "A device signal is wired to one tag.", "Use the existing tag, or unwire it first."),
  "signal-device": tags("fixable", "A device signal names its device.", "Choose the device the signal belongs to."),
  "device-signal": tags(
    "fixable",
    "The device's behaviour model has the signal.",
    "Choose one of the device's documented signals.",
  ),
  "signal-data-type": tags(
    "fixable",
    "The tag's data type matches the signal's (BOOL for on/off, a number otherwise).",
    "Change the tag's type to the signal's.",
  ),
  "signal-plc-driven": tags(
    "fixable",
    "A signal the PLC drives is a program output, not an external command.",
    "Give the tag a role other than COMMAND or SETPOINT and let the program drive it.",
  ),
  "signal-address": tags(
    "fixable",
    "A device input is driven from a PLC output (%Q) or memory (%M) address.",
    "Use a %Q or %M address for the tag.",
  ),
  "simulated-device": tags(
    "unsupported",
    "The device is simulated.",
    "Only simulated devices have signals to wire; this one is configured, not simulated.",
  ),

  // --- process modules (lib/domain/process-module.ts, process-module-service.ts, module-io-service.ts)
  "module-profile": modules(
    "unsupported",
    "The module type has profiles.",
    "Choose another module type; this one defines no profile.",
  ),
  "module-config": modules("fixable", "The setting exists in the module type.", "Use the settings the form shows."),
  "module-profile-in-use": modules(
    "state",
    "No device is assigned to a role the new profile does not have.",
    "Unassign the device from that role, then change the profile.",
  ),
  "module-role-empty": modules(
    "fixable",
    "Every required role of the module has a device.",
    "Assign a device of the role's category in the module editor, or choose a profile that does not require the role.",
  ),
  "module-role-profile": modules(
    "fixable",
    "The role exists in the selected profile.",
    "Choose a role of the profile, or change the profile.",
  ),
  "module-device-factory": modules(
    "unsupported",
    "The device is in the module's factory.",
    "Choose a device of this factory.",
  ),
  "module-role-category": modules(
    "fixable",
    "The device's category is one the role accepts.",
    "Choose a device of an accepted category; the editor lists them.",
  ),
  "module-role-full": modules(
    "fixable",
    "The role has room for another device.",
    "Unassign a device from the role, or use another role.",
  ),
  "module-interlock": modules(
    "fixable",
    "The interlock refers to the module's signals and reads correctly.",
    "Correct the interlock's expression to the module's signals.",
  ),
  "module-signal-profile": modules(
    "fixable",
    "The signal exists in the selected profile.",
    "Bind a signal of the profile.",
  ),
  "module-signal-direction": modules(
    "unsupported",
    "Only input, output and alarm signals are bound to tags.",
    "Internal signals stay in the process model; nothing to bind.",
  ),
  "tag-mapped": modules(
    "fixable",
    "The tag carries no other module's signal.",
    "Choose another tag, or unbind it from the other module first.",
  ),
  "signal-unbound": modules("state", "Every required signal is bound.", "Bind the signal to a PLC tag, then run."),
  "module-io-type": modules(
    "fixable",
    "The import document is for this module's type and version.",
    "Import a document exported from a module of the same type and version.",
  ),
  "module-io-profile": modules(
    "fixable",
    "The import document is for this module's profile.",
    "Change the profile, or import a document of this profile.",
  ),
  "module-io-tag": modules(
    "fixable",
    "Every tag named in the document exists on the named PLC of this factory.",
    "Create or rename the tags, or edit the document's names.",
  ),
  "duplicate-signal": modules("fixable", "A signal is listed once.", "Remove the duplicate line."),
  "module-type-version": catalog(
    "unsupported",
    "A module type version's content never changes.",
    "Publish the change as a new version of the type.",
  ),

  // --- gateways and PLC links (gateway-service.ts, lib/domain/gateway.ts, plc-communication-service.ts)
  "gateway-unmapped": gateways(
    "fixable",
    "Every register the request touches is mapped to a PLC tag on the gateway.",
    "Map the registers on the gateway page, or address only mapped registers from the client.",
  ),
  "gateway-read-only": gateways(
    "fixable",
    "A write touches only registers whose tag is a command or setpoint.",
    "Write to a command or setpoint register; read status registers instead of writing them.",
  ),
  "gateway-partial-value": gateways(
    "fixable",
    "A write covers each multi-register value whole.",
    "Write all the registers of the value in one request, starting at its first register.",
  ),
  "gateway-model-required": gateways(
    "state",
    "The catalog has a gateway model.",
    "Run npm run db:seed to load the catalog.",
  ),
  "gateway-same-factory": gateways("fixable", "The PLC is in this factory.", "Choose a PLC of this factory."),
  "gateway-write-command-only": gateways(
    "unsupported",
    "A gateway writes command and setpoint tags only.",
    "Expose the tag as READ; write access is for command and setpoint tags.",
  ),
  "plc-link-factory": communication("unsupported", "Both PLCs are in this factory.", "Link PLCs of one factory."),
  "plc-link-one-writer": communication(
    "fixable",
    "A value has one writer: a tag is filled by one link, a server tag written by one client.",
    "Choose another local tag, or remove the mapping that already fills it.",
  ),

  // --- factory configuration (factory-service.ts, lib/validation/network.ts, demo-service.ts)
  "subnet-check-unavailable": factory(
    "unavailable",
    "The Docker host answers, so the subnet can be checked against its networks.",
    "Check the Runtime page and the Docker host; save the factory again once it is reachable.",
  ),
  "subnet-overlap": factory(
    "fixable",
    "The subnet overlaps no other factory's.",
    "Use the suggested free subnet, or another /16 to /28 that overlaps none.",
  ),
  "subnet-change-requires-stopped": factory(
    "state",
    "The factory is stopped.",
    "Stop the factory on the Runtime page, then change the subnet.",
  ),
  "delete-requires-stopped": factory(
    "state",
    "The factory is stopped.",
    "Stop the factory on the Runtime page, then delete it.",
  ),
  "demo-catalog-required": factory(
    "state",
    "The catalog holds the demo's models.",
    "Run npm run db:seed, then create the demo again.",
  ),

  // --- device parameters (device-detail-service.ts)
  "parameters-capability": devices(
    "unsupported",
    "The model is parameter-configurable.",
    "This model has nothing to configure.",
  ),
  "parameters-undefined": devices(
    "unsupported",
    "The model defines a parameter set.",
    "No parameters are defined for the model yet.",
  ),
  "parameters-field": devices("fixable", "The parameter exists for the model.", "Use the fields the form shows."),

  // --- export and edge (plc-export-service.ts, edge-deployment-service.ts, catalog-service.ts)
  "export-redaction": exportArea(
    "unavailable",
    "The export contains no secret, container id or host path.",
    "Nothing to change in the design; report it: the export is stopped until the data is removed.",
  ),
  "edge-endpoint-required": exportArea(
    "state",
    "The PLC has a Modbus endpoint, or the host and port are given.",
    "Start the PLC's runtime once, or pass host and port in the download's query.",
  ),
  "edge-mapping-count": exportArea(
    "unsupported",
    "An edge deployment carries at most the documented number of tags.",
    "Export fewer tags, or split the PLC.",
  ),
  "catalog-definition": catalog(
    "unsupported",
    "The catalog definition is well-formed.",
    "Fix the catalog file; this is a seed problem, not a design one.",
  ),
};

/** The explanation of one refusal, for the UI and for an agent. */
export type ValidationExplanation = {
  code: DomainErrorCode;
  rule: string | null;
  kind: RefusalKind;
  /** The condition the rule requires; absent when the rule is unknown. */
  expected?: string;
  /** What actually happened: the message the user sees. */
  actual: string;
  remediation: string;
  /** The engineering area of the LLM Index where the rule is met. */
  area?: string;
  /** The form field at fault, when the error names one. */
  field?: string;
  /** The object and the destination the error names, when it does. */
  object?: string;
  destination?: string;
  /** Other primitive facts the error carries: required, actual, limit, status, slot range… */
  facts: Readonly<Record<string, string | number | boolean>>;
};

const GENERIC: Readonly<Record<DomainErrorCode, { kind: RefusalKind; remediation: string }>> = {
  VALIDATION: { kind: "fixable", remediation: "Correct the input the message names and try again." },
  INCOMPATIBLE: {
    kind: "fixable",
    remediation: "Choose a compatible model, channel, type or address; the message says which.",
  },
  OCCUPIED_ENDPOINT: {
    kind: "fixable",
    remediation: "Choose a free channel, slot, port or tag, or free the occupied one first.",
  },
  CONFLICT: {
    kind: "state",
    remediation: "Change the state the message names first (stop, remove, bind or free something), then try again.",
  },
  NOT_FOUND: {
    kind: "fixable",
    remediation: "Open the object from its own page; it may belong to another factory or no longer exist.",
  },
  INVARIANT: { kind: "unsupported", remediation: "The product does not do this; design around it." },
  UNAUTHORIZED: { kind: "unsupported", remediation: "Sign in as the owner; the application refuses otherwise." },
  RUNTIME_FAILURE: { kind: "unavailable", remediation: "Retry; if it persists, check the Runtime page and the host." },
};

const AREA_BY_PREFIX: ReadonlyArray<[RegExp, string]> = [
  [
    /^(docker|network|host-port|image|env|cpu|memory|publishable|port-range|loopback|managed|runtime|program|compiler|bundle|api|openplc|factory-plc|factory-runtime)/,
    "runtime",
  ],
  [
    /^(simulation|simulated|measured|fault|forcible|step|scenario|nothing-to|process-|monitor|supported-fault)/,
    "simulation",
  ],
  [/^asset/, "catalog"],
  [/^alarm/, "events"],
  [/^modbus|^tag-value/, "tags"],
];

const OBJECT_KEYS = ["tag", "name", "terminal", "signalKey", "module", "deviceId", "what"] as const;
const DESTINATION_KEYS = ["conflictsWith", "signal", "roleKey", "categoryCode"] as const;

const primitive = (value: unknown): value is string | number | boolean =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/**
 * Details that are not facts for a page: the structured parts the explanation reads on its
 * own, and server output (logs, stacks, causes) that stays on the server.
 */
const PRIVATE_KEYS = new Set([
  "rule",
  "field",
  "issues",
  "diagnostics",
  "log",
  "logs",
  "stderr",
  "stdout",
  "output",
  "stack",
  "cause",
  "error",
]);
const FACT_LENGTH = 200;

/** A fact is short; a long text is cut so a page never shows a dump. */
function clip(value: string | number | boolean): string | number | boolean {
  return typeof value === "string" && value.length > FACT_LENGTH ? `${value.slice(0, FACT_LENGTH - 1)}…` : value;
}

function text(value: unknown): string | undefined {
  return primitive(value) ? String(value) : undefined;
}

/** The explanation of a domain error: its rule's entry when the rule is known, a generic one from its code otherwise. */
export function explainDomainError(error: DomainError): ValidationExplanation {
  const rule = typeof error.details.rule === "string" ? error.details.rule : null;
  const known = rule ? RULE_EXPLANATIONS[rule] : undefined;
  const generic = GENERIC[error.code];
  const facts: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(error.details)) {
    if (PRIVATE_KEYS.has(key)) continue;
    if (primitive(value)) facts[key] = clip(value);
    else if (Array.isArray(value) && value.every(primitive)) facts[key] = clip(value.map(String).join(", "));
  }
  const object = OBJECT_KEYS.map((key) => text(error.details[key])).find(Boolean);
  const destination = DESTINATION_KEYS.map((key) => text(error.details[key])).find(Boolean);
  return {
    code: error.code,
    rule,
    kind: known?.kind ?? generic.kind,
    expected: known?.expected,
    actual: error.message,
    remediation: known?.remediation ?? generic.remediation,
    area: known?.area ?? (rule ? AREA_BY_PREFIX.find(([pattern]) => pattern.test(rule))?.[1] : undefined),
    field: text(error.details.field),
    object,
    destination,
    facts,
  };
}

/** The explanation of a rule met outside an error: an issue a page reports from stored state. */
export function explainRule(
  rule: string,
  actual: string,
  extra: Partial<ValidationExplanation> = {},
): ValidationExplanation {
  const known = RULE_EXPLANATIONS[rule];
  return {
    code: "VALIDATION",
    rule,
    kind: known?.kind ?? "fixable",
    expected: known?.expected,
    actual,
    remediation: known?.remediation ?? GENERIC.VALIDATION.remediation,
    area: known?.area,
    facts: {},
    ...extra,
  };
}

/** The explanation as one line, for places that show text only. */
export function explanationLine(explanation: ValidationExplanation): string {
  return [
    explanation.rule ? `rule ${explanation.rule}` : `code ${explanation.code}`,
    explanation.kind,
    explanation.expected ? `expected: ${explanation.expected}` : null,
    `do: ${explanation.remediation}`,
  ]
    .filter(Boolean)
    .join(" · ");
}
