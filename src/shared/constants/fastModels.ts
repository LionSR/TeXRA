/**
 * Heuristic for identifying "fast first response" models — non-reasoning,
 * smaller variants that return their first token quickly.
 *
 * Surfaced in the model picker with a hint nudging free-tier users to start
 * here for snappier replies before reaching for the heavier thinking models.
 *
 * Keep the set small and conservative: false positives (labeling a slow
 * model as fast) are worse than false negatives.
 */

/**
 * Short-name patterns that strongly imply a small/fast variant.
 *
 * `mini` requires a non-letter on both sides so that provider names like
 * `gemini*` and `minimax*` (which contain the substring `mini`) don't match.
 *
 * The trailing `[fmn]` rule covers llm-zoo's short-name conventions for
 * flash / mini / nano variants (e.g. `gemini3f`, `gpt5m`, `gpt5n`). The
 * preceding non-letter requirement avoids matching unrelated short names
 * that happen to end in those letters mid-word (e.g. `glm`, `claudeXm`).
 */
const FAST_NAME_PATTERNS: readonly RegExp[] = [
  /flash/i,
  /haiku/i,
  /(^|[^a-z])mini([^a-z]|$)/i,
  /nano/i,
  /lite/i,
  /[^a-z][fmn]$/i,
];

/**
 * Explicit allowlist of fast non-reasoning flagship models whose short names
 * don't match the patterns above.
 *
 * llm-zoo short-name conventions used here:
 *   - trailing `T` = extended thinking (slow) → excluded
 *   - trailing `p` = "pro" reasoning variant (slow) → excluded
 *   - trailing `f` = flash, `m` = mini, `n` = nano (already covered by patterns)
 */
const FAST_EXPLICIT_NAMES: ReadonlySet<string> = new Set([
  'gpt54',
  'gpt53',
  'gpt52',
  'gpt51',
  'gpt5',
  'sonnet46',
  'sonnet45',
]);

/** Returns true when the given model short name is a "fast first response" pick. */
export function isFastFirstResponseModel(shortName: string): boolean {
  if (FAST_EXPLICIT_NAMES.has(shortName)) return true;
  return FAST_NAME_PATTERNS.some((re) => re.test(shortName));
}

/** Hint string prepended to the model tooltip when the model qualifies. */
export const FAST_FIRST_RESPONSE_HINT =
  '⚡ Fast first response — try this for quick replies';
