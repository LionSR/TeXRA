import { Effect } from 'effect';
import { z } from 'zod';
import { ModelProvider, ReasoningEffort, type ModelConfig } from 'llm-zoo';

import { ReasoningEffortSchema } from 'llm-zoo/schemas';

import {
  chooseReasoning,
  defaultReasoningLevel,
  type ReasoningRequest,
} from '@texra-ai/llm';
import type { StateStore } from '@platform/interfaces';
import { REASONING_LEVEL_LABELS } from '@shared/settingsView/settingsViewMessages';
import { readState } from '@shared/config/settingsAccess';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { ensureError } from '@utils/errors/errorMessage';

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
 * The Codex subscription backend runs every turn synchronously on one
 * connection, so an effort above medium risks the client timing out before
 * it answers: a route ceiling, applied through the one reasoning policy.
 */
export const CODEX_ROUTE_EFFORTS: readonly ReasoningEffort[] = [
  ReasoningEffort.LOW,
  ReasoningEffort.MEDIUM,
];

/** The route a request is bound on, as far as reasoning is concerned. */
export interface ReasoningRoute {
  readonly protocol: string;
  readonly codexSubscription: boolean;
}

/**
 * The model's reasoning as this route can control it. Gemini's Interactions
 * request and Kimi's Responses request have no switch that turns thinking
 * off; DashScope's has none that turns Qwen's thinking on. The policy then
 * refuses a request the route cannot carry and records what really happens.
 */
function routeReasoning(
  config: ModelConfig,
  route: ReasoningRoute,
): Pick<ModelConfig, 'label' | 'reasoning' | 'modes'> {
  const { reasoning } = config;
  if (reasoning === undefined) return config;
  const responses = route.protocol === 'openai-responses';
  if (responses && config.provider === ModelProvider.DASHSCOPE) {
    return { ...config, reasoning: undefined };
  }
  if (
    route.protocol === 'google-interactions' ||
    (responses && config.provider === ModelProvider.MOONSHOT)
  ) {
    return { ...config, reasoning: { ...reasoning, off: undefined } };
  }
  return config;
}

/**
 * {@link reasoningFor} without logging its substitution note: a check made
 * ahead of the bind (a model switch's admission), which logs it when it runs.
 */
export const decideReasoning = Effect.fn('decideReasoning')(function* (
  config: ModelConfig,
  request: ReasoningRequest,
  globalState: StateStore,
  route: ReasoningRoute,
) {
  const userEffort = (yield* reasoningEffortOverrides(globalState))[config.ref];
  const routeEfforts = route.codexSubscription
    ? CODEX_ROUTE_EFFORTS
    : undefined;
  return yield* Effect.try({
    try: () =>
      chooseReasoning(routeReasoning(config, route), request, {
        userEffort,
        routeEfforts,
      }),
    catch: ensureError,
  });
});

/**
 * The run's reasoning decision: the model string's own request, else the
 * user's saved level for the model, else the default, for the reasoning the
 * route can control; the Codex subscription narrows the levels. A level the
 * model lacks is substituted and logged; a request it cannot run fails the
 * bind.
 */
export const reasoningFor = Effect.fn('reasoningFor')(function* (
  config: ModelConfig,
  request: ReasoningRequest,
  globalState: StateStore,
  route: ReasoningRoute,
) {
  const choice = yield* decideReasoning(config, request, globalState, route);
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
