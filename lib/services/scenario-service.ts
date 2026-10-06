import "server-only";
import { randomUUID } from "node:crypto";
import type { Actor } from "@/lib/auth/actor";
import { factoryRepository } from "@/lib/db/repositories/factory-repository";
import { plcRepository } from "@/lib/db/repositories/plc-repository";
import { processModuleRepository } from "@/lib/db/repositories/process-module-repository";
import { DomainError, isDomainError } from "@/lib/domain/errors";
import {
  type Scenario,
  type ScenarioOverride,
  type ScenarioReport,
  type ScenarioStep,
  type ScenarioStepResult,
  satisfies,
  stepLabel,
} from "@/lib/domain/scenario";
import { isExternallyWritable } from "@/lib/domain/tag-authority";
import { parseInput } from "@/lib/validation/parse";
import { scenarioSchema } from "@/lib/validation/scenario";
import { recordEvents } from "./event-service";
import { clearProcessOverride, type ProcessBridgeDeps, setProcessOverride } from "./process-bridge-service";
import type { RuntimeDeps } from "./plc-runtime-service";
import { forceSimulatedValue, type SimulationDeps } from "./simulation-service";
import { readTag, writeTag } from "./tag-service";

/**
 * Closed-loop test scenarios (TASK-804, docs/process-simulation.md → Scenarios): runs a
 * scenario's steps against a running factory, checks what the PLC program does, records
 * the run as events and always ends with every value back in AUTO.
 *
 * A scenario only reaches the PLC through command and setpoint tags (as an operator does)
 * and through the simulation (forced sensors and switches, process overrides). What the
 * program decides — alarms, trips, outputs — is read and compared, never written.
 */

export type ScenarioDeps = {
  runtime: RuntimeDeps;
  simulation: SimulationDeps;
  process: ProcessBridgeDeps;
  /** How often an EXPECT reads its tag. */
  pollMs?: number;
};

/** A value of the factory that is not in AUTO right now. */
export type ActiveOverride = {
  kind: "FORCED" | "PROCESS";
  target: string;
  mode: string;
  value?: number | boolean;
};

type Resolved = {
  plcs: Map<string, { id: string; tags: Map<string, { writable: boolean }> }>;
  devices: Map<string, string>;
  modules: Map<string, string>;
};

const running = globalThis as typeof globalThis & { zfactoryScenarioRuns?: Map<string, string> };
const runs = () => (running.zfactoryScenarioRuns ??= new Map<string, string>());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (seconds: number) => Math.round(seconds * 10) / 10;
const message = (error: unknown) => (error instanceof Error ? error.message : "the step failed");

async function requireFactory(deps: ScenarioDeps, actor: Actor, factoryId: string) {
  const factory = await factoryRepository.findById(deps.runtime.db, actor.ownerId, factoryId);
  if (!factory) throw new DomainError("NOT_FOUND", "The factory does not exist.");
  return factory;
}

/** Every forced device value and every overridden process value of the factory. */
export async function listActiveOverrides(
  deps: ScenarioDeps,
  actor: Actor,
  factoryId: string,
): Promise<ActiveOverride[]> {
  await requireFactory(deps, actor, factoryId);
  const active: ActiveOverride[] = [];
  if (deps.simulation.simulator.isRunning(factoryId)) {
    for (const forced of deps.simulation.simulator.simulation(factoryId).forced()) {
      active.push({ kind: "FORCED", target: forced.name, mode: "FORCED", value: forced.value });
    }
  }
  const client = deps.process.client;
  const status = deps.process.bridge.status(factoryId);
  if (client && status) {
    for (const entry of status.modules) {
      const states = await client.overrides(entry.moduleId);
      for (const state of states.filter((candidate) => candidate.mode !== "AUTO")) {
        active.push({
          kind: "PROCESS",
          target: `${entry.name} · ${state.signal}`,
          mode: state.mode,
          ...(state.value !== undefined ? { value: state.value } : {}),
        });
      }
    }
  }
  return active;
}

/**
 * Returns every forced and overridden value of the factory to AUTO and records each
 * release. Returns how many values were released.
 */
export async function clearAllOverrides(
  deps: ScenarioDeps,
  actor: Actor,
  factoryId: string,
  origin: { scenario?: { name: string; runId: string } } = {},
): Promise<number> {
  await requireFactory(deps, actor, factoryId);
  let released = 0;
  if (deps.simulation.simulator.isRunning(factoryId)) {
    for (const forced of deps.simulation.simulator.simulation(factoryId).forced()) {
      await forceSimulatedValue(deps.simulation, actor, forced.deviceId, null);
      released += 1;
    }
  }
  const client = deps.process.client;
  const status = deps.process.bridge.status(factoryId);
  if (client && status) {
    for (const entry of status.modules) {
      for (const state of (await client.overrides(entry.moduleId)).filter((candidate) => candidate.mode !== "AUTO")) {
        await clearProcessOverride(deps.process, actor, entry.moduleId, state.signal, origin);
        released += 1;
      }
    }
  }
  return released;
}

/** Looks up every PLC, tag, device and module the steps name; the first one missing refuses the run. */
async function resolve(deps: ScenarioDeps, factoryId: string, steps: readonly ScenarioStep[]): Promise<Resolved> {
  const db = deps.runtime.db;
  const plcs = new Map(
    (await plcRepository.listFactoryPlcs(db, factoryId)).map((plc) => [
      plc.name,
      {
        id: plc.id,
        tags: new Map((plc.plcProfile?.tags ?? []).map((tag) => [tag.name, { writable: isExternallyWritable(tag) }])),
      },
    ]),
  );
  const devices = new Map(
    (await db.deviceInstance.findMany({ where: { factoryId }, select: { id: true, name: true } })).map((device) => [
      device.name,
      device.id,
    ]),
  );
  const modules = new Map(
    (await processModuleRepository.listModules(db, factoryId)).map((module) => [module.name, module.id]),
  );

  const refuse = (index: number, text: string) =>
    new DomainError("VALIDATION", `Step ${index + 1}: ${text}`, { rule: "scenario-step", step: index + 1 });
  steps.forEach((step, index) => {
    if (step.kind === "WRITE" || step.kind === "EXPECT") {
      const plc = plcs.get(step.plc);
      if (!plc) throw refuse(index, `this factory has no PLC named ${step.plc}.`);
      const tag = plc.tags.get(step.tag);
      if (!tag) throw refuse(index, `${step.plc} has no tag named ${step.tag}.`);
      if (step.kind === "WRITE" && !tag.writable) {
        throw refuse(
          index,
          `${step.tag} is not a command or setpoint tag. A scenario asks as an operator does and lets the program decide; expect the program's tags, never write them.`,
        );
      }
    }
    if (step.kind === "FORCE" && !devices.has(step.device)) {
      throw refuse(index, `this factory has no device named ${step.device}.`);
    }
    if ((step.kind === "OVERRIDE" || step.kind === "RAMP") && !modules.has(step.module)) {
      throw refuse(index, `this factory has no process module named ${step.module}.`);
    }
  });
  return { plcs, devices, modules };
}

/**
 * Runs a scenario against a running factory and returns its report. Refused (and recorded
 * as `SCENARIO_REJECTED`) when the definition is invalid, names something the factory does
 * not have, writes anything but a command or setpoint, another scenario of the factory is
 * running, or a value of the factory is already out of AUTO (a run starts from AUTO, so
 * that it can be repeated). Otherwise recorded as `SCENARIO_STARTED` and then
 * `SCENARIO_COMPLETED` or `SCENARIO_FAILED`; a failing step ends the run, and every value
 * is returned to AUTO whatever the outcome.
 */
export async function runScenario(
  deps: ScenarioDeps,
  actor: Actor,
  factoryId: string,
  input: unknown,
): Promise<ScenarioReport> {
  await requireFactory(deps, actor, factoryId);
  const runId = randomUUID();
  const record = (type: string, severity: "INFO" | "WARNING", payload: Record<string, unknown>) =>
    recordEvents(deps.process, [
      { type, factoryId, deviceId: null, severity, payload: { ...payload, by: actor.ownerId } },
    ]);

  let scenario: Scenario;
  let resolved: Resolved;
  try {
    scenario = parseInput(scenarioSchema, input);
    if (runs().has(factoryId)) {
      throw new DomainError("CONFLICT", "A scenario is already running in this factory.", { rule: "scenario-running" });
    }
    resolved = await resolve(deps, factoryId, scenario.steps);
    const active = await listActiveOverrides(deps, actor, factoryId);
    if (active.length > 0) {
      throw new DomainError(
        "CONFLICT",
        `A scenario starts from AUTO; ${active.map((entry) => entry.target).join(", ")} ${active.length === 1 ? "is" : "are"} still overridden. Clear the overrides first.`,
        { rule: "scenario-overrides-active" },
      );
    }
  } catch (error) {
    if (isDomainError(error)) {
      const name =
        typeof input === "object" && input !== null && typeof (input as { name?: unknown }).name === "string"
          ? String((input as { name: string }).name).slice(0, 120)
          : null;
      await record("SCENARIO_REJECTED", "WARNING", {
        ...(name ? { scenario: name } : {}),
        rule: typeof error.details.rule === "string" ? error.details.rule : error.code,
        message: error.message,
      });
    }
    throw error;
  }

  runs().set(factoryId, runId);
  const origin = { scenario: { name: scenario.name, runId } };
  const startedAt = new Date();
  const elapsedS = () => round((Date.now() - startedAt.getTime()) / 1000);
  const results: ScenarioStepResult[] = scenario.steps.map((step, index) => ({
    index: index + 1,
    kind: step.kind,
    label: stepLabel(step),
    status: "SKIPPED",
    atS: null,
  }));
  const overrides: ScenarioOverride[] = [];
  let failure: string | null = null;
  const pollMs = deps.pollMs ?? 100;

  const read = async (plc: string, tag: string) =>
    (await readTag(deps.runtime, actor, resolved.plcs.get(plc)!.id, tag)).value;

  /** Waits for the condition, then for it to hold; returns the last value read and whether it passed. */
  const expect = async (step: Extract<ScenarioStep, { kind: "EXPECT" }>) => {
    const deadline = Date.now() + step.withinS * 1000;
    let observed = await read(step.plc, step.tag);
    while (!satisfies(observed, step) && Date.now() < deadline) {
      await sleep(pollMs);
      observed = await read(step.plc, step.tag);
    }
    if (!satisfies(observed, step)) return { observed, passed: false, reason: `not within ${step.withinS} s` };
    if (step.holdS) {
      const until = Date.now() + step.holdS * 1000;
      while (Date.now() < until) {
        await sleep(pollMs);
        observed = await read(step.plc, step.tag);
        if (!satisfies(observed, step)) return { observed, passed: false, reason: `did not hold ${step.holdS} s` };
      }
    }
    return { observed, passed: true, reason: null };
  };

  await record("SCENARIO_STARTED", "INFO", { scenario: scenario.name, runId, steps: scenario.steps.length });
  try {
    for (const [index, step] of scenario.steps.entries()) {
      const result = results[index]!;
      try {
        switch (step.kind) {
          case "WRITE":
            await writeTag(deps.runtime, actor, resolved.plcs.get(step.plc)!.id, step.tag, step.value, "SYSTEM");
            break;
          case "FORCE":
            await forceSimulatedValue(deps.simulation, actor, resolved.devices.get(step.device)!, step.value);
            overrides.push({ target: step.device, mode: "FORCED", value: step.value, atS: elapsedS() });
            break;
          case "OVERRIDE":
            await setProcessOverride(
              deps.process,
              actor,
              resolved.modules.get(step.module)!,
              step.signal,
              { mode: "MANUAL_OVERRIDE", value: step.value },
              origin,
            );
            overrides.push({
              target: `${step.module} · ${step.signal}`,
              mode: "MANUAL_OVERRIDE",
              value: step.value,
              atS: elapsedS(),
            });
            break;
          case "RAMP":
            await setProcessOverride(
              deps.process,
              actor,
              resolved.modules.get(step.module)!,
              step.signal,
              { mode: "SCENARIO", profile: { kind: "RAMP", from: step.from, to: step.to, durationS: step.durationS } },
              origin,
            );
            overrides.push({
              target: `${step.module} · ${step.signal}`,
              mode: "SCENARIO",
              profile: { from: step.from, to: step.to, durationS: step.durationS },
              atS: elapsedS(),
            });
            break;
          case "CLEAR":
            await clearAllOverrides(deps, actor, factoryId, origin);
            break;
          case "WAIT":
            await sleep(step.seconds * 1000);
            break;
          case "EXPECT": {
            const outcome = await expect(step);
            result.observed = outcome.observed;
            if (!outcome.passed) throw new Error(`${step.tag} was ${String(outcome.observed)}: ${outcome.reason}`);
            break;
          }
        }
        result.status = "PASSED";
        result.atS = elapsedS();
      } catch (error) {
        result.status = "FAILED";
        result.atS = elapsedS();
        result.message = message(error);
        failure = `Step ${index + 1} (${result.label}): ${result.message}`;
        break;
      }
    }
  } finally {
    try {
      await clearAllOverrides(deps, actor, factoryId, origin);
    } catch (error) {
      failure ??= `Returning to AUTO failed: ${message(error)}`;
    }
    runs().delete(factoryId);
  }

  const finishedAt = new Date();
  const report: ScenarioReport = {
    runId,
    name: scenario.name,
    status: failure ? "FAILED" : "PASSED",
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationS: round((finishedAt.getTime() - startedAt.getTime()) / 1000),
    steps: results,
    overrides,
    failure,
  };
  await record(failure ? "SCENARIO_FAILED" : "SCENARIO_COMPLETED", failure ? "WARNING" : "INFO", {
    scenario: scenario.name,
    runId,
    status: report.status,
    durationS: report.durationS,
    passed: results.filter((result) => result.status === "PASSED").length,
    steps: results.length,
    overridden: overrides.map((entry) => entry.target),
    ...(failure ? { failure } : {}),
  });
  return report;
}
