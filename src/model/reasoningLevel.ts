import {
  ModelProvider,
  ReasoningEffort,
  type ModelCapabilities,
  type ModelConfig,
} from 'llm-zoo';

import { type ReasoningLevel, ReasoningLevelSchema } from '@shared/schemas';

/** User-facing persisted reasoning levels mapped to llm-zoo effort tiers. */
export const LEVEL_TO_EFFORT: Readonly<Record<string, ReasoningEffort>> = {
  none: ReasoningEffort.NONE,
  low: ReasoningEffort.LOW,
  medium: ReasoningEffort.MEDIUM,
  high: ReasoningEffort.HIGH,
  xhigh: ReasoningEffort.XHIGH,
  max: ReasoningEffort.MAX,
};

const EFFORT_TO_LEVEL = new Map<ReasoningEffort, ReasoningLevel>(
  Object.entries(LEVEL_TO_EFFORT).map(
    ([level, effort]) => [effort, level as ReasoningLevel] as const,
  ),
);

/** Whether the model exposes a genuine user-selectable effort range. */
function hasConfigurableReasoningEffort(
  capabilities: ModelCapabilities,
): boolean {
  if (!capabilities.supportsReasoningEffort) return false;
  if (capabilities.supportedReasoningEfforts?.length) return true;
  return !(
    capabilities.reasoningEffort === ReasoningEffort.MAX &&
    capabilities.maxReasoningEffort === undefined
  );
}

/** Whether the model exposes a user-selectable reasoning level. */
export function supportsReasoningLevel(
  config: Pick<ModelConfig, 'provider' | 'capabilities'>,
): boolean {
  return (
    hasConfigurableReasoningEffort(config.capabilities) ||
    (config.provider === ModelProvider.DEEPSEEK &&
      config.capabilities.supportsReasoning)
  );
}

export type ReasoningLevelResolution =
  | {
      readonly kind: 'configurable';
      readonly defaultLevel?: ReasoningLevel;
      readonly overrideLevel?: ReasoningLevel;
    }
  | {
      readonly kind: 'fixed';
      readonly level: ReasoningLevel;
    };

/** Resolve persisted and declared reasoning levels without presentation copy. */
export function resolveReasoningLevel(
  config: Pick<ModelConfig, 'provider' | 'capabilities'>,
  override?: string,
): ReasoningLevelResolution | undefined {
  const declaredLevel = EFFORT_TO_LEVEL.get(
    config.capabilities.reasoningEffort,
  );

  if (supportsReasoningLevel(config)) {
    const parsed = ReasoningLevelSchema.safeParse(override);
    return {
      kind: 'configurable',
      ...(declaredLevel === undefined ? {} : { defaultLevel: declaredLevel }),
      ...(parsed.success ? { overrideLevel: parsed.data } : {}),
    };
  }

  if (
    config.capabilities.supportsReasoning &&
    declaredLevel !== undefined &&
    declaredLevel !== 'none'
  ) {
    return { kind: 'fixed', level: declaredLevel };
  }

  return undefined;
}
