/**
 * The LLM Context of a page (TASK-1002): the structured summary an external browser agent
 * reads beside the page's normal content. Every page builds the same document, with the
 * same ten sections in the same order, from the data it renders for people, so what the
 * agent reads and what the person sees never disagree.
 *
 * Pure: a page's builder (`lib/agent/contexts/*`) takes the view models the page already
 * loaded and returns a document; `components/agent/llm-context.tsx` renders it.
 */

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
};

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
} & Record<LlmContextListSectionId, readonly LlmContextItem[]>;

type ListParts = Partial<Record<LlmContextListSectionId, readonly LlmContextItem[]>>;

/**
 * A complete document from an identity and whatever sections the page has. Missing list
 * sections are empty, and the validation status follows its items unless given.
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
  for (const section of LLM_CONTEXT_LIST_SECTIONS) document[section] = parts[section] ?? [];
  return document;
}

export function sectionTitle(id: LlmContextSectionId): string {
  return LLM_CONTEXT_SECTIONS.find((section) => section.id === id)!.title;
}

function itemLine(item: LlmContextItem): string {
  const head = item.href ? `[${item.label}](${item.href})` : item.label;
  const parts = [item.value ? `${head}: ${item.value}` : head];
  if (item.detail) parts.push(item.detail);
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
