import { ReasoningEffort } from 'llm-zoo';

/**
 * Single source of truth: user-facing reasoning level strings -> ReasoningEffort enum.
 * The reverse mapping for settings UI controls is derived from this record.
 */
export const LEVEL_TO_EFFORT: Readonly<Record<string, ReasoningEffort>> = {
  none: ReasoningEffort.NONE,
  low: ReasoningEffort.LOW,
  medium: ReasoningEffort.MEDIUM,
  high: ReasoningEffort.HIGH,
  xhigh: ReasoningEffort.XHIGH,
  max: ReasoningEffort.MAX,
};

/** Reasoning-effort vocabulary the OpenAI Chat and Responses APIs accept. */
export type OpenAIReasoningEffort =
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'none';

/**
 * Clamp the internal reasoning-effort enum to the vocabulary the OpenAI Chat
 * and Responses APIs accept (none|minimal|low|medium|high|xhigh). They reject
 * our top 'max' tier — map it to their 'xhigh' ceiling — and reject 'none' for
 * thinking models — clamp it to the 'low' minimum. Everything else passes
 * through unchanged.
 */
export function toOpenAIReasoningEffort(
  effort: ReasoningEffort,
): OpenAIReasoningEffort {
  if (effort === ReasoningEffort.NONE) return 'low';
  if (effort === ReasoningEffort.MAX) return 'xhigh';
  return effort as OpenAIReasoningEffort;
}
