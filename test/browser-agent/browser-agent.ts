import { join } from "node:path";
import type { Page } from "./cdp";

/**
 * A browser agent for Z-Factory Engineering (TASK-1008): it starts at the LLM Index, reads
 * each page's LLM Context as it navigates, asks the user every decision the context marks
 * as needing confirmation, and changes the design through the normal controls only. It
 * knows the application from what the pages show, never from the code: this module
 * imports nothing of Z-Factory, and its test enforces that.
 *
 * The agent is scripted, not a language model: the proof is that the pages carry enough
 * for such a reader to complete the reference scenario. A model-driven agent would read
 * the same attributes and the same JSON.
 */

/** An item of the LLM Context as the panel's JSON carries it (`script[data-llm-context-json]`). */
export type ContextItem = {
  label: string;
  value?: string;
  href?: string;
  detail?: string;
  tone?: string;
  relation?: string;
  decision?: { kind: string; confirm: "required" | "optional"; defaultChoice?: string; enforced?: string };
  explanation?: { rule: string | null; kind: string; remediation: string };
};

export type LlmContext = {
  identity: { page: string; area: string; route: string; subject: string; summary: string };
  validation: { status: string; items: ContextItem[] };
  context: ContextItem[];
  objects: ContextItem[];
  relationships: ContextItem[];
  capacity: ContextItem[];
  actions: ContextItem[];
  constraints: ContextItem[];
  decisions: ContextItem[];
  navigation: ContextItem[];
};

/** A question to the user: a decision the context raised, with the choices the page offers. */
export type Question = {
  page: string;
  label: string;
  kind: string;
  confirm: "required" | "optional";
  detail?: string;
  defaultChoice?: string;
  options?: string[];
};

/** Whoever answers the agent's questions: a person, or a script in a test. */
export type User = { decide(question: Question): string | Promise<string> };

export type Visit = { route: string; page: string | null; area: string | null; context: boolean };
export type Asked = Question & { answer: string };
export type Defaulted = Question & { applied: string };
export type PageValidation = { page: string; route: string; status: string; items: string[] };

export type AgentReport = {
  /** Every page the agent opened, in order, and whether it had an LLM Context. */
  visits: Visit[];
  /** Index parts and areas read before the first step. */
  index: { sections: string[]; areas: string[]; workflow: string[] };
  asked: Asked[];
  defaulted: Defaulted[];
  changes: string[];
  capacity: string[];
  validation: PageValidation[];
  design: string[];
  /** What the pages could not do, and the reasons they gave. */
  blocked: Array<{ what: string; why: string[] }>;
  markdown: string;
};

/** A refusal the application showed, read from the page as an agent would. */
export class AgentRefusal extends Error {
  constructor(
    readonly where: string,
    message: string,
    readonly rule: string | null,
    readonly kind: string | null,
  ) {
    super(`${where}: ${message}${rule ? ` (rule ${rule}, ${kind})` : ""}`);
  }
}

type Device = { name: string; id: string };
type WireSpec = { terminal: RegExp; point: RegExp };

const quote = (value: string) => JSON.stringify(value);

/** The designer's two sidebars, as the page labels them. */
const PALETTE = 'aside[aria-label="Palette"]';
const INSPECTOR = 'aside[aria-label="Inspector"]';

/** JavaScript for the page: sets a React-controlled input, textarea or select and tells React. */
const SET_VALUE = `(selector, value) => {
  const element = document.querySelector(selector);
  if (!element) throw new Error("No element " + selector);
  const proto = element.tagName === "SELECT" ? HTMLSelectElement.prototype
    : element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(element, value);
  element.dispatchEvent(new Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  return element.value;
}`;

const OPTIONS = `(selector) => [...document.querySelector(selector).options]
  .map((option) => ({ value: option.value, text: option.textContent.trim(), disabled: option.disabled }))`;

export class BrowserAgent {
  readonly visits: Visit[] = [];
  readonly asked: Asked[] = [];
  readonly defaulted: Defaulted[] = [];
  readonly changes: string[] = [];
  readonly capacity: string[] = [];
  readonly validation: PageValidation[] = [];
  readonly design: string[] = [];
  readonly blocked: Array<{ what: string; why: string[] }> = [];
  index: AgentReport["index"] = { sections: [], areas: [], workflow: [] };

  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly user: User,
    private readonly options: { screenshots?: string } = {},
  ) {}

  // ----- Reading pages ---------------------------------------------------------------------

  private async open(path: string): Promise<LlmContext | null> {
    await this.page.goto(this.baseUrl + path);
    return this.arrived();
  }

  /**
   * After any navigation: records the page and reads its LLM Context. A navigation the
   * application made itself (after a form) streams the page in; its context is waited for.
   */
  private async arrived(expectContext = false): Promise<LlmContext | null> {
    await this.page.waitFor("document.readyState === 'complete'");
    if (expectContext) {
      await this.page.waitFor("!!document.querySelector('script[data-llm-context-json]')", {
        timeout: 20_000,
        what: "the page's LLM Context after the application navigated",
      });
    }
    const context = await this.readContext();
    const route = await this.page.eval<string>("location.pathname + location.search");
    this.visits.push({
      route,
      page: context?.identity.page ?? null,
      area: context?.identity.area ?? null,
      context: context !== null,
    });
    if (this.options.screenshots) {
      const name = `${String(this.visits.length).padStart(2, "0")}-${route.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)}.png`;
      await this.page.screenshot(join(this.options.screenshots, name));
    }
    return context;
  }

  private readContext(): Promise<LlmContext | null> {
    return this.page.eval<LlmContext | null>(
      `(() => { const script = document.querySelector('script[data-llm-context-json]'); return script ? JSON.parse(script.textContent || "null") : null; })()`,
    );
  }

  /** The context after the page refreshed itself: waits until the condition holds in it. */
  private async contextWhen(test: (context: LlmContext) => boolean, what: string): Promise<LlmContext> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const context = await this.readContext();
      if (context && test(context)) return context;
      if (Date.now() > deadline) throw new Error(`The LLM Context did not show ${what} in time.`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  private need(context: LlmContext | null, where: string): LlmContext {
    if (!context) throw new Error(`${where} has no LLM Context; the agent cannot read it.`);
    return context;
  }

  private static find(items: readonly ContextItem[], pattern: RegExp): ContextItem | undefined {
    return items.find((item) => pattern.test(item.label));
  }

  private static href(items: readonly ContextItem[], pattern: RegExp, what: string): string {
    const item = BrowserAgent.find(items, pattern);
    if (!item?.href) throw new Error(`The LLM Context offers no ${what}.`);
    return item.href;
  }

  // ----- Decisions ---------------------------------------------------------------------------

  /**
   * Asks the user a decision the context raised (or one the index's rules require even
   * where the page has no context) and records it. An optional decision with a default is
   * not asked: the default is applied and recorded as such.
   */
  private async decide(
    page: string,
    item: ContextItem | undefined,
    fallback: { label: string; kind: string; detail?: string },
    options?: string[],
  ): Promise<string> {
    const question: Question = {
      page,
      label: item?.label ?? fallback.label,
      kind: item?.decision?.kind ?? fallback.kind,
      confirm: item?.decision?.confirm ?? "required",
      detail: item?.detail ?? fallback.detail,
      defaultChoice: item?.decision?.defaultChoice,
      options,
    };
    if (question.confirm === "optional" && question.defaultChoice && options && options.length > 0) {
      this.defaulted.push({ ...question, applied: options[0]! });
      return options[0]!;
    }
    const answer = await this.user.decide(question);
    this.asked.push({ ...question, answer });
    return answer;
  }

  private static pick<T extends { text: string }>(options: T[], answer: string, what: string): T {
    const found =
      options.find((option) => option.text === answer) ?? options.find((option) => option.text.includes(answer));
    if (!found) throw new Error(`No ${what} matches "${answer}"; offered: ${options.map((o) => o.text).join(" | ")}`);
    return found;
  }

  // ----- Controls ----------------------------------------------------------------------------

  private async click(selector: string): Promise<void> {
    await this.page.eval(
      `(() => { const element = document.querySelector(${quote(selector)}); if (!element) throw new Error("No element " + ${quote(selector)}); element.click(); })()`,
    );
  }

  private async setValue(selector: string, value: string): Promise<void> {
    await this.page.eval(`(${SET_VALUE})(${quote(selector)}, ${quote(value)})`);
  }

  private async choices(selector: string): Promise<Array<{ value: string; text: string; disabled: boolean }>> {
    await this.page.waitFor(`!!document.querySelector(${quote(selector)})`, { what: `the control ${selector}` });
    return this.page.eval(`(${OPTIONS})(${quote(selector)})`);
  }

  /** Throws when the page shows a refusal, with the rule and kind the explanation names. */
  private async refusalCheck(where: string, scope = ""): Promise<void> {
    const refusal = await this.page.eval<{ message: string; rule: string | null; kind: string | null } | null>(
      `(() => { const alert = document.querySelector(${quote(`${scope} [role=alert]`.trim())}); if (!alert) return null;
        const explained = alert.querySelector('[data-llm-refusal]') || alert.parentElement?.querySelector('[data-llm-refusal]');
        return { message: alert.querySelector('p')?.textContent || alert.textContent, rule: explained?.dataset.llmRefusal ?? null, kind: explained?.dataset.llmRefusalKind ?? null }; })()`,
    );
    if (refusal) throw new AgentRefusal(where, refusal.message, refusal.rule, refusal.kind);
  }

  private record(context: LlmContext): void {
    this.validation.push({
      page: context.identity.page,
      route: context.identity.route,
      status: context.validation.status,
      items: context.validation.items.map((item) => item.label),
    });
  }

  // ----- The scenario ------------------------------------------------------------------------

  /**
   * The reference scenario: a tank with its level transmitter and inlet valve, emptied by a
   * pump on a motor and a drive; one compact PLC with the channels they need; every
   * endpoint wired; the tank as a process module bound to the PLC's tags; validation read
   * from the pages; the design reported.
   */
  async run(): Promise<AgentReport> {
    // 1. The LLM Index: the parts, the areas and the recommended workflow.
    await this.open("/llm-index");
    const index = await this.page.eval<{
      sections: string[];
      areas: Array<{ key: string; links: string[] }>;
      workflow: string[];
    }>(`({
      sections: [...document.querySelectorAll('section[data-llm-section]')].map((s) => s.dataset.llmSection),
      areas: [...document.querySelectorAll('article[data-llm-area]')].map((a) => ({ key: a.dataset.llmArea, links: [...a.querySelectorAll('a[href^="/"]')].map((l) => l.getAttribute('href')) })),
      workflow: [...document.querySelectorAll('section[data-llm-section="workflow"] li')].map((li) => li.textContent.trim()),
    })`);
    this.index = { sections: index.sections, areas: index.areas.map((area) => area.key), workflow: index.workflow };
    const factoriesLink = index.areas.find((area) => area.key === "factories")?.links[0];
    if (!factoriesLink) throw new Error("The LLM Index has no link to the Factories area.");

    // 2. Factories: the context's action to create one.
    let context = this.need(await this.open(factoriesLink), "Factories");
    context = (await this.open(BrowserAgent.href(context.actions, /new factory/i, "New factory action"))) as LlmContext;

    // 3. The factory form has no context (the overview carries its decisions): the index's
    //    rules still make the name and the subnet the user's call.
    const page = "New factory";
    const name = await this.decide(page, undefined, { label: "Which name for the factory?", kind: "name" });
    const subnet = await this.decide(page, undefined, {
      label: "Which subnet for the factory's network?",
      kind: "name",
      detail: "An isolated range no other factory uses; the application refuses an overlap.",
    });
    await this.setValue("input[name=name]", name);
    if (!(await this.page.eval<string>(`document.querySelector('input[name=slug]').value`))) {
      await this.setValue("input[name=slug]", name.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
    }
    await this.setValue("input[name=subnetCidr]", subnet);
    await this.click("form button[type=submit]");
    await this.page.waitFor(
      `/^\\/factories\\/[^/]+$/.test(location.pathname) || document.querySelector('[role=alert]')`,
      {
        what: "the factory to be created",
      },
    );
    await this.refusalCheck("Creating the factory");
    context = this.need(await this.arrived(true), "Factory overview");
    const factoryRoute = context.identity.route;
    this.changes.push(`Created the factory ${name} with subnet ${subnet}`);

    // 4. The PLC: the overview says which decision to ask, and where to add one.
    const plcDecision = BrowserAgent.find(context.decisions, /which plc/i);
    const architecture = await this.decide(context.identity.page, plcDecision, { label: "Which PLC?", kind: "model" }, [
      "compact",
      "modular",
    ]);
    context = this.need(
      await this.open(
        BrowserAgent.href(context.actions, new RegExp(`add ${architecture} plc`, "i"), `Add ${architecture} PLC`),
      ),
      "New PLC",
    );
    const models = await this.page.eval<Array<{ value: string; text: string }>>(
      `[...document.querySelectorAll('input[name=deviceModelId]')].map((radio) => ({ value: radio.value, text: [...radio.closest('label').querySelectorAll(':scope > span > span')].map((span) => span.textContent.trim()).join(' · ') }))`,
    );
    const modelAnswer = await this.decide(
      context.identity.page,
      BrowserAgent.find(context.decisions, /model/i),
      { label: "Which PLC model?", kind: "model" },
      models.map((model) => model.text),
    );
    const model = BrowserAgent.pick(models, modelAnswer, "PLC model");
    await this.click(`input[name=deviceModelId][value=${quote(model.value)}]`);
    const plcName = await this.page.eval<string>(`document.querySelector('input[name=name]').value`);
    await this.click("form button[type=submit]");
    await this.page.waitFor(`/\\/plcs\\/[^/]+/.test(location.pathname) || document.querySelector('[role=alert]')`, {
      what: "the PLC to be created",
    });
    await this.refusalCheck("Creating the PLC");
    context = this.need(await this.arrived(true), "PLC hardware");
    const plc: Device = { name: plcName, id: context.identity.route.split("/plcs/")[1]!.split("/")[0]! };
    this.changes.push(`Created the ${architecture} PLC ${plcName} from ${model.text}`);

    // 5. Capacity: the devices need one AI, two DO and one DI; the context says what is free.
    const free: Record<string, number> = {};
    for (const item of context.capacity) {
      const match = /^(\d+) of (\d+) (DI|DO|AI|AO) free$/.exec(item.value ?? "");
      if (match) free[match[3]!] = (free[match[3]!] ?? 0) + Number(match[1]);
      this.capacity.push(`${item.label}: ${item.value ?? ""}`);
    }
    for (const [type, needed] of Object.entries({ AI: 1, DO: 2, DI: 1 })) {
      if ((free[type] ?? 0) < needed) {
        throw new Error(`${plcName} has ${free[type] ?? 0} free ${type}; the design needs ${needed}.`);
      }
    }
    this.capacity.push(`Confirmed: ${plcName} has the 1 AI, 2 DO and 1 DI the design needs.`);
    const mappingRoute = BrowserAgent.href(context.navigation, /i\/o mapping/i, "I/O mapping link");
    const programRoute = BrowserAgent.href(context.navigation, /^program$/i, "Program link");

    // 6. The designer: a device per purpose, each from a model the user chooses in the palette.
    const designerRoute = BrowserAgent.href(context.navigation, /designer/i, "designer link");
    context = this.need(await this.open(designerRoute), "Designer");
    const palette = await this.page.eval<Array<{ text: string; group: string }>>(
      `[...document.querySelectorAll('button[aria-label^="Add "]')].map((b) => ({ text: b.getAttribute('aria-label').slice(4), group: (b.closest('section')?.querySelector('h3')?.textContent || '').replace('▾', '').trim() }))`,
    );
    const modelDecision = BrowserAgent.find(context.decisions, /which model for a new device/i);
    const devices: Record<string, Device> = {};
    for (const purpose of ["level transmitter", "inlet valve", "pump", "motor", "drive for the motor"]) {
      const answer = await this.decide(
        context.identity.page,
        modelDecision && { ...modelDecision, label: `Which model for the ${purpose}?` },
        { label: `Which model for the ${purpose}?`, kind: "model" },
        palette.map((item) => `${item.group} · ${item.text}`),
      );
      const item =
        palette.find((candidate) => candidate.text === answer || `${candidate.group} · ${candidate.text}` === answer) ??
        BrowserAgent.pick(palette, answer, "palette model");
      const before = context.objects.length;
      const stale = await this.page.eval<string>(
        `document.querySelector('${PALETTE} [role=status]')?.textContent.trim() || ''`,
      );
      await this.click(`button[aria-label=${quote(`Add ${item.text}`)}]`);
      const status = await this.page.waitFor<string>(
        `(() => { const s = document.querySelector('${PALETTE} [role=status]'); const text = s ? s.textContent.trim() : ''; return text && text !== ${quote(stale)} ? text : null; })()`,
        { what: "the palette's answer" },
      );
      if (!status.startsWith("Added ")) throw new AgentRefusal(`Adding ${item.text}`, status, null, null);
      const deviceName = status.slice("Added ".length).trim();
      context = await this.contextWhen((c) => c.objects.length > before, `${deviceName} among the objects`);
      const object = context.objects.find((candidate) => candidate.label === deviceName);
      const id = object?.href?.split("/").pop();
      if (!id) throw new Error(`The designer's context does not list ${deviceName} with a link.`);
      devices[purpose] = { name: deviceName, id };
      this.changes.push(`Added ${deviceName} (${item.text}) in the designer`);
    }

    // 7. Connections: relationships between field devices, wires to the PLC.
    await this.connect(context, devices["drive for the motor"]!, devices.motor!, plc);
    await this.connect(context, devices.motor!, devices.pump!, plc);
    await this.connect(context, devices["level transmitter"]!, plc, plc, [{ terminal: /^OUT\b/, point: /^AI\b/ }]);
    await this.connect(context, devices["inlet valve"]!, plc, plc, [{ terminal: /^Y1\b/, point: /^DO\b/ }]);
    await this.connect(context, devices["drive for the motor"]!, plc, plc, [
      { terminal: /^RUN\b/, point: /^DO\b/ },
      { terminal: /^RUNNING\b/, point: /^DI\b/ },
    ]);

    // 8. The program, the workflow's next step: the control logic is the user's decision; the
    //    editor's Check, then Save version, as the context's actions describe them.
    context = this.need(await this.open(programRoute), "PLC program");
    const logic = await this.decide(context.identity.page, BrowserAgent.find(context.decisions, /control logic/i), {
      label: "Control logic",
      kind: "control-logic",
    });
    if (!/starter program/i.test(logic)) await this.setValue("textarea[name=sourceText]", logic);
    const status = `(() => { const s = document.querySelector('form [role=status]'); const text = s ? s.textContent.trim() : ''; return text || null; })()`;
    await this.click("form button[name=intent][value=check]");
    const checked = await this.page.waitFor<string>(status, { what: "the compiler's answer", timeout: 90_000 });
    if (await this.page.eval<boolean>(`!!document.querySelector('form [role=status] .zf-error')`)) {
      throw new AgentRefusal("Checking the program", checked, null, null);
    }
    await this.click("form button[name=intent][value=save]");
    const saved = await this.page.waitFor<string>(
      `(() => { const text = ${status}; return text && text !== ${quote(checked)} ? text : null; })()`,
      { what: "the saved version", timeout: 60_000 },
    );
    const version = /version (\d+)/.exec(saved)?.[1];
    if (!version) throw new AgentRefusal("Saving the program", saved, null, null);
    this.changes.push(
      `Checked the program of ${plcName}: ${checked}`,
      `Saved program version ${version} of ${plcName}`,
    );

    // 9. The designer's validation, and the design as the context states it.
    context = this.need(await this.open(designerRoute), "Designer");
    this.record(context);
    this.design.push(...context.relationships.map((item) => item.label));

    // 10. The tank as a process module: type, profile and name are the user's.
    context = this.need(await this.open(factoryRoute), "Factory overview");
    context = this.need(
      await this.open(BrowserAgent.href(context.navigation, /process modules/i, "Process modules link")),
      "Process modules",
    );
    const processDecision = BrowserAgent.find(context.decisions, /which process/i);
    const types = await this.choices("form[aria-label='New process module'] select[name=typeId]");
    const typeAnswer = await this.decide(
      context.identity.page,
      processDecision,
      { label: "Which process module type?", kind: "scope" },
      types.map((type) => type.text),
    );
    const type = BrowserAgent.pick(types, typeAnswer, "module type");
    await this.setValue("form[aria-label='New process module'] select[name=typeId]", type.value);
    const profiles = await this.page
      .eval<boolean>(`!!document.querySelector("form[aria-label='New process module'] select[name=profile]")`)
      .then((exists) => (exists ? this.choices("form[aria-label='New process module'] select[name=profile]") : []));
    if (profiles.length > 0) {
      const profile = await this.decide(
        context.identity.page,
        processDecision && { ...processDecision, label: `Which profile for the ${type.text}?` },
        { label: `Which profile for the ${type.text}?`, kind: "scope" },
        profiles.map((option) => option.text),
      );
      await this.setValue(
        "form[aria-label='New process module'] select[name=profile]",
        BrowserAgent.pick(profiles, profile, "profile").value,
      );
    }
    const moduleName = await this.decide(context.identity.page, undefined, {
      label: "Which name for the module?",
      kind: "name",
    });
    await this.setValue("form[aria-label='New process module'] input[name=name]", moduleName);
    await this.click("form[aria-label='New process module'] button[type=submit]");
    await this.page.waitFor(`/\\/modules\\/[^/]+$/.test(location.pathname) || document.querySelector('[role=alert]')`, {
      what: "the module to be created",
    });
    await this.refusalCheck("Creating the module");
    context = this.need(await this.arrived(true), "Module editor");
    const moduleRoute = context.identity.route;
    this.changes.push(`Created the process module ${moduleName} (${type.text})`);

    // 11. Roles: every empty required role is a decision in the context; the picker offers only fitting devices.
    for (const decision of context.decisions.filter((item) => /^Which device for (.+)\?$/.test(item.label))) {
      const role = /^Which device for (.+)\?$/.exec(decision.label)![1]!;
      const picker = `select[aria-label=${quote(`Device for ${role}`)}]`;
      const candidates = (await this.choices(picker)).filter((option) => option.value);
      const answer = await this.decide(
        context.identity.page,
        decision,
        { label: decision.label, kind: "relationship" },
        candidates.map((option) => option.text),
      );
      const chosen = BrowserAgent.pick(candidates, answer, `device for ${role}`);
      await this.setValue(picker, chosen.value);
      await this.click(`form[aria-label=${quote(`Assign a device as ${role}`)}] button[type=submit]`);
      const deviceName = chosen.text.split(" · ")[0]!;
      context = await this.contextWhen(
        (c) => c.relationships.some((item) => item.label === `${deviceName} fills role ${role}`),
        `${deviceName} in the role ${role}`,
      );
      this.changes.push(`Assigned ${deviceName} as ${role} of ${moduleName}`);
    }

    // 12. Bindings: the required signals still unbound, each to a tag the user picks among the free compatible ones.
    if (BrowserAgent.find(context.decisions, /which plc tags/i)) {
      const unbound = await this.page.eval<string[]>(
        `[...document.querySelectorAll('table[aria-label="Consumed PLC I/O registry"] tbody tr')].filter((tr) => tr.textContent.includes('required · unbound')).map((tr) => tr.querySelector('form')?.getAttribute('aria-label')?.slice(5)).filter(Boolean)`,
      );
      for (const signal of unbound) {
        const picker = `select[aria-label=${quote(`Tag for ${signal}`)}]`;
        const offered = (await this.choices(picker)).filter((option) => option.value);
        const candidates = offered.filter((option) => !option.disabled);
        if (candidates.length === 0) {
          // The picker names every tag and why it cannot be used: that is reported, not worked around.
          const why = [...new Set(offered.map((option) => option.text.split(" — ")[1] ?? option.text))];
          this.blocked.push({ what: `Bind ${signal} of ${moduleName}`, why });
          continue;
        }
        const answer = await this.decide(
          context.identity.page,
          BrowserAgent.find(context.decisions, /which plc tags/i)!,
          { label: `Which PLC tag for ${signal}?`, kind: "channel" },
          candidates.map((option) => option.text),
        );
        const chosen = BrowserAgent.pick(candidates, answer, `tag for ${signal}`);
        await this.setValue(picker, chosen.value);
        await this.click(`form[aria-label=${quote(`Bind ${signal}`)}] button[value=bind]`);
        context = await this.contextWhen(
          (c) => !c.validation.items.some((item) => item.label === `Required signal ${signal} is not bound`),
          `${signal} bound`,
        );
        await this.refusalCheck(`Binding ${signal}`, `form[aria-label=${quote(`Bind ${signal}`)}]`);
        this.changes.push(`Bound ${signal} of ${moduleName} to ${chosen.text}`);
      }
    }

    // 13. Validation as the pages state it, and the I/O mapping the wiring produced.
    context = this.need(await this.open(moduleRoute), "Module editor");
    this.record(context);
    this.design.push(...context.relationships.map((item) => item.label));
    context = this.need(await this.open(factoryRoute), "Factory overview");
    this.record(context);
    context = this.need(await this.open(mappingRoute), "I/O mapping");
    this.record(context);
    this.design.push(...context.objects.map((item) => `${item.label}${item.value ? `: ${item.value}` : ""}`));

    return this.report();
  }

  /**
   * Connects two devices from the inspector, as drawing between their handles does. The
   * canvas answers with a choice of relationships (asked of the user), a refusal (read
   * and reported), a stored relationship, or the pin-to-pin wiring editor, where the
   * wanted wires are made one by one.
   */
  private async connect(context: LlmContext, from: Device, to: Device, plc: Device, wires: WireSpec[] = []) {
    await this.click(`.react-flow__node[data-id=${quote(from.id)}]`);
    await this.page.waitFor(`document.querySelector('#inspector-name')?.value === ${quote(from.name)}`, {
      what: `${from.name} in the inspector`,
    });
    await this.setValue("#inspector-connect", to.id);
    const edges = await this.page.eval<number>(`document.querySelectorAll('.react-flow__edge').length`);
    await this.click(`form[aria-label^="Connect "] button[type=submit]`);
    // After the user chose, the dialog stays until the canvas has answered: it is no longer an outcome.
    const outcome = (afterChoice = false) =>
      this.page.waitFor<string>(
        `(() => {
          const dialog = document.querySelector('[role=dialog][aria-label="Choose the relationship"]');
          if (dialog && !${afterChoice}) return "choose";
          if (document.querySelector('.zf-flow [role=alert]')) return "refused";
          if (document.querySelector('#wire-from')) return "wire";
          if (document.querySelectorAll('.react-flow__edge').length > ${edges}) return "linked";
          return null;
        })()`,
        { what: `the canvas to answer connecting ${from.name} to ${to.name}` },
      );
    let result = await outcome();
    if (result === "choose") {
      const options = await this.page.eval<string[]>(
        `[...document.querySelectorAll('[role=dialog][aria-label="Choose the relationship"] button')].map((b) => b.textContent.trim()).filter((t) => t !== 'Cancel')`,
      );
      const answer = await this.decide(
        context.identity.page,
        BrowserAgent.find(context.decisions, /which relationship/i),
        { label: "Which relationship, when the canvas asks?", kind: "relationship" },
        options,
      );
      const chosen = BrowserAgent.pick(
        options.map((text) => ({ text })),
        answer,
        "relationship",
      ).text;
      await this.page.eval(
        `[...document.querySelectorAll('[role=dialog][aria-label="Choose the relationship"] button')].find((b) => b.textContent.trim() === ${quote(chosen)}).click()`,
      );
      result = await outcome(true);
    }
    if (result === "refused") await this.refusalCheck(`Connecting ${from.name} to ${to.name}`, ".zf-flow");
    if (result === "linked") {
      const refreshed = await this.contextWhen(
        (c) => c.relationships.length > context.relationships.length,
        `the connection of ${from.name} and ${to.name}`,
      );
      const sentence = refreshed.relationships.find(
        (item) => item.label.includes(from.name) && item.label.includes(to.name),
      );
      this.changes.push(`Connected: ${sentence?.label ?? `${from.name} to ${to.name}`}`);
      context.relationships = refreshed.relationships;
      return;
    }
    if (result !== "wire") throw new Error(`Unexpected canvas answer "${result}".`);
    if (wires.length === 0)
      throw new Error(`The canvas opened wiring for ${from.name} and ${to.name}; no wire was wanted.`);
    for (const wire of wires) await this.wire(context, from, plc, wire);
  }

  /** One wire in the editor: the device terminal and the first free compatible PLC point of the wanted type. */
  private async wire(context: LlmContext, device: Device, plc: Device, spec: WireSpec): Promise<void> {
    const firstIsPlc = await this.page.eval<boolean>(
      `document.querySelector('label[for=wire-from]').textContent.startsWith(${quote(plc.name)})`,
    );
    const [pointSelect, terminalSelect] = firstIsPlc ? ["#wire-from", "#wire-to"] : ["#wire-to", "#wire-from"];
    const wireList = `${INSPECTOR} li span.mono.text-xs.whitespace-normal`;
    const before = await this.page.eval<number>(`document.querySelectorAll(${quote(wireList)}).length`);
    // The terminal first when it is the editor's first side: choosing it proposes a destination.
    if (!firstIsPlc) {
      const terminals = (await this.choices(terminalSelect)).filter((option) => spec.terminal.test(option.text));
      if (terminals.length === 0) throw new Error(`${device.name} offers no terminal matching ${spec.terminal}.`);
      await this.setValue(terminalSelect, terminals[0]!.value);
    }
    // The PLC's points of the wanted type that can still take the terminal: the editor marks
    // the destinations of a chosen point, so each candidate is tried.
    const typed = (await this.choices(pointSelect)).filter(
      (option) => spec.point.test(option.text) && !option.text.includes("not possible"),
    );
    const points: typeof typed = [];
    for (const point of typed) {
      if (!firstIsPlc) {
        points.push(point);
        continue;
      }
      await this.setValue(pointSelect, point.value);
      const terminals = (await this.choices(terminalSelect)).filter(
        (option) => spec.terminal.test(option.text) && !option.text.includes("not possible"),
      );
      if (terminals.length > 0) points.push(point);
    }
    if (points.length === 0)
      throw new Error(`${plc.name} offers no free point matching ${spec.point} for ${device.name}.`);
    const chosen = await this.decide(
      context.identity.page,
      {
        label: "Which channel?",
        decision: {
          kind: "channel",
          confirm: "optional",
          defaultChoice: "the first free compatible channel, as the designer assigns it",
        },
      },
      { label: "Which channel?", kind: "channel" },
      points.map((point) => point.text),
    );
    await this.setValue(pointSelect, BrowserAgent.pick(points, chosen, "PLC point").value);
    if (firstIsPlc) {
      const terminals = (await this.choices(terminalSelect)).filter(
        (option) => spec.terminal.test(option.text) && !option.text.includes("not possible"),
      );
      if (terminals.length === 0) throw new Error(`${device.name} offers no free terminal matching ${spec.terminal}.`);
      await this.setValue(terminalSelect, terminals[0]!.value);
    }
    await this.refusalCheck(`Wiring ${device.name} to ${plc.name}`, `${INSPECTOR} form`);
    await this.click(`${INSPECTOR} form button[type=submit]`);
    // Once the wire is stored the editor reloads and proposes the next pair, which may have
    // nothing left to offer: only a refusal while the count has not grown is this wire's.
    const stored = await this.page.waitFor<string>(
      `document.querySelectorAll(${quote(wireList)}).length > ${before} ? "stored" : document.querySelector(${quote(`${INSPECTOR} form [role=alert]`)}) ? "refused" : null`,
      { what: `the wire of ${device.name} to be stored` },
    );
    if (stored === "refused") await this.refusalCheck(`Wiring ${device.name} to ${plc.name}`, `${INSPECTOR} form`);
    const wires = await this.page.eval<string[]>(
      `[...document.querySelectorAll(${quote(wireList)})].map((s) => s.textContent)`,
    );
    this.changes.push(`Wired ${wires[wires.length - 1] ?? `${device.name} to ${plc.name}`}`);
  }

  // ----- The report ----------------------------------------------------------------------------

  private report(): AgentReport {
    const lines = [
      "# Browser agent report",
      "",
      "## Pages used",
      ...this.visits.map(
        (visit) => `- \`${visit.route}\` — ${visit.page ?? "no LLM Context"}${visit.area ? ` (${visit.area})` : ""}`,
      ),
      "",
      "## Decisions asked",
      ...this.asked.map((question) => `- ${question.label} (${question.kind}) → ${question.answer}`),
      "",
      "## Defaults applied",
      ...(this.defaulted.length > 0
        ? this.defaulted.map((question) => `- ${question.label}: ${question.applied} (${question.defaultChoice})`)
        : ["- none"]),
      "",
      "## Changes made",
      ...this.changes.map((change) => `- ${change}`),
      "",
      "## Capacity",
      ...this.capacity.map((line) => `- ${line}`),
      "",
      "## Validation",
      ...this.validation.map(
        (entry) => `- ${entry.page}: ${entry.status}${entry.items.length > 0 ? ` — ${entry.items.join("; ")}` : ""}`,
      ),
      "",
      "## The design",
      ...this.design.map((line) => `- ${line}`),
      "",
      "## Not possible through the pages",
      ...(this.blocked.length > 0
        ? this.blocked.map((entry) => `- ${entry.what}: ${entry.why.join("; ")}`)
        : ["- nothing"]),
    ];
    return {
      visits: this.visits,
      index: this.index,
      asked: this.asked,
      defaulted: this.defaulted,
      changes: this.changes,
      capacity: this.capacity,
      validation: this.validation,
      design: this.design,
      blocked: this.blocked,
      markdown: lines.join("\n"),
    };
  }
}
