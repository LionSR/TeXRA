/**
 * Predicate and copy for models whose API pricing is high enough that we
 * actively steer users toward the External Inquiry tool instead.
 *
 * External Inquiry lets agents ask the user to paste an answer from an
 * existing ChatGPT/Claude/Gemini subscription back into the run, avoiding
 * per-token API charges entirely. For the most expensive models a single
 * long agentic turn can cost tens of dollars, so a copy/paste round-trip
 * via the user's own subscription is usually the better choice.
 *
 * Currently flagged: OpenAI's "-pro" variants (gpt5pro, gpt52pro, gpt55pro)
 * — input ≥ $15/M, output ≥ $120/M. The rule is name-based rather than
 * price-based so that future flagship Pro releases stay covered without a
 * threshold tweak, and so that other vendors' priciest reasoning models
 * (which cost much less per token) aren't lumped in.
 */

/** Hint string prepended to the model tooltip when the model qualifies. */
export const EXPENSIVE_MODEL_HINT =
  '💸 Premium API pricing — consider the External Inquiry tool to use your own ChatGPT/Claude subscription instead';

interface ExpensivePredicateInput {
  readonly provider: string;
  readonly name: string;
}

/** Returns true when API use of the model is expensive enough to warn about. */
export function isExpensiveModel(config: ExpensivePredicateInput): boolean {
  return config.provider === 'openai' && config.name.endsWith('pro');
}
