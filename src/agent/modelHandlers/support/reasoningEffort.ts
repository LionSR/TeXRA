import {
  ModelProvider,
  ReasoningEffort,
  type ModelCapabilities,
  type ModelConfig,
} from 'llm-zoo';

import type { ReasoningEffort as OpenAIReasoningEffort } from 'openai/resources/shared';

/**
 * Single source of truth: user-facing reasoning level strings -> ReasoningEffort enum.
 * The reverse mapping for settings UI controls is derived from this record.
 */
export const LEVEL_TO_EFFORT: Readonly<Record<string, ReasoningEffort>> = {
  none: ReasoningEffort.NONE,
  minimal: ReasoningEffort.MINIMAL,
  low: ReasoningEffort.LOW,
  medium: ReasoningEffort.MEDIUM,
  high: ReasoningEffort.HIGH,
  xhigh: ReasoningEffort.XHIGH,
  max: ReasoningEffort.MAX,
};

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

/** Whether the model exposes a genuine user-selectable effort range. */
function hasConfigurableReasoningEffort(
  capabilities: ModelCapabilities,
): boolean {
  if (!capabilities.supportsReasoningEffort) return false;

  const exactEfforts = capabilities.supportedReasoningEfforts;
  if (exactEfforts?.length) {
    return new Set(exactEfforts).size > 1;
  }

  return !(
    capabilities.reasoningEffort === ReasoningEffort.MAX &&
    capabilities.maxReasoningEffort === undefined
  );
}

/**
 * Whether the model exposes a user-selectable reasoning level. This is the one
 * definition behind both the handler getter (`ModelHandler
 * .supportsReasoningLevelOverride`, read on every handler construction) and the
 * Settings Models rows, so the control and the runtime can never disagree.
 *
 * DeepSeek is the extra term: its models declare `supportsReasoning` without a
 * configurable effort range, yet still honour a level override.
 */
export function supportsReasoningLevel(
  config: Pick<ModelConfig, 'provider' | 'capabilities'>,
): boolean {
  return (
    hasConfigurableReasoningEffort(config.capabilities) ||
    (config.provider === ModelProvider.DEEPSEEK &&
      config.capabilities.supportsReasoning)
  );
}

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
