import { ReasoningEffort, type ModelCapabilities } from 'llm-zoo';

import type { ReasoningEffort as OpenAIReasoningEffort } from 'openai/resources/shared';

const REASONING_EFFORT_ORDER: readonly ReasoningEffort[] = [
  ReasoningEffort.NONE,
  ReasoningEffort.MINIMAL,
  ReasoningEffort.LOW,
  ReasoningEffort.MEDIUM,
  ReasoningEffort.HIGH,
  ReasoningEffort.XHIGH,
  ReasoningEffort.MAX,
];

/** Clamp an effort to the nearest tier in a model's exact declared vocabulary. */
export function normalizeSupportedReasoningEffort(
  effort: string,
  supported: readonly ReasoningEffort[] | undefined,
  fallback: ReasoningEffort,
): ReasoningEffort {
  if (!supported?.length) return fallback;
  if (supported.includes(effort as ReasoningEffort)) {
    return effort as ReasoningEffort;
  }

  const requestedIndex = REASONING_EFFORT_ORDER.indexOf(
    effort as ReasoningEffort,
  );
  if (requestedIndex < 0) return fallback;

  return supported.reduce((nearest, candidate) => {
    const nearestIndex = REASONING_EFFORT_ORDER.indexOf(nearest);
    const candidateIndex = REASONING_EFFORT_ORDER.indexOf(candidate);
    const nearestDistance = Math.abs(nearestIndex - requestedIndex);
    const candidateDistance = Math.abs(candidateIndex - requestedIndex);
    return candidateDistance < nearestDistance ||
      (candidateDistance === nearestDistance && candidateIndex > nearestIndex)
      ? candidate
      : nearest;
  });
}

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
    case ReasoningEffort.MINIMAL:
      return 'minimal';
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
 * surface accepts only 'high' and 'max' (DeepSeek). Their compatibility
 * layer maps the below-high tiers (none/low/medium) up to the 'high' floor and
 * the above-high tiers (xhigh, max) to 'max'; reproduce that explicitly so an
 * out-of-vocabulary value never leaks to the API.
 */
export function clampReasoningEffortToHighOrMax(
  effort: string,
): ReasoningEffort.HIGH | ReasoningEffort.MAX {
  return effort === ReasoningEffort.XHIGH || effort === ReasoningEffort.MAX
    ? ReasoningEffort.MAX
    : ReasoningEffort.HIGH;
}
