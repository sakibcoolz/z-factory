import { routes } from "./routes";

/**
 * The activity bar (docs/design.md → Activity bar): the entries every screen shows on its
 * left edge. The LLM Index (TASK-1001) lists its engineering areas under these keys, so a
 * new activity is added here and nowhere else.
 */
export type ActivityKey = "factories" | "catalog" | "designer" | "runtime" | "tags" | "events" | "export" | "llm";

/** The factory (and its PLC) the factory-scoped activities should open. */
export type FactoryContext = {
  factoryId: string;
  plcId: string;
};

export type Activity = {
  key: ActivityKey;
  /** The three letters shown in the bar. */
  short: string;
  label: string;
  /** The entry's destination; `undefined` while no factory is open. */
  href: (context: FactoryContext | undefined) => string | undefined;
};

export const ACTIVITIES: readonly Activity[] = [
  { key: "factories", short: "FAC", label: "Factories", href: () => routes.factories() },
  { key: "catalog", short: "CAT", label: "Device catalog", href: () => routes.catalog() },
  { key: "designer", short: "DSN", label: "Designer", href: (c) => c && routes.designer(c.factoryId) },
  { key: "runtime", short: "RUN", label: "Runtime", href: (c) => c && routes.runtime(c.factoryId) },
  { key: "tags", short: "TAG", label: "Live tags", href: (c) => c && routes.tags(c.factoryId) },
  { key: "events", short: "EVT", label: "Events", href: (c) => c && routes.events(c.factoryId) },
  { key: "export", short: "EXP", label: "PLC export", href: (c) => c && routes.plcExport(c.factoryId, c.plcId) },
  { key: "llm", short: "LLM", label: "LLM Index", href: () => routes.llmIndex() },
];
