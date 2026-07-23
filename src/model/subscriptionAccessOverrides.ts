/**
 * Shared "billed by subscription, not per token" fact for a runtime model
 * config: the access route is zero-cost per API call, and the caller has
 * already resolved the context window actually available on that route.
 *
 * Every access route that hits this (Copilot LM API models, Kimi Code,
 * ChatGPT/Codex subscription) hand-writes the identical `inputPrice: 0,
 * outputPrice: 0` pair; only that pair is genuinely duplicated. The
 * `contextWindow` cap formula differs per route (an external API's own
 * limit, a fixed subscription-tier constant, a `Math.min` against the base
 * registry window, …), so callers compute it themselves and pass the
 * resolved value in rather than have this helper guess at a formula.
 */
export function zeroCostAccessOverrides(contextWindow: number): {
  readonly inputPrice: 0;
  readonly outputPrice: 0;
  readonly contextWindow: number;
} {
  return { inputPrice: 0, outputPrice: 0, contextWindow };
}
