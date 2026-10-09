import { areasWithLlmContext, type LlmIndex } from "./llm-index";

/** Section ids, shared by the page's anchors and the Markdown headings. */
export const LLM_INDEX_SECTIONS = [
  { id: "product", title: "What Z-Factory is" },
  { id: "activities", title: "Activity bar" },
  { id: "areas", title: "Engineering areas and routes" },
  { id: "llm-context", title: "Pages with an LLM Context tab" },
  { id: "files", title: "Files an agent can fetch" },
  { id: "workflow", title: "Recommended agent workflow" },
  { id: "rules", title: "Rules for agents" },
] as const;

export type LlmIndexSectionId = (typeof LLM_INDEX_SECTIONS)[number]["id"];

export function sectionTitle(id: LlmIndexSectionId): string {
  return LLM_INDEX_SECTIONS.find((section) => section.id === id)!.title;
}

const cell = (text: string) => text.replace(/\|/g, "\\|");
const list = (items: readonly string[]) => items.map((item) => `- ${item}`).join("\n");

/** The index as Markdown, the same content as the `/llm-index` page. */
export function renderLlmIndexMarkdown(index: LlmIndex): string {
  const areaLabel = (key: string) => index.areas.find((area) => area.key === key)?.label ?? key;
  const withContext = areasWithLlmContext(index);

  const parts: string[] = [
    `# ${index.product.name} — LLM Index`,
    "",
    "The guide an external browser or coding agent reads before using Z-Factory. It is generated from the application's route registry, so it lists exactly the screens that exist. There is no embedded model and no MCP: an agent uses the normal pages and controls, and asks the user for the decisions listed below.",
    "",
    `## ${sectionTitle("product")}`,
    "",
    index.product.purpose,
    "",
    "**Engineering model**",
    "",
    list(index.product.model),
    "",
    "**What is real and what is simulated**",
    "",
    list(index.product.reality),
    "",
    `## ${sectionTitle("activities")}`,
    "",
    "Every page shows these entries on its left edge. Factory-scoped entries open once a factory is open.",
    "",
    "| Entry | Label | Scope |",
    "|---|---|---|",
    ...index.activities.map(
      (activity) => `| ${activity.short} | ${activity.label} | ${activity.factoryScoped ? "factory" : "workspace"} |`,
    ),
    "",
    `## ${sectionTitle("areas")}`,
    "",
    "Placeholders in routes:",
    "",
    list(index.placeholders.map((placeholder) => `\`[${placeholder.name}]\`: ${placeholder.meaning}`)),
    "",
  ];

  for (const area of index.areas) {
    parts.push(
      `### ${area.label}`,
      "",
      area.purpose,
      "",
      `- Scope: ${area.scope}${area.activity ? `; activity bar: ${area.activity.toUpperCase()}` : "; reached from another page"}`,
      `- LLM Context tab: ${area.llmContext ? "yes" : "not yet"}`,
      "",
      "| Route | What it is |",
      "|---|---|",
      ...area.routes.map((route) => `| \`${route.pattern}\` | ${cell(route.note ?? "")} |`),
      "",
      "Bring here:",
      "",
      list(area.tasks),
      "",
    );
    if (area.decisions.length > 0) parts.push("Ask the user for:", "", list(area.decisions), "");
  }

  parts.push(
    `## ${sectionTitle("llm-context")}`,
    "",
    withContext.length > 0
      ? `These areas have an LLM Context tab with the page's objects, relationships, validation state, available actions and missing decisions: ${withContext.map((area) => area.label).join(", ")}.`
      : "None yet. The LLM Context tab is added to every active engineering page by TASK-1002 and TASK-1003; until then, read each page's normal content.",
    "",
    `## ${sectionTitle("files")}`,
    "",
    "| Route | What it is |",
    "|---|---|",
    ...index.files.map((file) => `| \`${file.pattern}\` | ${cell(file.purpose)} |`),
    "",
    `## ${sectionTitle("workflow")}`,
    "",
    ...index.workflow.map((step, number) => `${number + 1}. **${areaLabel(step.area)}:** ${step.text}`),
    "",
    `## ${sectionTitle("rules")}`,
    "",
    ...index.rules.flatMap((rule) => [`### ${rule.title}`, "", rule.text, "", `Source: ${rule.source}`, ""]),
  );

  return `${parts.join("\n").trimEnd()}\n`;
}
