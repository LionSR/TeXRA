/**
 * Price-based predicate for "fast first response" models.
 *
 * Mirrors the relay's tier definition (`supabase/functions/relay/models.ts`):
 * anything under $1/M input tokens is treated as a small, fast, cheap
 * variant that's a reasonable first try for free-tier users. Using pricing
 * as the single source of truth — rather than a name heuristic — keeps this
 * aligned with the existing tier taxonomy and avoids the substring-match
 * foot-guns that plagued earlier regex-based versions (matching `gemini*`,
 * `minimax*`, etc. unintentionally).
 */

/** Input-price ceiling (USD per million tokens) for a "fast first response" pick. */
export const FAST_FIRST_RESPONSE_PRICE_CEILING = 1;

/** Hint string prepended to the model tooltip when the model qualifies. */
export const FAST_FIRST_RESPONSE_HINT =
  '⚡ Fast first response — try this for quick replies';

/**
 * Returns true when a model's input price qualifies it as a fast first-try pick.
 * Undefined prices (unpriced / local / custom) are treated as non-fast.
 */
export function isFastFirstResponseModel(
  inputPrice: number | undefined,
): boolean {
  return inputPrice !== undefined && inputPrice <= FAST_FIRST_RESPONSE_PRICE_CEILING;
}
