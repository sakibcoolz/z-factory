import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DomainError } from "@/lib/domain/errors";
import { explainDomainError, explainRule } from "@/lib/domain/validation-explanations";
import { RefusalExplanation } from "./refusal";

describe("RefusalExplanation", () => {
  it("names the rule, its kind, what is expected, what to do and the facts, for people and agents", () => {
    const explanation = explainDomainError(
      new DomainError("INCOMPATIBLE", "Signal type ANALOG_4_20MA is not accepted by this channel.", {
        rule: "signal-type",
        required: "ANALOG_4_20MA",
        actual: ["DIGITAL_24V"],
        terminal: "OUT",
      }),
    );
    const { container } = render(<RefusalExplanation explanation={explanation} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.dataset.llmRefusal).toBe("signal-type");
    expect(root.dataset.llmRefusalKind).toBe("fixable");
    expect(screen.getByText("rule signal-type")).toBeInTheDocument();
    expect(screen.getByText("fixable")).toHaveAttribute("data-tone", "deg");
    expect(screen.getByText("object OUT")).toBeInTheDocument();
    expect(screen.getByText(`Expected: ${explanation.expected}`)).toBeInTheDocument();
    expect(screen.getByText(`Do: ${explanation.remediation}`)).toBeInTheDocument();
    expect(screen.getByText("required=ANALOG_4_20MA · actual=DIGITAL_24V · terminal=OUT")).toBeInTheDocument();
  });

  it("falls back to the code when no rule is known, and shows no expectation it does not have", () => {
    const { container } = render(
      <RefusalExplanation
        explanation={explainDomainError(new DomainError("NOT_FOUND", "The device does not exist."))}
      />,
    );
    expect((container.firstElementChild as HTMLElement).dataset.llmRefusal).toBe("NOT_FOUND");
    expect(screen.getByText("code NOT_FOUND")).toBeInTheDocument();
    expect(screen.queryByText(/^Expected:/)).toBeNull();
    expect(screen.getByText(/^Do: Open the object/)).toBeInTheDocument();
  });

  it("labels the kinds in plain words", () => {
    render(
      <RefusalExplanation
        explanation={explainRule("subnet-check-unavailable", "Docker is down.", { destination: "PLC-01" })}
      />,
    );
    expect(screen.getByText("unavailable")).toHaveAttribute("data-tone", "flt");
    expect(screen.getByText("destination PLC-01")).toBeInTheDocument();
  });
});
