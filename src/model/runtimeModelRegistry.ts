import { Deferred, Effect } from 'effect';
import { MODEL_CONFIGS, type ModelConfig } from 'llm-zoo';

import type { ApiProvider } from '@model/apiProviders';
import {
  resolveDirectModelApiKeyProvider,
  shouldRouteModelThroughOpenRouter,
} from '@model/openRouterRouting';
import { zeroCostAccessOverrides } from '@model/subscriptionAccessOverrides';
import {
  LanguageModel,
  type LanguageModelAccessState,
  type LanguageModelInfo,
  type LanguageModelReference,
} from '@platform/languageModel';

/**
 * The Copilot access route for one canonical base model: the exact editor
 * model reference requests must use, plus the access state the editor last
 * reported. Keyed by base model id in the catalogue — Copilot is a transport
 * for the logical model, never a separate model identity (#9635).
 */
export interface CopilotModelRoute {
  readonly access: LanguageModelAccessState;
  readonly reference: LanguageModelReference;
  /** Exact editor version observed during this catalogue discovery. */
  readonly version: string;
  /** Base config with the editor's context ceiling and subscription pricing. */
  readonly effectiveConfig: ModelConfig;
}

interface RuntimeModelDirectFallback {
  readonly model: string;
  readonly provider: ApiProvider;
}

/**
 * The registry's entire state as one value, replaced atomically on every
 * transition. Keeping the generation, the entries, their freshness, and the
 * in-flight discovery in one record is what makes a torn state unreachable:
 * a discovery can only commit into the generation it started from, so an
 * invalidation that lands mid-flight cannot leave the entries of one
 * generation flagged fresh under another.
 */
interface RuntimeModelCatalogue {
  /** Bumped by every invalidation; a discovery commits only into its own. */
  readonly generation: number;
  /**
   * Last-known discovered routes. Retained across invalidation so synchronous
   * readers keep answering while the next discovery runs.
   */
  readonly entries: ReadonlyMap<string, CopilotModelRoute>;
  /** Whether {@link entries} reflect a discovery that is still current. */
  readonly discovered: boolean;
  /** The in-flight discovery's shared answer, if one is running. */
  readonly pending?: Deferred.Deferred<
    RefreshRuntimeModelRegistryResult,
    Error
  >;
  /** Whether the in-flight discovery explicitly bypasses a fresh cache. */
  readonly pendingForceDiscovery?: boolean;
}

let catalogue: RuntimeModelCatalogue = {
  generation: 0,
  entries: new Map(),
  discovered: false,
};

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

const discoverCopilotRoutes = Effect.fn(
  'runtimeModelRegistry.discoverCopilotRoutes',
)(function* () {
  const languageModel = yield* LanguageModel;
  if (!languageModel.isAvailable()) return new Map<string, CopilotModelRoute>();

  // The port's own failure travels on unchanged, so a caller waiting on this
  // discovery sees the error the host raised, not a wrapped one.
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

interface RefreshRuntimeModelRegistryOptions {
  /** Re-query the adapter even when the current catalogue is marked fresh. */
  forceDiscovery?: boolean;
}

type RefreshRuntimeModelRegistryResult = 'current' | 'superseded';

/**
 * Refresh editor-supplied routes after the native model/access cache changes.
 *
 * The discovery runs on a detached fiber and every concurrent caller waits on
 * the same `Deferred`, so one caller's interruption cancels only its own wait
 * — what the shared promise this replaced did by construction. The claim and
 * the fork run under one uninterruptible mask: an interrupt landing between
 * registering the deferred and starting the fiber that settles it would
 * otherwise leave every later caller waiting on an answer nothing completes
 * (the `resolveApiKey` shape in `@model/apiProviders`).
 */
export const refreshRuntimeModelRegistry = Effect.fn(
  'runtimeModelRegistry.refreshRuntimeModelRegistry',
)(function* (
  options: RefreshRuntimeModelRegistryOptions = {},
): Effect.fn.Return<RefreshRuntimeModelRegistryResult, Error, LanguageModel> {
  if (options.forceDiscovery) {
    // Overlapping user actions share one forced probe. A normal probe that
    // started earlier is superseded because its access snapshot may predate
    // the action that must authorize persistence.
    if (catalogue.pendingForceDiscovery && catalogue.pending) {
      return yield* Deferred.await(catalogue.pending);
    }
    invalidateRuntimeModelRegistry();
  }
  if (catalogue.discovered) return 'current';
  if (catalogue.pending) return yield* Deferred.await(catalogue.pending);

  return yield* Effect.uninterruptibleMask((restore) => {
    // Both outcomes below replace the catalogue wholesale, which is also what
    // clears `pending`; a result whose generation has moved on was superseded
    // by an invalidation and is dropped instead of committed.
    const { generation, entries: previousEntries } = catalogue;
    const pending = Deferred.makeUnsafe<
      RefreshRuntimeModelRegistryResult,
      Error
    >();
    catalogue = {
      ...catalogue,
      pending,
      pendingForceDiscovery: options.forceDiscovery === true,
    };
    return Effect.flatMap(
      Effect.forkDetach(
        discoverCopilotRoutes().pipe(
          Effect.flatMap((entries) =>
            Effect.sync((): RefreshRuntimeModelRegistryResult => {
              if (catalogue.generation !== generation) return 'superseded';
              catalogue = { generation, entries, discovered: true };
              return 'current';
            }),
          ),
          Effect.tapError(() =>
            Effect.sync(() => {
              if (catalogue.generation === generation) {
                catalogue = {
                  generation,
                  // Discovery failure marks last-known presentation stale but
                  // does not blank it. Authorization callers still receive the
                  // failure and therefore cannot act on these retained
                  // entries.
                  entries: previousEntries,
                  discovered: false,
                };
              }
            }),
          ),
          Effect.onExit((exit) =>
            Effect.sync(() => Deferred.doneUnsafe(pending, exit)),
          ),
        ),
      ),
      () => restore(Deferred.await(pending)),
    );
  });
});

/** Mark discovery stale while retaining last-known routes for sync readers. */
export function invalidateRuntimeModelRegistry(): void {
  catalogue = {
    generation: catalogue.generation + 1,
    entries: catalogue.entries,
    discovered: false,
  };
}

/** Resolve a static model config by its persisted id. */
export function getRuntimeModelConfig(model: string): ModelConfig | undefined {
  return MODEL_CONFIGS[model];
}

/**
 * Resolve a persisted model id to its static config after ensuring native
 * discovery has run in this host, so a Copilot route preference decided from
 * the result routes on a fresh catalogue.
 */
export const resolveRuntimeModelConfig = Effect.fn(
  'runtimeModelRegistry.resolveRuntimeModelConfig',
)(function* (model: string) {
  yield* discoveredCopilotRoutes();
  return getRuntimeModelConfig(model);
});

/** The Copilot route discovered for a canonical base model id, if any. */
export function copilotRouteForModel(
  model: string,
): CopilotModelRoute | undefined {
  return catalogue.entries.get(model);
}

/**
 * Refresh and return the discovered Copilot routes keyed by canonical base
 * model id. Runtime discovery is an optional host capability: the host
 * adapter logs port-level discovery failures (see `createLanguageModelPort`),
 * and presentation consumers retain the last-known catalogue while it is
 * stale. Authorization never uses this fallback: access requests force a new
 * probe and propagate its failure.
 */
export const discoveredCopilotRoutes = Effect.fn(
  'runtimeModelRegistry.discoveredCopilotRoutes',
)(function* () {
  yield* refreshRuntimeModelRegistry().pipe(
    // Tolerated: presentation keeps the retained last-known catalogue.
    Effect.catch(() => Effect.void),
  );
  return catalogue.entries;
});

/** Direct-key route for a model the editor was serving through Copilot. */
export function getRuntimeModelDirectFallback(
  model: string,
  useOpenRouter: boolean,
): RuntimeModelDirectFallback | undefined {
  const config = MODEL_CONFIGS[model];
  if (!config) return undefined;
  const provider = shouldRouteModelThroughOpenRouter(config, useOpenRouter)
    ? 'openRouter'
    : resolveDirectModelApiKeyProvider(config);
  return provider ? { model, provider } : undefined;
}
