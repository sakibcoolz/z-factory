import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import LlmIndexPage from "@/app/llm-index/page";
import { GET } from "@/app/llm-index.md/route";
import { buildLlmIndex } from "@/lib/agent/llm-index";
import { LLM_INDEX_SECTIONS, renderLlmIndexMarkdown } from "@/lib/agent/llm-index-markdown";

/** The LLM Index page and its Markdown twin (TASK-1001). Neither needs a database or an owner. */
describe("the LLM Index page", () => {
  const index = buildLlmIndex();

  it("is its own activity and links to the Markdown version", () => {
    render(<LlmIndexPage />);
    const activities = within(screen.getByRole("navigation", { name: "Activities" }));
    expect(activities.getByLabelText("LLM Index")).toHaveAttribute("aria-current", "page");
    expect(activities.getByLabelText("LLM Index")).toHaveAttribute("href", "/llm-index");
    expect(screen.getByRole("heading", { level: 1, name: "LLM Index" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Markdown" })).toHaveAttribute("href", "/llm-index.md");
  });

  it("has one named section per part, and one article per area with its routes", () => {
    const { container } = render(<LlmIndexPage />);
    for (const section of LLM_INDEX_SECTIONS) {
      const element = container.querySelector(`section[data-llm-section="${section.id}"]`);
      expect(element, section.id).not.toBeNull();
      expect(
        within(element as HTMLElement).getByRole("heading", { level: 2, name: section.title }),
      ).toBeInTheDocument();
    }
    for (const area of index.areas) {
      const element = container.querySelector(`article[data-llm-area="${area.key}"]`) as HTMLElement | null;
      expect(element, area.key).not.toBeNull();
      for (const route of area.routes) expect(within(element!).getByText(route.pattern)).toBeInTheDocument();
    }
    // A route without placeholders is a link an agent can follow.
    expect(screen.getByRole("link", { name: "/catalog" })).toHaveAttribute("href", "/catalog");
  });

  it("names the rules and the workflow", () => {
    render(<LlmIndexPage />);
    for (const rule of index.rules)
      expect(screen.getByRole("heading", { level: 3, name: rule.title })).toBeInTheDocument();
    expect(screen.getAllByText(/Read this index/)).toHaveLength(1);
  });
});

describe("GET /llm-index.md", () => {
  it("returns the same index as Markdown, uncached", async () => {
    const response = GET();
    expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe(renderLlmIndexMarkdown(buildLlmIndex()));
  });
});
