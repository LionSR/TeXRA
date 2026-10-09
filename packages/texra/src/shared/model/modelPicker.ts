/**
 * The model picker's own copy: the pricing hints a row's tooltip and badge
 * carry, and the reasoning-level labels. Plain data and pure predicates, so
 * the settings webview renders the same words the hosts build rows with.
 */
import { ReasoningEffort } from 'llm-zoo';

/**
 * Display labels for llm-zoo's reasoning efforts, written low → high because
 * the picker offers them in that order. The key type keeps the record
 * exhaustive against the registry vocabulary.
 */
export const REASONING_LEVEL_LABELS: Record<ReasoningEffort, string> = {
  [ReasoningEffort.NONE]: 'None',
  [ReasoningEffort.MINIMAL]: 'Minimal',
  [ReasoningEffort.LOW]: 'Low',
  [ReasoningEffort.MEDIUM]: 'Medium',
  [ReasoningEffort.HIGH]: 'High',
  [ReasoningEffort.XHIGH]: 'Extra High',
  [ReasoningEffort.MAX]: 'Max',
};
/** The reasoning levels a picker offers, low to high, with their labels. */
export const REASONING_LEVEL_OPTIONS: readonly {
  readonly value: ReasoningEffort;
  readonly label: string;
}[] = Object.entries(REASONING_LEVEL_LABELS).map(([value, label]) => ({
  value: value as ReasoningEffort,
  label,
}));

/**
 * Price-based "fast first response" hint: models strictly under $1/M input
 * are small, fast, cheap variants that make a reasonable first try. Pricing
 * is the one source of truth, which avoids the substring-match foot-guns of
 * earlier name-based versions (matching `gemini*`, `minimax*` by accident).
 * Capable mid-range models (Sonnet at $3/M) are deliberately not "fast" in
 * this latency sense.
 */
const FAST_FIRST_RESPONSE_PRICE_CEILING = 1;

/** Hint prepended to a fast model's picker tooltip. */
export const FAST_FIRST_RESPONSE_HINT =
  '⚡ Fast first response — try this for quick replies';

/**
 * Whether a model's input price qualifies it as a fast first-try pick.
 * Undefined prices (unpriced, local, custom) are not fast.
 */
export function isFastFirstResponseModel(
  inputPrice: number | undefined,
): boolean {
  return (
    inputPrice !== undefined && inputPrice < FAST_FIRST_RESPONSE_PRICE_CEILING
  );
}

/**
 * Models whose API pricing is high enough that the picker steers users to
 * the External Inquiry tool, which lets agents ask the user to paste an
 * answer from their own ChatGPT/Claude/Gemini subscription instead.
 *
 * The test is the output price, not the name: `gpt<digits>pro` once meant
 * "Pro tier", but `gpt56pro` ships at $4/$20 while `o1pro` ($150/$600) and
 * `o3pro` ($20/$80) never matched. The Pro tier (o3pro, gpt5pro … gpt55pro,
 * o1pro) plus gpt45 all price output at $80+ per 1M; the most expensive
 * flagship tier (Opus 4/4.1) tops out at $75, so $80 separates the two.
 */
const EXPENSIVE_OUTPUT_PRICE_FLOOR = 80;

/** Hint prepended to an expensive model's picker tooltip, and its badge. */
export const EXPENSIVE_MODEL_HINT =
  '💸 Premium API pricing — consider the External Inquiry tool to use your own ChatGPT/Claude subscription instead';

/**
 * Whether API use of a model is expensive enough to warn about. Undefined
 * prices (unpriced, local, custom) are not expensive.
 */
export function isExpensiveModel(outputPrice: number | undefined): boolean {
  return (
    outputPrice !== undefined && outputPrice >= EXPENSIVE_OUTPUT_PRICE_FLOOR
  );
}
