import Link from "next/link";
import { RefusalExplanation } from "@/components/ui/refusal";
import { StatePill, type Tone } from "@/components/ui/state-pill";
import {
  LLM_CONTEXT_SECTIONS,
  LLM_CONTEXT_VERSION,
  type LlmContextDecisionItem,
  type LlmContextDocument,
  type LlmContextItem,
  type LlmContextTone,
} from "@/lib/agent/llm-context";

type LlmContextPanelProps = {
  document: LlmContextDocument;
};

const PILL_TONE: Record<LlmContextTone, Tone> = { ok: "run", info: "off", warn: "deg", fault: "flt" };
const VALIDATION_TONE: Record<LlmContextDocument["validation"]["status"], Tone> = {
  ok: "run",
  issues: "deg",
  unknown: "off",
};

/**
 * The LLM Context panel (TASK-1002): at the end of a page's content, closed for people,
 * always in the DOM for agents. One `section[data-llm-section]` per section, in the fixed
 * order, and the whole document once more as JSON in `script[data-llm-context-json]`.
 */
export function LlmContextPanel({ document }: LlmContextPanelProps) {
  const { identity, validation } = document;
  // The JSON is inert data for agents; `<` is escaped so no markup can end the script early.
  const json = JSON.stringify(document).replace(/</g, "\\u003c");

  return (
    <details
      className="zf-cell"
      data-llm-context={identity.area}
      data-llm-page={identity.page}
      data-llm-version={LLM_CONTEXT_VERSION}
    >
      <summary className="zf-k cursor-pointer select-none">
        LLM Context · {identity.subject} · validation {validation.status}
      </summary>
      <div className="mt-3 grid gap-4 md:grid-cols-2">
        {LLM_CONTEXT_SECTIONS.map((section) => (
          <section
            key={section.id}
            data-llm-section={section.id}
            aria-label={section.title}
            className={section.id === "identity" ? "md:col-span-2" : undefined}
          >
            <h3 className="zf-k">{section.title}</h3>
            {section.id === "identity" ? (
              <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                <dt className="zf-sub">Page</dt>
                <dd>{identity.page}</dd>
                <dt className="zf-sub">Area</dt>
                <dd className="mono">{identity.area}</dd>
                <dt className="zf-sub">Route</dt>
                <dd className="mono">
                  {identity.route} <span className="text-fg-dim">({identity.routePattern})</span>
                </dd>
                <dt className="zf-sub">Subject</dt>
                <dd>{identity.subject}</dd>
                <dt className="zf-sub">Summary</dt>
                <dd className="text-fg-muted">{identity.summary}</dd>
              </dl>
            ) : section.id === "validation" ? (
              <>
                <div className="mt-1.5">
                  <StatePill tone={VALIDATION_TONE[validation.status]}>{validation.status}</StatePill>
                </div>
                <Items items={validation.items} />
              </>
            ) : (
              <Items items={document[section.id]} />
            )}
          </section>
        ))}
      </div>
      <script type="application/json" data-llm-context-json="" dangerouslySetInnerHTML={{ __html: json }} />
    </details>
  );
}

function Items({ items }: { items: ReadonlyArray<LlmContextItem | LlmContextDecisionItem> }) {
  if (items.length === 0) return <p className="zf-sub mt-1.5">None.</p>;
  return (
    <ul className="mt-1.5 flex flex-col gap-1">
      {items.map((item, index) => (
        <li
          key={`${item.label}-${index}`}
          data-tone={item.tone ?? "info"}
          className="flex flex-wrap items-baseline gap-x-2"
        >
          {item.relation ? (
            <span className="zf-k" data-llm-relation={item.relation}>
              {item.relation === "upstream" ? "before" : "after"}
            </span>
          ) : null}
          {item.href ? (
            <Link href={item.href} className="text-info hover:underline">
              {item.label}
            </Link>
          ) : (
            <span className="text-fg-strong">{item.label}</span>
          )}
          {item.value ? <span className="mono">{item.value}</span> : null}
          {item.tone && item.tone !== "info" ? <StatePill tone={PILL_TONE[item.tone]}>{item.tone}</StatePill> : null}
          {item.detail ? <span className="zf-sub basis-full">{item.detail}</span> : null}
          {item.explanation ? <RefusalExplanation explanation={item.explanation} className="basis-full" /> : null}
          {"decision" in item && item.decision ? (
            <span
              className="zf-sub basis-full"
              data-llm-decision={item.decision.kind}
              data-llm-confirm={item.decision.confirm}
            >
              <span className="mono">{item.decision.kind}</span>
              {" · "}
              {item.decision.confirm === "required" ? "confirm before acting" : "a default may be applied"}
              {item.decision.defaultChoice ? ` · default: ${item.decision.defaultChoice}` : ""}
              {item.decision.enforced ? ` · enforced: ${item.decision.enforced}` : ""}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
