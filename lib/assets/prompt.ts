import "server-only";
import { DomainError } from "@/lib/domain/errors";

/**
 * The text a 3D asset of a catalog model is generated from. It describes a generic shape
 * for the kind of device, never a product: a vendor record contributes only its device
 * category and, for a PLC, whether it is compact or modular. Manufacturer, family, model
 * name and order number are never part of a prompt (docs/references/plc-source-policy.md).
 */

export type PromptModel = {
  modelName: string;
  sku: string | null;
  manufacturer: string;
  family: string;
  categoryCode: string;
  categoryName: string;
  architectureType: "COMPACT" | "MODULAR" | null;
  verificationStatus: "UNVERIFIED" | "VERIFIED" | "GENERIC";
};

export type AssetPrompt = {
  /** What is drawn, e.g. `pressure transmitter`. */
  subject: string;
  /** Models with the same key ask for the same shape and can share one generated file. */
  shapeKey: string;
  prompt: string;
  texturePrompt: string;
};

/** The provider accepts more; a short prompt keeps the shape simple. */
export const MAX_PROMPT_CHARS = 600;

const CABINET =
  "floor-standing sheet-steel enclosure with one closed front door, a swing door handle with lock, visible hinges and a low plinth";
const SMALL_BOX =
  "small rectangular sheet-steel enclosure with a hinged cover, mounted on a slim floor post with a base plate";
const DIN_STAND = "clipped on a short piece of DIN rail on a small upright mounting plate with a base";
const PIPE_STAND = "on a short vertical pipe stub with a flange foot";

/**
 * The form of each device category as such a device is really built, without the
 * features of any one product. A category without a form is described as a plain housing.
 */
const FORMS: Record<string, string> = {
  PLC: `industrial control cabinet, ${CABINET}, three small round indicator lamps on the door and a ventilation grille near the bottom`,
  VFD: "variable-frequency drive, tall rectangular drive unit with a ribbed aluminium heat sink at the back, ventilation slots at the top and bottom, a front cover with a small keypad and a blank display, cable glands underneath, bolted to a floor-standing steel mounting frame",
  SERVO_DRIVE:
    "servo drive, slim tall book-shaped drive unit with a ribbed heat sink on one side, connectors along the front and a small blank display, bolted to a floor-standing steel mounting frame",
  SOFT_STARTER:
    "soft starter, compact rectangular power unit with three large terminals at the top and three at the bottom, a ribbed heat sink behind and a small keypad on the front, bolted to a floor-standing steel mounting frame",
  MOTOR_STARTER: `motor starter, ${SMALL_BOX}, a rotary isolator handle and two push buttons on the cover`,
  MOTION_CONTROLLER: `motion controller, slim module with a row of connectors and status lights on the front, ${DIN_STAND}`,
  PROCESS_CONTROLLER: `process controller, ${SMALL_BOX}, a square controller front with a blank display and four small buttons set in the cover`,
  TEMPERATURE_CONTROLLER: `temperature controller, ${SMALL_BOX}, a square controller front with a blank digital display window and four small buttons set in the cover, cable gland underneath`,
  ROBOT_CONTROLLER: `robot controller cabinet, wide ${CABINET}, a rotary main switch on the door and a mushroom stop button on top`,
  SAFETY_RELAY: `safety relay module, slim module with screw terminals at the top and bottom and status lights on the front, ${DIN_STAND}`,
  REMOTE_IO: `remote input/output station, a row of eight slim terminal modules with a wider head module at the left end, front connectors and rows of small status lights, ${DIN_STAND}`,
  IO_LINK_MASTER: `field connection block, flat rectangular block with eight round threaded connectors in two rows on the front, ${DIN_STAND}`,
  GATEWAY: `industrial network gateway, compact ribbed aluminium box with two network sockets, a green terminal plug and a row of small status lights on the front, ${DIN_STAND}`,
  EDGE_GATEWAY: `industrial edge computer, compact ribbed aluminium heat-sink box with network sockets and status lights on the front, ${DIN_STAND}`,
  SIGNAL_CONDITIONER: `signal conditioner, slim module with screw terminals at the top and bottom, ${DIN_STAND}`,
  TRANSMITTER: `process transmitter, cylindrical housing with two round screw caps lying across a short neck, cable gland at the side, ${PIPE_STAND}`,
  HMI: "operator panel on a pedestal, flat screen housing with a blank dark screen on a column with a base plate",
  RELAY: `plug-in relay, clear rectangular relay cube plugged into a socket with screw terminals, ${DIN_STAND}`,
  CONTACTOR: `three-pole power contactor, blocky moulded housing with three screw terminals in a row at the top and three at the bottom, a raised cover in the middle and an auxiliary contact block on the side, ${DIN_STAND}`,
  MOTOR:
    "three-phase electric motor, horizontal cylindrical body with cooling ribs, fan cover at the back, terminal box on top, short shaft at the front, mounting feet",
  SERVO_MOTOR:
    "servo motor, compact square-flanged body, short shaft at the front, two angled connectors on top, on a small bracket",
  PUMP: "centrifugal pump, round volute casing with a suction flange at the front and a discharge flange on top, bearing housing behind it, on a base plate",
  FAN: "industrial axial fan, short cylindrical duct casing with a flange at each end, an impeller with six blades and its motor inside behind a wire guard, on a floor stand",
  BLOWER:
    "centrifugal blower, snail-shaped scroll housing with a round inlet and a rectangular outlet, motor at the side, on a base frame",
  CONVEYOR: "straight belt conveyor section, flat belt between two side frames with a roller at each end, on four legs",
  MIXER:
    "mixing vessel with agitator, vertical stainless-steel cylindrical tank with a dished bottom on three legs, a geared motor on the top cover driving the mixer shaft, a manhole and two nozzles on the cover, an outlet valve underneath",
  COMPRESSOR:
    "piston air compressor, horizontal cylindrical air receiver on four feet, a two-cylinder compressor pump with finned cylinders and an electric motor with a belt guard on top, a pressure gauge and an outlet pipe",
  VALVE: "valve with a flanged body and an actuator on top, on a short piece of pipe",
  ACTUATOR: "pneumatic cylinder, round barrel with tie rods and a piston rod at the front, on two mounting feet",
  HEATER:
    "electric air heater battery, rectangular sheet-steel frame with rows of finned tubular heating elements across the opening and a terminal box at one end, on two feet",
  POWER_SUPPLY:
    "power supply unit for a mounting rail, compact upright rectangular housing with ventilation slots on the top and sides, a row of screw terminals at the top and at the bottom of the front and a small status light, clipped on a short piece of mounting rail",
  INDICATOR:
    "signal tower light, slim pole on a round base with three stacked cylindrical translucent lens segments in red, amber and green and a black cap on top",
  SENSOR: `process sensor, cylindrical housing with two round screw caps lying across a short neck, cable gland at the side, ${PIPE_STAND}`,
  PROXIMITY_SENSOR:
    "inductive proximity sensor, threaded nickel-plated metal cylinder with a flat plastic sensing face, two hexagonal lock nuts and a cable at the rear, clamped in an angle bracket on a small base",
  SWITCH: "switch in a small box on a slim floor post with a base plate",
  ENCODER:
    "rotary encoder, short cylindrical body with a small shaft at the front and a cable at the side, on an angle bracket",
};

/** Kinds of device a category holds several of: the subject decides the form. */
const REFINED_FORMS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /control valve/,
    "pneumatic control valve, globe valve body with flanged ends, a bonnet and yoke, a large round diaphragm actuator on top and a small positioner box on the yoke, on a short piece of pipe",
  ],
  [
    /on\/off valve/,
    "shut-off valve, ball valve body with flanged ends and a box-shaped actuator on top, on a short piece of pipe",
  ],
  [
    /pressure transmitter/,
    `pressure transmitter, cylindrical housing with two round screw caps lying across a short neck, a blank round display window in one cap, a process flange block underneath and a cable gland at the side, ${PIPE_STAND}. It has no dial and no pointer`,
  ],
  [
    /temperature transmitter/,
    "temperature transmitter, round aluminium connection head with a screw cap and a cable gland, on an extension neck above a mounting flange with a long thin thermowell probe below it, held upright in a pipe tee with a flange foot",
  ],
  [
    /level transmitter/,
    "radar level transmitter, round housing with two screw caps and a cable gland, on a mounting flange with a cone antenna below it, held upright on a short nozzle stand with a flange foot",
  ],
  [
    /flow transmitter/,
    "electromagnetic flow meter, short thick measuring tube with a flange at each end and a round transmitter housing with a blank display window on a neck on top, lying between two pipe supports",
  ],
  [
    /push button/,
    "push-button control station, small rectangular box with one green and one red round push button on the front and a cable gland underneath, on a slim floor post with a base plate",
  ],
  [
    /limit switch/,
    "limit switch, compact rectangular die-cast body with a rotary lever arm and roller on the side of its head and a cable gland at the bottom, bolted to an angle bracket on a short stand",
  ],
  [
    /float switch/,
    "cable float switch, pear-shaped float hanging on a rubber cable with a small counterweight, from a bracket on a slim post with a base plate",
  ],
  [
    /pressure switch/,
    `pressure switch, rectangular housing with a screwed cover, an adjusting screw on top, a threaded pressure port underneath and a cable gland at the side, ${PIPE_STAND}`,
  ],
  [
    // A compact PLC is a device, not a cabinet: one housing with its terminals on board.
    /compact controller/,
    "compact programmable logic controller, wide rectangular dark-grey plastic module, a row of screw terminals under a hinged translucent cover along the top edge and another along the bottom, between them a two-digit display, a nine-pin serial port, a green terminal block and status lights, a mounting ear at each top corner",
  ],
  [
    /modular/,
    `industrial control cabinet, wide ${CABINET.replace("one closed front door", "two closed front doors")}, three small round indicator lamps on one door and a ventilation grille near the bottom`,
  ],
];

const STYLE =
  "Single complete object, centred, standing upright on flat ground, front facing the viewer. Realistic industrial equipment with true proportions and fine mechanical detail, generic and unbranded. No logo, no text, no label, no nameplate, no people, no background.";

/** Devices that are plastic modules on a rail, not painted steel. */
const DIN_RAIL_CATEGORIES = [
  "MOTION_CONTROLLER",
  "SAFETY_RELAY",
  "REMOTE_IO",
  "IO_LINK_MASTER",
  "GATEWAY",
  "EDGE_GATEWAY",
  "SIGNAL_CONDITIONER",
  "RELAY",
  "CONTACTOR",
];

/** Paint by family of equipment, so a scene reads at a glance. Nothing here is a brand colour scheme. */
function paint(categoryCode: string, subject: string): string {
  if (/compact controller/.test(subject)) {
    return "realistic dark grey moulded plastic housing with translucent smoke-grey terminal covers, metal screw terminals, one green terminal block and a red two-digit display";
  }
  if (/push button/.test(subject)) {
    return "realistic light grey painted box with one green and one red push button, on a steel post";
  }
  if (/float switch/.test(subject)) {
    return "realistic dark blue plastic float on a black rubber cable, galvanised steel bracket and post";
  }
  if (categoryCode === "PROXIMITY_SENSOR") {
    return "realistic nickel-plated threaded metal body with a dark plastic sensing face, zinc-plated bracket";
  }
  if (DIN_RAIL_CATEGORIES.includes(categoryCode)) {
    return "realistic light grey moulded plastic housing with metal screw terminals, on a galvanised steel rail and plate";
  }
  if (["MOTOR", "SERVO_MOTOR", "PUMP", "FAN", "BLOWER", "COMPRESSOR"].includes(categoryCode)) {
    return "realistic matte blue-grey machine paint with bare steel shaft and flanges";
  }
  if (categoryCode === "MIXER") return "realistic brushed stainless steel with a blue-grey painted drive";
  if (["VALVE", "ACTUATOR"].includes(categoryCode)) {
    return "realistic light grey cast steel valve body and pipe with a bright blue painted actuator";
  }
  if (categoryCode === "CONVEYOR") return "realistic matte grey steel frame with a black rubber belt";
  if (categoryCode === "INDICATOR") return "black pole and base with glossy red, amber and green light segments";
  if (categoryCode === "POWER_SUPPLY") return "realistic light grey metal housing with a silver mounting rail";
  if (categoryCode === "HEATER") return "realistic galvanised sheet steel with dark metal heating elements";
  if (["SENSOR", "TRANSMITTER", "PROXIMITY_SENSOR", "SWITCH", "ENCODER"].includes(categoryCode)) {
    return "realistic brushed stainless steel and light grey painted aluminium";
  }
  return "realistic matte light-grey powder-coated steel with dark grey details";
}

/**
 * What a generic model is, in a few words: its name without "Generic" and without the
 * electrical detail after the comma (`Generic pressure transmitter, 4–20 mA`).
 */
function genericSubject(modelName: string): string {
  const subject = (modelName.split(",")[0] ?? "")
    .replace(/^generic\s+/i, "")
    .replace(/[^\p{L}\p{N} /-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return subject.slice(0, 60);
}

function subjectOf(model: PromptModel): string {
  if (model.verificationStatus === "GENERIC") {
    const subject = genericSubject(model.modelName);
    if (subject) return subject;
  }
  // A vendor record gives its kind, never its name.
  const kind = (model.categoryName.split(" / ")[0] ?? model.categoryName).toLowerCase();
  if (model.categoryCode === "PLC")
    return model.architectureType === "MODULAR" ? "modular controller cabinet" : "compact controller";
  return kind;
}

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+(?:[-/.][\p{L}\p{N}]+)*/gu) ?? [];

/** Words that say what a device is; they may appear in a prompt even when a vendor's name contains them. */
const COMMON_WORDS = new Set([
  "generic",
  "simulated",
  "cpu",
  "dc",
  "ac",
  "pn",
  "automation",
  "electric",
  "controller",
  "controllers",
  "drives",
  "motors",
  "pumps",
  "valves",
  "switches",
  "sensors",
  "and",
  "the",
  "of",
  "for",
  "st",
  "ba",
]);

/**
 * Names of automation manufacturers and product lines an author might reach for. The
 * catalog's own vendor records are added to it when a prompt is built.
 */
const BRAND_WORDS = [
  "siemens",
  "simatic",
  "sinamics",
  "rockwell",
  "allen-bradley",
  "allen",
  "bradley",
  "compactlogix",
  "controllogix",
  "powerflex",
  "schneider",
  "modicon",
  "altivar",
  "abb",
  "mitsubishi",
  "omron",
  "beckhoff",
  "danfoss",
  "yaskawa",
  "festo",
  "wago",
  "phoenix",
  "endress",
  "hauser",
  "emerson",
  "rosemount",
  "honeywell",
  "grundfos",
  "sew",
  "eurodrive",
  "lenze",
  "keyence",
  "sick",
  "ifm",
  "pepperl",
  "fuchs",
  "eaton",
  "fanuc",
  "kuka",
  "bosch",
  "rexroth",
  "weg",
  "rittal",
  "yokogawa",
  "krohne",
  "vega",
  "burkert",
  "samson",
  "wilo",
  "ksb",
  "nord",
  "baldor",
  "toshiba",
  "fuji",
  "delta",
];

/** The words that would identify a vendor's product: its manufacturer, family, model name and order number. */
function vendorWords(models: readonly PromptModel[]): string[] {
  return models
    .filter((model) => model.verificationStatus !== "GENERIC")
    .flatMap((model) => [model.manufacturer, model.family, model.modelName, model.sku ?? ""])
    .flatMap(words)
    .filter((word) => word.length >= 2 && !COMMON_WORDS.has(word) && !/^\d{1,2}$/.test(word));
}

/**
 * Refuses a text that names a manufacturer, a product family, a model or an order
 * number. Prompts built here cannot; words an author adds are checked the same way.
 */
export function assertGenericPrompt(text: string, vendorModels: readonly PromptModel[]): void {
  const present = new Set(words(text));
  if ([...BRAND_WORDS, ...vendorWords(vendorModels)].some((word) => present.has(word))) {
    throw new DomainError(
      "VALIDATION",
      "A 3D asset is a generic shape: the prompt must not name a manufacturer, product family, model or order number.",
      { rule: "asset-prompt-generic" },
    );
  }
}

export type PromptOptions = {
  /** Words an author adds to the description of the shape. */
  hint?: string;
  /** The catalog's vendor records: none of their names may appear in a prompt. */
  vendorModels?: readonly PromptModel[];
};

export function buildAssetPrompt(model: PromptModel, options: PromptOptions = {}): AssetPrompt {
  const subject = subjectOf(model);
  const form =
    REFINED_FORMS.find(([pattern]) => pattern.test(subject))?.[1] ??
    FORMS[model.categoryCode] ??
    `${subject}, simple rectangular equipment housing on a short floor post`;
  const extra = options.hint?.replace(/\s+/g, " ").trim();
  const prompt = `${/^[aeiou]/i.test(form) ? "An" : "A"} ${form}. ${extra ? `${extra.replace(/\.$/, "")}. ` : ""}${STYLE}`;
  const texturePrompt = `${paint(model.categoryCode, subject)}, plain clean surfaces, no logo, no text, no label, no nameplate`;
  // A name is refused as a name, however long the text around it is.
  assertGenericPrompt(`${prompt} ${texturePrompt}`, [model, ...(options.vendorModels ?? [])]);
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new DomainError("VALIDATION", `The prompt is longer than ${MAX_PROMPT_CHARS} characters.`, {
      rule: "asset-prompt-length",
    });
  }
  return { subject, shapeKey: `${model.categoryCode}:${subject}`.toLowerCase(), prompt, texturePrompt };
}
