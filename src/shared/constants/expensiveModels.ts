/**
 * Predicate and copy for models whose API pricing is high enough that we
 * actively steer users toward the External Inquiry tool — which lets agents
 * ask the user to paste an answer from their own ChatGPT/Claude/Gemini
 * subscription instead of paying per-token API rates. For OpenAI's "-pro"
 * variants ($15-$30 input, $120-$180 output per 1M) a single agentic turn
 * can cost tens of dollars.
 *
 * The match is name-shaped (`gpt<digits>pro`) rather than price-thresholded
 * so a future flagship Pro release stays covered without a tweak, and other
 * vendors' priciest reasoning models aren't lumped in.
 */

/** Hint string prepended to the model tooltip when the model qualifies. */
export const EXPENSIVE_MODEL_HINT =
  '💸 Premium API pricing — consider the External Inquiry tool to use your own ChatGPT/Claude subscription instead';

const GPT_PRO_NAME = /^gpt\d+pro$/;

/** Returns true when API use of the model is expensive enough to warn about. */
export function isExpensiveModel(provider: string, name: string): boolean {
  return provider === 'openai' && GPT_PRO_NAME.test(name);
}
