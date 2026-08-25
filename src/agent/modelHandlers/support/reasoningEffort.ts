import { ReasoningEffort, type ModelCapabilities } from 'llm-zoo';

import type { ReasoningEffort as OpenAIReasoningEffort } from 'openai/resources/shared';

type NonNullOpenAIReasoningEffort = Exclude<OpenAIReasoningEffort, null>;

/** Read llm-zoo's declared effort ceiling using its documented fallback. */
export function getDeclaredMaxReasoningEffort(
  capabilities: ModelCapabilities,
): ReasoningEffort {
  return capabilities.maxReasoningEffort ?? capabilities.reasoningEffort;
}

/**
 * Clamp the internal reasoning-effort enum to a value the OpenAI Chat and
 * Responses APIs accept. The internal 'none' tier is rejected by the relevant
 * reasoning models, so clamp it to the 'low' floor. Preserve 'max' only when
 * llm-zoo explicitly declares that native ceiling for the model; otherwise
 * retain the historical 'xhigh' cap.
 */
export function toOpenAIReasoningEffort(
  effort: ReasoningEffort,
  maxReasoningEffort?: ReasoningEffort,
): NonNullOpenAIReasoningEffort {
  switch (effort) {
    case ReasoningEffort.NONE:
    case ReasoningEffort.LOW:
      return 'low';
    case ReasoningEffort.MEDIUM:
      return 'medium';
    case ReasoningEffort.HIGH:
      return 'high';
    case ReasoningEffort.XHIGH:
      return 'xhigh';
    case ReasoningEffort.MAX:
      return maxReasoningEffort === ReasoningEffort.MAX ? 'max' : 'xhigh';
  }
}

/**
 * Clamp an internal reasoning-effort value for providers whose OpenAI-compatible
 * surface accepts only 'high' and 'max' (DeepSeek, GLM). Their compatibility
 * layer maps the below-high tiers (none/low/medium) up to the 'high' floor and
 * the above-high tiers (xhigh, max) to 'max'; reproduce that explicitly so an
 * out-of-vocabulary value never leaks to the API.
 */
export function clampReasoningEffortToHighOrMax(
  effort: string,
): 'high' | 'max' {
  return effort === ReasoningEffort.XHIGH || effort === ReasoningEffort.MAX
    ? 'max'
    : 'high';
}
