import { notFound } from "next/navigation";
import { LlmContextPanel } from "@/components/agent/llm-context";
import { ScenarioRunner } from "@/components/scenarios/scenario-runner";
import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs } from "@/components/shell/editor";
import { OperationForm } from "@/components/ui/operation-form";
import { SectionRule } from "@/components/ui/primitives";
import { StatePill } from "@/components/ui/state-pill";
import { buildScenariosContext } from "@/lib/agent/contexts/factory-operations";
import { requireActor } from "@/lib/auth/actor";
import { getDb } from "@/lib/db/client";
import { plcRepository } from "@/lib/db/repositories/plc-repository";
import { isDomainError } from "@/lib/domain/errors";
import { exampleScenario } from "@/lib/domain/scenario";
import { tagAuthority } from "@/lib/domain/tag-authority";
import { formatUtc } from "@/lib/factories/format";
import { routes } from "@/lib/navigation/routes";
import { listEvents } from "@/lib/services/event-service";
import { getFactory } from "@/lib/services/factory-service";
import { getScenarioDeps } from "@/lib/services/runtime-deps";
import { listActiveOverrides } from "@/lib/services/scenario-service";
import { clearOverridesAction, scenarioRunAction } from "./actions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const text = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * Closed-loop scenarios for a stored factory: what is out of AUTO right now, a scenario
 * to run against the running factory, and the runs recorded so far. A scenario asks as
 * an operator does and changes what the simulation feeds the PLC; the program decides.
 */
export async function StoredScenarios({ factoryId }: { factoryId: string }) {
  if (!UUID.test(factoryId)) notFound();
  const actor = await requireActor();
  const db = getDb();
  const factory = await getFactory(db, actor, factoryId).catch((error: unknown) => {
    if (isDomainError(error, "NOT_FOUND")) notFound();
    throw error;
  });
  const deps = getScenarioDeps();
  const active = await listActiveOverrides(deps, actor, factory.id).catch(() => null);
  const runs = (await listEvents(db, actor, factory.id, { family: "SCENARIO", limit: 20 })).filter(
    (event) => event.type !== "SCENARIO_STARTED",
  );

  const plc = (await plcRepository.listFactoryPlcs(db, factory.id))[0];
  const tags = plc?.plcProfile?.tags ?? [];
  const command = tags.find((tag) => tag.dataType === "BOOL" && tagAuthority(tag) === "EXTERNAL_COMMAND");
  // Something a start makes the program do: preferably a command it gives a device, not an alarm.
  const outputs = tags.filter((tag) => tag.dataType === "BOOL" && tagAuthority(tag) === "PROGRAM_OUTPUT");
  const expected = outputs.find((tag) => tag.sourceSignal) ?? outputs.find((tag) => tag.role !== "ALARM") ?? outputs[0];
  const initial = JSON.stringify(
    exampleScenario({ plc: plc?.name, command: command?.name, expected: expected?.name }),
    null,
    2,
  );

  return (
    <AppShell
      title={`Scenarios — ${factory.name}`}
      titleState={
        active && active.length > 0 ? (
          <StatePill tone="deg">{`${active.length} out of AUTO`}</StatePill>
        ) : (
          <StatePill tone="run">all AUTO</StatePill>
        )
      }
      activity="factories"
      status={{
        tone: active && active.length > 0 ? "deg" : "ok",
        left: [`⎇ ${factory.slug}`, "scenarios", `${runs.length} recorded runs`],
        right: [active === null ? "simulation service unavailable" : `${active.length} overridden`],
      }}
    >
      <EditorTabs
        tabs={[
          { label: factory.name, href: routes.factory(factory.id) },
          { label: "Simulator", href: routes.simulator(factory.id) },
          { label: "Scenarios", active: true },
          { label: "Runtime", href: routes.runtime(factory.id) },
        ]}
        crumb="closed-loop tests · the PLC program decides"
      />
      <Content plain>
        <div>
          <div className="zf-k">{`Factory · ${factory.slug}`}</div>
          <h1 className="zf-h mt-1.5">Closed-loop scenarios</h1>
        </div>
        <p className="zf-sub max-w-180">
          A scenario tests the PLC program against the simulated plant: it writes command and setpoint tags as an
          operator does, forces simulated sensors or overrides process values, and expects what the program does about
          it. It never writes what the program decides. A run starts from AUTO and ends with every value back in AUTO;
          each run is recorded on the Events screen.
        </p>
        <div className="zf-cell flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="zf-k">Values out of AUTO</span>
            <OperationForm
              label="Overrides"
              size="sm"
              action={clearOverridesAction.bind(null, factory.id)}
              buttons={[
                {
                  operation: "clear",
                  label: "Clear all overrides",
                  pendingLabel: "Clearing…",
                  disabled: !active || active.length === 0,
                  title: "Returns every forced sensor or switch and every overridden process value to AUTO.",
                },
              ]}
            />
          </div>
          {active === null ? (
            <p className="zf-error">The simulation service does not answer; overrides cannot be listed.</p>
          ) : active.length === 0 ? (
            <p className="zf-sub">Every simulated value is in AUTO.</p>
          ) : (
            <ul className="mono flex flex-col gap-1">
              {active.map((entry) => (
                <li key={`${entry.kind}:${entry.target}`}>
                  {`${entry.target} · ${entry.mode.toLowerCase().replace("_", " ")}${
                    entry.value !== undefined ? ` ${String(entry.value)}` : ""
                  }`}
                </li>
              ))}
            </ul>
          )}
        </div>
        <SectionRule>
          <span className="zf-k">Run a scenario</span>
        </SectionRule>
        <ScenarioRunner action={scenarioRunAction.bind(null, factory.id)} initial={initial} />
        <SectionRule>
          <span className="zf-k">{`Recorded runs · ${runs.length}`}</span>
        </SectionRule>
        {runs.length === 0 ? (
          <p className="zf-sub">No scenario has run in this factory yet.</p>
        ) : (
          <table className="zf-tbl" aria-label="Recorded runs">
            <thead>
              <tr>
                <th>When</th>
                <th>Scenario</th>
                <th>Result</th>
                <th>Steps</th>
                <th>Out of AUTO</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((event) => {
                const payload = event.payload;
                const status =
                  event.type === "SCENARIO_COMPLETED"
                    ? "passed"
                    : event.type === "SCENARIO_FAILED"
                      ? "failed"
                      : "refused";
                return (
                  <tr key={event.id}>
                    <td className="mono">{formatUtc(event.occurredAt)}</td>
                    <td className="mono">{text(payload.scenario) || "—"}</td>
                    <td>
                      <StatePill tone={status === "passed" ? "run" : status === "failed" ? "flt" : "deg"}>
                        {status}
                      </StatePill>
                    </td>
                    <td className="mono">
                      {typeof payload.passed === "number" ? `${payload.passed}/${String(payload.steps)}` : "—"}
                    </td>
                    <td className="mono whitespace-normal">
                      {Array.isArray(payload.overridden) && payload.overridden.length > 0
                        ? payload.overridden.map(String).join(", ")
                        : "—"}
                    </td>
                    <td className="whitespace-normal">{text(payload.failure) || text(payload.message) || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <LlmContextPanel
          document={buildScenariosContext({
            factory,
            active,
            runs,
            examplePlc: plc
              ? { name: plc.name, command: command?.name ?? null, expected: expected?.name ?? null }
              : null,
          })}
        />
      </Content>
    </AppShell>
  );
}
