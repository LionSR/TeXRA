import { Effect } from 'effect';
import { MODEL_CONFIGS, type ModelConfig } from 'llm-zoo';
/**
 * Copilot routing: the per-model preference for serving a canonical base
 * model through the editor's GitHub Copilot language-model access instead of
 * a provider key, OpenRouter, or a subscription, and the route the editor
 * offers for it.
 *
 * The preference is persisted state. The route is never stored: the editor's
 * language-model port is its authority, so each route decision discovers it
 * once ({@link discoverCopilotRoutes}) and carries the discovered route on the
 * `ModelRoute` it decides.
 */

import type { ApiProvider } from '@model/apiProviders';
import { decideModelRoute, OWN_KEY_ROUTE_FACTS } from '@model/modelRoute';
import { zeroCostAccessOverrides } from '@model/subscriptionAccessOverrides';
import { type StateStore, withStateKeyLane } from '@platform/interfaces';
import {
  LanguageModel,
  type LanguageModelAccessState,
  type LanguageModelInfo,
  type LanguageModelReference,
} from '@platform/languageModel';
import { GlobalStateKey } from '@shared/state/stateKeys';

import { isDeprecatedModel, isRetiredModel } from './modelOptionsBasic';

/**
 * The Copilot access route for one canonical base model: the exact editor
 * model reference requests must use, plus the access state the editor
 * reported. Keyed by base model id: Copilot is a transport for the logical
 * model, never a separate model identity (#9635).
 */
export interface CopilotModelRoute {
  readonly access: LanguageModelAccessState;
  readonly reference: LanguageModelReference;
  /** Exact editor version observed during this discovery. */
  readonly version: string;
  /** Base config with the editor's context ceiling and subscription pricing. */
  readonly effectiveConfig: ModelConfig;
}

function modelRouteNames(config: ModelConfig): readonly string[] {
  return [config.copilotFullName, config.vscodeLMFullName].filter(
    (name): name is string => Boolean(name),
  );
}

function matchingBaseModel(info: LanguageModelInfo): string | undefined {
  const nativeNames = new Set(
    [info.id, info.family].map((name) => name.trim().toLowerCase()),
  );
  return Object.entries(MODEL_CONFIGS)
    .filter(
      ([, config]) =>
        !config.retired &&
        !config.deprecated &&
        modelRouteNames(config).some((name) =>
          nativeNames.has(name.trim().toLowerCase()),
        ),
    )
    .toSorted(([, left], [, right]) => {
      const byReasoning =
        Number(left.capabilities.supportsReasoning) -
        Number(right.capabilities.supportsReasoning);
      return byReasoning || left.name.localeCompare(right.name);
    })
    .at(0)?.[0];
}

/**
 * The Copilot routes the editor offers now, keyed by canonical base model id.
 * A host without a language-model port offers none. The port's own failure
 * travels on unchanged (the port has already logged it at `warn`), so a run
 * that needs a route fails with the error the host raised.
 */
export const discoverCopilotRoutes = Effect.fn(
  'copilotRouting.discoverCopilotRoutes',
)(function* (): Effect.fn.Return<
  ReadonlyMap<string, CopilotModelRoute>,
  Error,
  LanguageModel
> {
  const languageModel = yield* LanguageModel;
  if (!languageModel.isAvailable()) return new Map<string, CopilotModelRoute>();

  const discovered = yield* languageModel.selectModels({ vendor: 'copilot' });
  const entries = new Map<string, CopilotModelRoute>();
  for (const info of discovered.toSorted((left, right) =>
    right.version.localeCompare(left.version),
  )) {
    const baseModel = matchingBaseModel(info);
    if (!baseModel || entries.has(baseModel)) continue;
    entries.set(baseModel, {
      access: info.access,
      reference: {
        vendor: info.vendor,
        id: info.id,
      },
      version: info.version,
      effectiveConfig: {
        ...MODEL_CONFIGS[baseModel],
        ...zeroCostAccessOverrides(info.maxInputTokens),
        capabilities: {
          ...MODEL_CONFIGS[baseModel].capabilities,
          // VS Code's LM route chooses the model's own reasoning behavior and
          // exposes no per-request effort control.
          supportsReasoningEffort: false,
          maxReasoningEffort: undefined,
          supportedReasoningEfforts: undefined,
        },
      },
    });
  }
  return entries;
});

/**
 * Persisted canonical model ids whose Copilot route the user prefers, read
 * from the process global state the caller holds (the `AppState` service, or
 * the store a host root threaded down). Settings needs the raw list so a model
 * the editor no longer discovers still surfaces its undo (#9659).
 *
 * Copilot discovery never matches a retired or deprecated base model, so a
 * preference for one could never resolve to a route; it drops out at read.
 */
export function preferredCopilotRouteModels(state: Pick<StateStore, 'get'>) {
  return Effect.gen(function* () {
    return (yield* state.get<readonly string[]>(
      GlobalStateKey.COPILOT_ROUTE_MODELS,
      [],
    )).filter((model) => !isRetiredModel(model) && !isDeprecatedModel(model));
  });
}

/** Whether the user prefers the Copilot route for this canonical base model. */
export function prefersCopilotRoute(
  model: string,
  state: Pick<StateStore, 'get'>,
) {
  return Effect.gen(function* () {
    return (yield* preferredCopilotRouteModels(state)).includes(model);
  });
}

/** Persist (or clear) the Copilot route preference for one base model. */
export function setCopilotRoutePreference(
  model: string,
  preferred: boolean,
  state: StateStore,
) {
  return Effect.gen(function* () {
    const current = yield* preferredCopilotRouteModels(state);
    const next = preferred
      ? [...new Set([...current, model])]
      : current.filter((entry) => entry !== model);
    return yield* state.update(GlobalStateKey.COPILOT_ROUTE_MODELS, next);
  }).pipe(withStateKeyLane(state, GlobalStateKey.COPILOT_ROUTE_MODELS));
}

/**
 * Why a model decided onto the Copilot route cannot be served through it with
 * the route discovered for it, or undefined when it can. The preference is a
 * hard route choice (#9635): handler routing reports this reason and never
 * falls through to a provider key, OpenRouter, or a subscription the user did
 * not choose for this model.
 */
export function copilotRouteUnavailableReason(
  model: string,
  route: CopilotModelRoute | undefined,
): string | undefined {
  const access = route?.access;
  switch (access) {
    case 'allowed':
      return undefined;
    case 'consent-required':
      return `Copilot access to "${model}" needs your approval in VS Code. Grant it from Settings → Models, or stop using Copilot for this model.`;
    case 'unavailable':
      return `Copilot access to "${model}" is temporarily unavailable in VS Code.`;
    // No discovered route means Copilot cannot serve the model right now.
    case undefined:
      return `VS Code does not currently offer "${model}" through Copilot.`;
    default:
      return access satisfies never;
  }
}

interface CopilotDirectFallback {
  readonly model: string;
  readonly provider: ApiProvider;
}

/** Direct-key route for a model the editor was serving through Copilot. */
export function getRuntimeModelDirectFallback(
  model: string,
  useOpenRouter: boolean,
): CopilotDirectFallback | undefined {
  const config = MODEL_CONFIGS[model];
  if (!config) return undefined;
  // The replacement run declines every subscription route and Copilot.
  const route = decideModelRoute(config, {
    ...OWN_KEY_ROUTE_FACTS,
    useOpenRouter,
  });
  if (route.kind === 'openrouter') return { model, provider: 'openRouter' };
  return route.kind === 'api-key'
    ? { model, provider: route.provider }
    : undefined;
}
