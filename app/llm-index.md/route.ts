import { buildLlmIndex } from "@/lib/agent/llm-index";
import { renderLlmIndexMarkdown } from "@/lib/agent/llm-index-markdown";

/**
 * The LLM Index as Markdown (TASK-1001), for agents that fetch rather than render pages.
 * The same registry as the `/llm-index` page; nothing here reads the database or needs an
 * owner, since the index describes the product, not a factory.
 */
export function GET(): Response {
  return new Response(renderLlmIndexMarkdown(buildLlmIndex()), {
    headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" },
  });
}
