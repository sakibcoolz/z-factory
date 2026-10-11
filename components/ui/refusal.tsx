import { StatePill, type Tone } from "@/components/ui/state-pill";
import type { RefusalKind, ValidationExplanation } from "@/lib/domain/validation-explanations";

const KIND_TONE: Record<RefusalKind, Tone> = { fixable: "deg", unsupported: "flt", state: "off", unavailable: "flt" };
const KIND_LABEL: Record<RefusalKind, string> = {
  fixable: "fixable",
  unsupported: "not supported",
  state: "not now",
  unavailable: "unavailable",
};

type RefusalExplanationProps = {
  explanation: ValidationExplanation;
  className?: string;
};

/**
 * Why an operation was refused, for people and agents alike (TASK-1007): the rule, its
 * kind, the condition it requires, what to do, and the facts the error carries. The same
 * `ValidationExplanation` the LLM Context shows, so both read from one source.
 */
export function RefusalExplanation({ explanation, className }: RefusalExplanationProps) {
  const facts = Object.entries(explanation.facts);
  return (
    <div
      className={className ? `zf-sub flex flex-col gap-0.5 ${className}` : "zf-sub flex flex-col gap-0.5"}
      data-llm-refusal={explanation.rule ?? explanation.code}
      data-llm-refusal-kind={explanation.kind}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mono">{explanation.rule ? `rule ${explanation.rule}` : `code ${explanation.code}`}</span>
        <StatePill tone={KIND_TONE[explanation.kind]}>{KIND_LABEL[explanation.kind]}</StatePill>
        {explanation.object ? <span>object {explanation.object}</span> : null}
        {explanation.destination ? <span>destination {explanation.destination}</span> : null}
      </div>
      {explanation.expected ? <span>Expected: {explanation.expected}</span> : null}
      <span>Do: {explanation.remediation}</span>
      {facts.length > 0 ? (
        <span className="mono">{facts.map(([key, value]) => `${key}=${String(value)}`).join(" · ")}</span>
      ) : null}
    </div>
  );
}
