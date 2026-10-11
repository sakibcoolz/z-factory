/**
 * The LLM Context of a page (TASK-1002): the structured summary an external browser agent
 * reads beside the page's normal content. Every page builds the same document, with the
 * same ten sections in the same order, from the data it renders for people, so what the
 * agent reads and what the person sees never disagree.
 *
 * Pure: a page's builder (`lib/agent/contexts/*`) takes the view models the page already
 * loaded and returns a document; `components/agent/llm-context.tsx` renders it.
 */

import { explanationLine, type ValidationExplanation } from "@/lib/domain/validation-explanations";
import { buildLlmIndex } from "./llm-index";
import { crossPageLinks, routeIds } from "./navigation";

export const LLM_CONTEXT_VERSION = 1;

export const LLM_CONTEXT_SECTIONS = [
  { id: "identity", title: "Page identity" },
  { id: "context", title: "Current context" },
  { id: "objects", title: "Available objects and resources" },
  { id: "relationships", title: "Current relationships" },
  { id: "capacity", title: "Capacity and availability" },
  { id: "validation", title: "Validation state" },
  { id: "actions", title: "Available user actions" },
  { id: "constraints", title: "Engineering constraints" },
  { id: "decisions", title: "Missing decisions and recommended questions" },
  { id: "navigation", title: "Navigation guidance" },
] as const;

export type LlmContextSectionId = (typeof LLM_CONTEXT_SECTIONS)[number]["id"];

/** The sections that are lists of items; identity and validation have their own shape. */
export type LlmContextListSectionId = Exclude<LlmContextSectionId, "identity" | "validation">;

export const LLM_CONTEXT_LIST_SECTIONS: readonly LlmContextListSectionId[] = [
  "context",
  "objects",
  "relationships",
  "capacity",
  "actions",
  "constraints",
  "decisions",
  "navigation",
];

export type LlmContextTone = "ok" | "info" | "warn" | "fault";

/** One line of a section: what it is, its value, where it leads, and why it matters. */
export type LlmContextItem = {
  label: string;
  value?: string;
  /** A route of the application, when the item is something the agent can open. */
  href?: string;
  /** A sentence more, when the label and value are not enough. */
  detail?: string;
  tone?: LlmContextTone;
  /** For a navigation item: whether the area comes before or after this page (TASK-1004). */
  relation?: "upstream" | "downstream";
  /** For a validation item: the rule behind it, what it requires and what to do (TASK-1007). */
  explanation?: ValidationExplanation;
};

/**
 * The kinds of engineering decision an agent asks the user for (TASK-1006), and what each
 * means. A decision names its kind, whether the user must confirm before the agent acts,
 * a safe default when one exists, and what the application enforces whatever is chosen.
 */
export const DECISION_KINDS = {
  model: "which catalog model: a vendor hardware profile with sources, or a generic simulated one",
  architecture: "compact or modular PLC",
  "signal-standard": "which signal standard, when a terminal or channel accepts more than one",
  channel: "which channel, point or tag, when more than one is free and compatible",
  protocol: "which protocol, when a port or device offers more than one",
  relationship: "which relationship or role between devices, when more than one applies",
  endpoint: "which host, port, PLC or peer to connect to",
  "control-logic": "the control strategy, setpoints and interlocks of a program",
  "run-state": "starting, stopping, deploying to or rewiring a running plant",
  write: "a value written to a command or setpoint tag of a running plant",
  "test-input": "a fault, override or scenario applied to a running plant",
  parameters: "parameter values that change how a device behaves",
  scope: "what the plant, a PLC or a module should do",
  name: "a name, slug, role or subnet",
  deletion: "deleting or removing something that holds configuration or history",
} as const;

export type DecisionKind = keyof typeof DECISION_KINDS;

export type DecisionGuidance = {
  kind: DecisionKind;
  /** `required`: the agent acts only when the user confirms. `optional`: a safe default may be applied and reported. */
  confirm: "required" | "optional";
  /** A safe default the agent may recommend, when one exists. */
  defaultChoice?: string;
  /** What the application enforces whatever the user chooses; guidance never overrides it. */
  enforced?: string;
};

/** A missing decision: an item of the decisions section, always with its guidance. */
export type LlmContextDecisionItem = LlmContextItem & { decision: DecisionGuidance };

/** The rule every decision follows, stated once for agents. */
export const DECISION_RULE =
  "Recommend a safe default when one exists and say why. Apply a material engineering choice only when the user confirms it. Whatever is chosen, the application's compatibility and validation rules decide what is possible; guidance never overrides them.";

export type LlmContextIdentity = {
  /** The page, as the LLM Index names it. */
  page: string;
  /** The engineering area of the LLM Index the page belongs to. */
  area: string;
  /** The page's own route. */
  route: string;
  /** The route's pattern, as the LLM Index lists it. */
  routePattern: string;
  /** What the page is about: the factory, PLC or device by name. */
  subject: string;
  /** One or two sentences on what this page is for. */
  summary: string;
};

export type LlmContextValidation = {
  /** `issues` when anything on the page needs attention; `unknown` when it could not be checked. */
  status: "ok" | "issues" | "unknown";
  items: readonly LlmContextItem[];
};

export type LlmContextDocument = {
  version: typeof LLM_CONTEXT_VERSION;
  identity: LlmContextIdentity;
  validation: LlmContextValidation;
  decisions: readonly LlmContextDecisionItem[];
} & Record<Exclude<LlmContextListSectionId, "decisions">, readonly LlmContextItem[]>;

type ListParts = Partial<Record<Exclude<LlmContextListSectionId, "decisions">, readonly LlmContextItem[]>> & {
  decisions?: readonly LlmContextDecisionItem[];
};

/**
 * A complete document from an identity and whatever sections the page has. Missing list
 * sections are empty, and the validation status follows its items unless given. The
 * navigation ends with the areas before and after this page's area (TASK-1004), generated
 * from `AREA_GUIDANCE` with the ids the page's route carries, except those the page
 * already links.
 */
export function createLlmContext(
  identity: LlmContextIdentity,
  parts: ListParts & { validation?: Partial<LlmContextValidation> } = {},
): LlmContextDocument {
  const validationItems = parts.validation?.items ?? [];
  const status =
    parts.validation?.status ??
    (validationItems.some((item) => item.tone === "warn" || item.tone === "fault") ? "issues" : "ok");
  const document = {
    version: LLM_CONTEXT_VERSION,
    identity,
    validation: { status, items: validationItems },
  } as LlmContextDocument;
  for (const section of LLM_CONTEXT_LIST_SECTIONS) {
    (document as Record<string, unknown>)[section] = parts[section] ?? [];
  }
  document.navigation = [...document.navigation, ...crossPageNavigation(identity, document.navigation)];
  return document;
}

/** The upstream and downstream areas of a page as navigation items, minus those already linked. */
function crossPageNavigation(identity: LlmContextIdentity, existing: readonly LlmContextItem[]): LlmContextItem[] {
  const linked = new Set(existing.map((item) => item.href).filter(Boolean));
  const areas = new Map(buildLlmIndex().areas.map((area) => [area.key, area]));
  return crossPageLinks(identity.area, routeIds(identity.route))
    .filter((link) => link.area !== identity.area && !(link.href && linked.has(link.href)))
    .map((link) => {
      const area = areas.get(link.area);
      return {
        label: area?.label ?? link.area,
        href: link.href,
        detail: area?.purpose,
        relation: link.relation,
      };
    });
}

export function sectionTitle(id: LlmContextSectionId): string {
  return LLM_CONTEXT_SECTIONS.find((section) => section.id === id)!.title;
}

function itemLine(item: LlmContextItem | LlmContextDecisionItem): string {
  const name = item.relation ? `${item.relation === "upstream" ? "Before" : "After"}: ${item.label}` : item.label;
  const head = item.href ? `[${name}](${item.href})` : name;
  const parts = [item.value ? `${head}: ${item.value}` : head];
  if (item.detail) parts.push(item.detail);
  if (item.explanation) parts.push(explanationLine(item.explanation));
  if ("decision" in item && item.decision) {
    const { kind, confirm, defaultChoice, enforced } = item.decision;
    parts.push(
      [
        `${kind}`,
        confirm === "required" ? "confirm before acting" : "a default may be applied",
        defaultChoice ? `default: ${defaultChoice}` : null,
        enforced ? `enforced: ${enforced}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    );
  }
  const line = parts.join(" — ");
  return item.tone && item.tone !== "info" ? `- ${line} (${item.tone})` : `- ${line}`;
}

/** The document as Markdown: the same sections, one heading each. */
export function renderLlmContextMarkdown(document: LlmContextDocument): string {
  const { identity, validation } = document;
  const parts: string[] = [
    `# LLM Context — ${identity.page}: ${identity.subject}`,
    "",
    `## ${sectionTitle("identity")}`,
    "",
    `- Page: ${identity.page}`,
    `- Area: ${identity.area}`,
    `- Route: \`${identity.route}\` (pattern \`${identity.routePattern}\`)`,
    `- Subject: ${identity.subject}`,
    `- Summary: ${identity.summary}`,
    "",
  ];
  for (const section of LLM_CONTEXT_SECTIONS) {
    if (section.id === "identity") continue;
    parts.push(`## ${section.title}`, "");
    if (section.id === "validation") {
      parts.push(`Status: ${validation.status}`, "");
      parts.push(validation.items.length > 0 ? validation.items.map(itemLine).join("\n") : "None.", "");
      continue;
    }
    const items = document[section.id];
    parts.push(items.length > 0 ? items.map(itemLine).join("\n") : "None.", "");
  }
  return `${parts.join("\n").trimEnd()}\n`;
}
