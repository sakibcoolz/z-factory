import type { Metadata } from "next";
import Link from "next/link";
import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs } from "@/components/shell/editor";
import { SideBar, SideSection, Tree } from "@/components/shell/side-bar";
import { Button } from "@/components/ui/button";
import { SectionRule } from "@/components/ui/primitives";
import { StatePill } from "@/components/ui/state-pill";
import { areasWithLlmContext, buildLlmIndex, type EngineeringArea } from "@/lib/agent/llm-index";
import { DECISION_KINDS, DECISION_RULE } from "@/lib/agent/llm-context";
import { REFUSAL_KINDS, RULE_EXPLANATIONS } from "@/lib/domain/validation-explanations";
import { LLM_INDEX_SECTIONS, sectionTitle } from "@/lib/agent/llm-index-markdown";
import { routes } from "@/lib/navigation/routes";

export const metadata: Metadata = { title: "LLM Index" };

/**
 * The LLM Index (TASK-1001): the guide an external browser or coding agent reads first.
 * Rendered from the same registry as `/llm-index.md`, with one `section` per part and
 * `data-llm-section` on each, so an agent reading the DOM finds the parts by name.
 */
export default function LlmIndexPage() {
  const index = buildLlmIndex();
  const withContext = areasWithLlmContext(index);
  const areaLabel = (key: string) => index.areas.find((area) => area.key === key)?.label ?? key;

  return (
    <AppShell
      title="LLM INDEX — Z-FACTORY"
      activity="llm"
      sidebar={
        <SideBar title="LLM Index">
          <SideSection title="Contents">
            <Tree items={LLM_INDEX_SECTIONS.map((section) => ({ label: section.title, href: `#${section.id}` }))} />
          </SideSection>
          <SideSection title="Areas">
            <Tree items={index.areas.map((area) => ({ label: area.label, href: `#area-${area.key}`, level: 1 }))} />
          </SideSection>
        </SideBar>
      }
      status={{
        left: ["agent guide", `${index.areas.length} areas`, `${withContext.length} with LLM Context`],
        right: ["generated from the route registry"],
      }}
    >
      <EditorTabs tabs={[{ label: "LLM Index", active: true }]} crumb="workspace › llm index" />
      <Content plain className="gap-4.5">
        <div className="flex items-end justify-between gap-3">
          <div>
            <div className="zf-k">Z-Factory</div>
            <h1 className="zf-h mt-1.5">LLM Index</h1>
            <p className="zf-sub mt-1.5 max-w-180">
              The guide an external browser or coding agent reads before using Z-Factory. It is generated from the
              application&apos;s route registry, so it lists exactly the screens that exist. There is no embedded model
              and no MCP: an agent uses the normal pages and controls, and asks the user for the decisions listed below.
            </p>
          </div>
          <Button href={routes.llmIndexMarkdown()}>Markdown</Button>
        </div>

        <Section id="product">
          <p className="max-w-180 leading-normal text-fg-muted">{index.product.purpose}</p>
          <h3 className="zf-k mt-3">Engineering model</h3>
          <ul className="mt-1.5 flex max-w-180 flex-col gap-1">
            {index.product.model.map((line) => (
              <li key={line}>▸ {line}</li>
            ))}
          </ul>
          <h3 className="zf-k mt-3">What is real and what is simulated</h3>
          <ul className="mt-1.5 flex max-w-180 flex-col gap-1">
            {index.product.reality.map((line) => (
              <li key={line}>▸ {line}</li>
            ))}
          </ul>
        </Section>

        <Section id="activities">
          <p className="zf-sub">
            Every page shows these entries on its left edge. Factory-scoped entries open once a factory is open.
          </p>
          <table className="zf-tbl mt-2">
            <thead>
              <tr>
                <th>Entry</th>
                <th>Label</th>
                <th>Scope</th>
              </tr>
            </thead>
            <tbody>
              {index.activities.map((activity) => (
                <tr key={activity.key}>
                  <td className="mono">{activity.short}</td>
                  <td>{activity.label}</td>
                  <td>{activity.factoryScoped ? "factory" : "workspace"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        <Section id="areas">
          <p className="zf-sub">Placeholders in routes:</p>
          <ul className="mt-1.5 flex flex-col gap-0.5">
            {index.placeholders.map((placeholder) => (
              <li key={placeholder.name} className="zf-sub">
                <span className="mono text-fg">[{placeholder.name}]</span> {placeholder.meaning}
              </li>
            ))}
          </ul>
          {index.areas.map((area) => (
            <Area key={area.key} area={area} />
          ))}
        </Section>

        <Section id="llm-context">
          <p className="max-w-180 leading-normal text-fg-muted">
            {withContext.length > 0
              ? `These areas have an LLM Context tab with the page's objects, relationships, validation state, available actions and missing decisions: ${withContext.map((area) => area.label).join(", ")}.`
              : "None yet. The LLM Context tab is added to every active engineering page by TASK-1002 and TASK-1003; until then, read each page's normal content."}
          </p>
        </Section>

        <Section id="navigation">
          <p className="zf-sub">
            What the user wants, and the area it is done in. The route is the area&apos;s first screen; the area&apos;s
            card above lists the rest.
          </p>
          <table className="zf-tbl mt-2">
            <thead>
              <tr>
                <th>I want to…</th>
                <th>Go to</th>
                <th>Route</th>
              </tr>
            </thead>
            <tbody>
              {index.areas.flatMap((area) =>
                area.intents.map((intent) => (
                  <tr key={`${area.key}:${intent}`} data-llm-intent={area.key}>
                    <td>{intent}</td>
                    <td>
                      <a href={`#area-${area.key}`}>{area.label}</a>
                    </td>
                    <td className="mono">{area.routes[0]?.pattern}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
          <h3 className="zf-k mt-3">How the areas follow each other</h3>
          <ul className="mt-1.5 flex max-w-180 flex-col gap-0.5">
            {index.areas
              .filter((area) => area.upstream.length > 0 || area.downstream.length > 0)
              .map((area) => (
                <li key={area.key} className="zf-sub">
                  <b className="text-fg-strong">{area.label}</b>: after{" "}
                  {area.upstream.map(areaLabel).join(", ") || "nothing"}; before{" "}
                  {area.downstream.map(areaLabel).join(", ") || "nothing"}
                </li>
              ))}
          </ul>
        </Section>

        <Section id="decisions">
          <p className="max-w-180 leading-normal text-fg-muted">{DECISION_RULE}</p>
          <p className="zf-sub max-w-180">
            Every page&apos;s LLM Context lists its missing decisions with one of these kinds, whether the user must
            confirm before the agent acts, a safe default when one exists, and what the application enforces whatever is
            chosen.
          </p>
          <table className="zf-tbl mt-2">
            <thead>
              <tr>
                <th>Kind</th>
                <th>What it decides</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(DECISION_KINDS).map(([kind, meaning]) => (
                <tr key={kind} data-llm-decision-kind={kind}>
                  <td className="mono">{kind}</td>
                  <td>{meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        <Section id="validation">
          <p className="zf-sub max-w-180">
            Every refusal names its rule, its kind, the condition the rule requires, what happened and what to do. Pages
            show it under the message; LLM Contexts carry it on their validation items; forms name the field.
          </p>
          <ul className="mt-1.5 flex max-w-180 flex-col gap-0.5">
            {Object.entries(REFUSAL_KINDS).map(([kind, meaning]) => (
              <li key={kind} className="zf-sub" data-llm-refusal-kind={kind}>
                <span className="mono text-fg">{kind}</span>: {meaning}
              </li>
            ))}
          </ul>
          <table className="zf-tbl mt-2">
            <thead>
              <tr>
                <th>Rule</th>
                <th>Kind</th>
                <th>Area</th>
                <th>Expected</th>
                <th>Do</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(RULE_EXPLANATIONS).map(([rule, entry]) => (
                <tr key={rule} data-llm-rule={rule}>
                  <td className="mono">{rule}</td>
                  <td>{entry.kind}</td>
                  <td>{areaLabel(entry.area)}</td>
                  <td>{entry.expected}</td>
                  <td>{entry.remediation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        <Section id="files">
          <table className="zf-tbl">
            <thead>
              <tr>
                <th>Route</th>
                <th>What it is</th>
              </tr>
            </thead>
            <tbody>
              {index.files.map((file) => (
                <tr key={file.pattern}>
                  <td className="mono">{file.pattern}</td>
                  <td>{file.purpose}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        <Section id="workflow">
          <ol className="flex max-w-180 flex-col gap-1.5">
            {index.workflow.map((step, number) => (
              <li key={step.area + number}>
                <span className="mono text-fg-dim">{number + 1}.</span>{" "}
                <b className="text-fg-strong">{areaLabel(step.area)}:</b> {step.text}
              </li>
            ))}
          </ol>
        </Section>

        <Section id="rules">
          <div className="grid max-w-180 gap-2">
            {index.rules.map((rule) => (
              <article key={rule.title} className="zf-cell">
                <h3 className="zf-k">{rule.title}</h3>
                <p className="leading-normal">{rule.text}</p>
                <p className="zf-sub">Source: {rule.source}</p>
              </article>
            ))}
          </div>
        </Section>
      </Content>
    </AppShell>
  );
}

function Section({ id, children }: { id: (typeof LLM_INDEX_SECTIONS)[number]["id"]; children: React.ReactNode }) {
  return (
    <section id={id} data-llm-section={id} aria-labelledby={`${id}-title`} className="flex flex-col gap-2">
      <SectionRule>
        <h2 id={`${id}-title`} className="zf-k">
          {sectionTitle(id)}
        </h2>
      </SectionRule>
      {children}
    </section>
  );
}

function Area({ area }: { area: EngineeringArea }) {
  return (
    <article id={`area-${area.key}`} data-llm-area={area.key} className="zf-cell mt-2 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-fg-strong font-semibold">{area.label}</h3>
        <StatePill tone="off">{area.scope}</StatePill>
        {area.activity ? <StatePill tone="off">{area.activity.toUpperCase()}</StatePill> : null}
        <StatePill tone={area.llmContext ? "run" : "off"}>
          {area.llmContext ? "LLM Context" : "no LLM Context yet"}
        </StatePill>
      </div>
      <p className="max-w-180 leading-normal text-fg-muted">{area.purpose}</p>
      {area.upstream.length > 0 || area.downstream.length > 0 ? (
        <p className="zf-sub" data-llm-flow={area.key}>
          Before: {area.upstream.join(", ") || "nothing"} · after: {area.downstream.join(", ") || "nothing"}
        </p>
      ) : null}
      <table className="zf-tbl">
        <thead>
          <tr>
            <th>Route</th>
            <th>What it is</th>
          </tr>
        </thead>
        <tbody>
          {area.routes.map((route) => (
            <tr key={route.pattern}>
              <td className="mono">
                {route.pattern.includes("[") ? route.pattern : <Link href={route.pattern}>{route.pattern}</Link>}
              </td>
              <td>{route.note ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="grid gap-2 md:grid-cols-2">
        <div>
          <h4 className="zf-k">Bring here</h4>
          <ul className="mt-1 flex flex-col gap-0.5">
            {area.tasks.map((task) => (
              <li key={task}>▸ {task}</li>
            ))}
          </ul>
        </div>
        {area.decisions.length > 0 ? (
          <div>
            <h4 className="zf-k">Ask the user for</h4>
            <ul className="mt-1 flex flex-col gap-0.5">
              {area.decisions.map((decision) => (
                <li key={decision}>▸ {decision}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </article>
  );
}
