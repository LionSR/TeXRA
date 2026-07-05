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

/** The reasoning-effort values this clamp can emit for the OpenAI APIs. */
type OpenAIReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

/**
 * Clamp the internal reasoning-effort enum to a value the OpenAI Chat and
 * Responses APIs accept. Their vocabulary is minimal|low|medium|high|xhigh; our
 * enum additionally has 'none' (which they reject — clamp to the 'low' floor)
 * and 'max' (above their 'xhigh' ceiling — clamp to 'xhigh'). Every other tier
 * passes through unchanged since the enum's string values match the API's.
 */
export function toOpenAIReasoningEffort(
  effort: ReasoningEffort,
): OpenAIReasoningEffort {
  switch (effort) {
    case ReasoningEffort.NONE:
    case ReasoningEffort.LOW:
      return 'low';
    case ReasoningEffort.MEDIUM:
      return 'medium';
    case ReasoningEffort.HIGH:
      return 'high';
    case ReasoningEffort.XHIGH:
    case ReasoningEffort.MAX:
      return 'xhigh';
  }
}
