import {
  ModelProvider,
  ReasoningEffort,
  type ModelCapabilities,
  type ModelConfig,
} from 'llm-zoo';
import { ReasoningEffortSchema } from 'llm-zoo/schemas';

import type { StateStore } from '@platform/interfaces';
import { GlobalStateKey } from '@shared/state/stateKeys';

import { warnModelAvailability } from './modelAvailabilityWarning';

/**
 * The user's per-model reasoning effort overrides, in llm-zoo's vocabulary.
 *
 * This is the one boundary between the persisted `texra.reasoningLevels`
 * record and the runtime: the stored strings are parsed here, so no caller
 * carries a bare string and an entry that is not an effort is reported rather
 * than quietly disappearing. Reads only; the write path keeps the stored
 * record verbatim so an unreadable entry is never dropped from storage.
 */
export function reasoningEffortOverrides(
  state: StateStore,
): Readonly<Record<string, ReasoningEffort>> {
  const stored = state.get<Record<string, string>>(
    GlobalStateKey.REASONING_LEVELS,
    {},
  );
  const overrides: Record<string, ReasoningEffort> = {};
  for (const [model, value] of Object.entries(stored)) {
    const parsed = ReasoningEffortSchema.safeParse(value);
    if (parsed.success) {
      overrides[model] = parsed.data;
      continue;
    }
    // A stored value outside llm-zoo's vocabulary cannot route a request, so
    // the model falls back to its catalog default; say so through the
    // module's host sink rather than dropping the entry silently.
    warnModelAvailability(
      `Stored reasoning level "${value}" for model ${model} is not one of llm-zoo's efforts; using the model's default.`,
      parsed.error,
    );
  }
  return overrides;
}

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
 * definition behind both the model binding and the model choices, so the controls and the runtime share the same definition.
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
