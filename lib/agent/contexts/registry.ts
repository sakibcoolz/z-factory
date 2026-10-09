/**
 * The engineering areas of the LLM Index whose pages have an LLM Context panel. An area is
 * added here when its builder under `lib/agent/contexts/` is wired into its page; the LLM
 * Index derives its "LLM Context" column from this set, and `llm-index.test.ts` checks that
 * every key names an area that exists.
 */
export const LLM_CONTEXT_AREAS: ReadonlySet<string> = new Set(["factory"]);
