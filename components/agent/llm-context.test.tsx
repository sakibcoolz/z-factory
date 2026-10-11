import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createLlmContext, LLM_CONTEXT_SECTIONS } from "@/lib/agent/llm-context";
import { explainRule } from "@/lib/domain/validation-explanations";
import { LlmContextPanel } from "./llm-context";

const document = createLlmContext(
  {
    page: "Factory overview",
    area: "factory",
    route: "/factories/f1",
    routePattern: "/factories/[factoryId]",
    subject: "Pump House",
    summary: "One factory.",
  },
  {
    context: [{ label: "Runtime state", value: "Stopped" }],
    actions: [{ label: "Edit factory", href: "/factories/f1/edit", detail: "Name and description." }],
    validation: {
      items: [
        { label: "No PLC", detail: "A factory without a PLC cannot start.", tone: "warn" },
        {
          label: "Tank T-01: Level sensor has no device.",
          tone: "warn",
          explanation: explainRule("module-role-empty", "Level sensor has no device.", { object: "Tank T-01" }),
        },
      ],
    },
  },
);

describe("the LLM Context panel", () => {
  it("is a closed details element that names its page and area for agents", () => {
    const { container } = render(<LlmContextPanel document={document} />);
    const details = container.querySelector("details[data-llm-context]") as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(details.dataset.llmContext).toBe("factory");
    expect(details.dataset.llmPage).toBe("Factory overview");
    expect(details.dataset.llmVersion).toBe("1");
    expect(screen.getByText("LLM Context · Pump House · validation issues")).toBeInTheDocument();
  });

  it("has the ten sections in the fixed order, each labelled, with None. where there is nothing", () => {
    const { container } = render(<LlmContextPanel document={document} />);
    const sections = [...container.querySelectorAll("section[data-llm-section]")];
    expect(sections.map((section) => section.getAttribute("data-llm-section"))).toEqual(
      LLM_CONTEXT_SECTIONS.map((section) => section.id),
    );
    for (const section of LLM_CONTEXT_SECTIONS) {
      expect(screen.getByRole("region", { name: section.title })).toBeInTheDocument();
    }
    const identity = within(screen.getByRole("region", { name: "Page identity" }));
    expect(identity.getByText("/factories/f1")).toBeInTheDocument();
    expect(identity.getByText("(/factories/[factoryId])")).toBeInTheDocument();
    const actions = within(screen.getByRole("region", { name: "Available user actions" }));
    expect(actions.getByRole("link", { name: "Edit factory" })).toHaveAttribute("href", "/factories/f1/edit");
    expect(actions.getByText("Name and description.")).toBeInTheDocument();
    const validation = within(screen.getByRole("region", { name: "Validation state" }));
    expect(validation.getByText("issues")).toHaveAttribute("data-tone", "deg");
    expect(validation.getByText("No PLC").closest("li")).toHaveAttribute("data-tone", "warn");
    // A validation item with a rule behind it carries the rule's explanation (TASK-1007).
    const refusal = validation.getByText("rule module-role-empty").closest("[data-llm-refusal]") as HTMLElement;
    expect(refusal.dataset.llmRefusalKind).toBe("fixable");
    expect(refusal).toHaveTextContent("object Tank T-01");
    expect(refusal).toHaveTextContent(/Expected: Every required role/);
    expect(screen.getAllByText("None.")).toHaveLength(5);
    // The generated cross-page links say whether the area comes before or after this page.
    const navigation = within(screen.getByRole("region", { name: "Navigation guidance" }));
    expect(navigation.getAllByText("before").length).toBeGreaterThan(0);
    expect(navigation.getByRole("link", { name: "Factories" })).toHaveAttribute("href", "/factories");
  });

  it("carries the whole document as JSON an agent can parse", () => {
    const { container } = render(<LlmContextPanel document={document} />);
    const script = container.querySelector("script[data-llm-context-json]") as HTMLScriptElement;
    expect(script.type).toBe("application/json");
    expect(JSON.parse(script.textContent ?? "")).toEqual(document);
  });
});
