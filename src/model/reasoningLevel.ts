import { Effect } from 'effect';
import { z } from 'zod';
import { ReasoningEffort, type ModelConfig } from 'llm-zoo';

import { ReasoningEffortSchema } from 'llm-zoo/schemas';

import type { StateStore } from '@platform/interfaces';
import { REASONING_LEVEL_LABELS } from '@shared/settingsView/settingsViewMessages';
import { readState } from '@shared/config/settingsAccess';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { ensureError } from '@utils/errors/errorMessage';
import {
  chooseReasoning,
  defaultReasoningLevel,
  type ReasoningRequest,
} from './reasoningChoice';

/**
 * The user's per-model reasoning effort overrides, in llm-zoo's vocabulary,
 * keyed by model reference (`provider/id`).
 *
 * This is the one boundary between the persisted `texra.reasoningLevels`
 * record and the runtime: the stored strings are parsed here, so no caller
 * carries a bare string and an entry that is not an effort is reported rather
 * than quietly disappearing. Reads only; the write path keeps the stored
 * record verbatim so an unreadable entry is never dropped from storage.
 */
export function reasoningEffortOverrides(state: StateStore) {
  return Effect.gen(function* () {
    const stored = yield* readState(
      state,
      GlobalStateKey.REASONING_LEVELS,
      z.record(z.string(), z.unknown()).prefault({}),
    );
    const overrides: Record<string, ReasoningEffort> = {};
    for (const [model, value] of Object.entries(stored)) {
      const parsed = ReasoningEffortSchema.safeParse(value);
      if (parsed.success) {
        overrides[model] = parsed.data;
        continue;
      }
      // A stored value outside llm-zoo's vocabulary cannot route a request, so
      // the model falls back to its catalog default; say so rather than
      // dropping the entry silently.
      yield* Effect.logWarning(
        `Stored reasoning level ${JSON.stringify(value)} for model ${model} is not one of llm-zoo's efforts; using the model's default.`,
        parsed.error,
      );
    }
    return overrides;
  });
}

/**
 * The levels a user can pick for a model: `none` where thinking can be turned
 * off, then the levels it accepts while thinking. Empty or single-valued means
 * there is nothing to choose.
 */
export function selectableReasoningLevels(
  config: Pick<ModelConfig, 'reasoning'>,
): ReasoningEffort[] {
  const { reasoning } = config;
  if (reasoning === undefined) return [];
  return [
    ...(reasoning.off === undefined ? [] : [ReasoningEffort.NONE]),
    ...reasoning.efforts,
  ];
}

/**
 * Whether the model exposes a user-selectable reasoning level. This is the one
 * definition behind both the model binding and the model choices.
 */
export function supportsReasoningLevel(
  config: Pick<ModelConfig, 'reasoning'>,
): boolean {
  return selectableReasoningLevels(config).length > 1;
}

/**
 * The run's reasoning decision: the model string's own request, else the
 * user's saved level for the model, else the default; a route ceiling (the
 * Codex subscription backend) narrows the levels. A level the model lacks is
 * substituted and logged; a request it cannot run fails the bind.
 */
export const reasoningFor = Effect.fn('reasoningFor')(function* (
  config: ModelConfig,
  request: ReasoningRequest,
  globalState: StateStore,
  routeEfforts?: readonly ReasoningEffort[],
) {
  const userEffort = (yield* reasoningEffortOverrides(globalState))[config.ref];
  const choice = yield* Effect.try({
    try: () => chooseReasoning(config, request, { userEffort, routeEfforts }),
    catch: ensureError,
  });
  if (choice.note !== undefined) yield* Effect.logInfo(choice.note);
  return choice;
});

/**
 * The reasoning column of a model row: the user's saved level, else the
 * default a run uses; `(fixed)` where the model offers no choice; nothing for
 * a model that never thinks.
 */
export function reasoningLevelLabel(
  config: Pick<ModelConfig, 'label' | 'reasoning' | 'modes'>,
  saved: ReasoningEffort | undefined,
): string | undefined {
  if (config.reasoning === undefined) return undefined;
  const fallback = defaultReasoningLevel(config);
  if (fallback === undefined) return 'Default';
  const defaultLevel = REASONING_LEVEL_LABELS[fallback];
  if (!supportsReasoningLevel(config)) return `${defaultLevel} (fixed)`;
  return saved === undefined
    ? `Default (${defaultLevel})`
    : REASONING_LEVEL_LABELS[saved];
}
