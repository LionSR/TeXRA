import {
  ModelProvider,
  ReasoningEffort,
  type ModelCapabilities,
  type ModelConfig,
} from 'llm-zoo';

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
 * model choices, so the controls and the runtime share the same definition.
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
