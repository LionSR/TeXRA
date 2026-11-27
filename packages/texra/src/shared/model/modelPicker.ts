/**
 * The model picker's own copy: the pricing hints a row's tooltip and badge
 * carry, and the reasoning-level labels. Plain data and pure predicates, so
 * the settings webview renders the same words the hosts build rows with.
 */
import { ReasoningEffort, selectModel } from '@texra-ai/llm';
import { getModelLabel, joinFacts } from '@texra-ai/worldline/schemas';

/**
 * Display labels for llm-zoo's reasoning efforts, written low → high. The key type keeps the record
 * exhaustive against the registry vocabulary.
 */
export const REASONING_LEVEL_LABELS: Record<ReasoningEffort, string> =
  Object.freeze({
    [ReasoningEffort.NONE]: 'None',
    [ReasoningEffort.MINIMAL]: 'Minimal',
    [ReasoningEffort.LOW]: 'Low',
    [ReasoningEffort.MEDIUM]: 'Medium',
    [ReasoningEffort.HIGH]: 'High',
    [ReasoningEffort.XHIGH]: 'Extra High',
    [ReasoningEffort.MAX]: 'Max',
  });
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
  'Fast first response — good for quick replies';

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
 * Models whose API pricing is high enough that the picker warns about it.
 *
 * The test is the output price, not the name: a model's name does not say
 * whether it is a Pro tier. Pro-tier models price output at $80+ per 1M, and
 * every other model is cheaper, so $80 separates the two.
 */
const EXPENSIVE_OUTPUT_PRICE_FLOOR = 80;

/** Hint prepended to an expensive model's picker tooltip, and its badge. */
export const EXPENSIVE_MODEL_HINT = 'Premium API pricing';

/**
 * Whether API use of a model is expensive enough to warn about. Undefined
 * prices (unpriced, local, custom) are not expensive.
 */
export function isExpensiveModel(outputPrice: number | undefined): boolean {
  return (
    outputPrice !== undefined && outputPrice >= EXPENSIVE_OUTPUT_PRICE_FLOOR
  );
}

/**
 * A model selection as a person reads it, the effort and mode it names
 * included: `GPT 6.1 Sol · High · Pro` for `openai/gpt-6.1-sol@high+pro`.
 * Two selections that run differently never read the same.
 */
export function modelSelectionLabel(model: string): string {
  const request = selectModel(model)?.request;
  return joinFacts([
    getModelLabel(model),
    request?.effort !== undefined && REASONING_LEVEL_LABELS[request.effort],
    request?.mode === 'pro' ? 'Pro' : request?.mode,
  ]);
}
