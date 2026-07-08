/**
 * Price-based predicate for "fast first response" models.
 *
 * Models strictly under $1/M input are treated as small, fast, cheap variants
 * that are a reasonable first try. Using pricing as the single source of truth
 * avoids the substring-match foot-guns that plagued earlier regex-based versions
 * (matching `gemini*`, `minimax*`, etc. unintentionally).
 *
 * Note: this threshold is intentionally separate from the relay's free-tier
 * cutoff. The free tier may include capable mid-range models (e.g. Sonnet at
 * $3/M) that are not "fast" in the latency sense.
 */

/** Input-price ceiling (USD per million tokens) for the fast-model hint. */
const FAST_FIRST_RESPONSE_PRICE_CEILING = 1;

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
  return (
    inputPrice !== undefined && inputPrice < FAST_FIRST_RESPONSE_PRICE_CEILING
  );
}
