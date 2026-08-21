import { MODEL_CONFIGS, type ModelConfig } from 'llm-zoo';

import type { ApiProvider } from '@model/apiProviders';
import { withDeepSeekVisionOverride } from '@model/deepSeekVisionOverride';
import { resolveModelApiKeyProvider } from '@model/openRouterRouting';
import { zeroCostAccessOverrides } from '@model/subscriptionAccessOverrides';
import { platform } from '@platform/platform';
import type {
  LanguageModelAccessState,
  LanguageModelInfo,
  LanguageModelReference,
} from '@platform/languageModel';

const MODEL_ACCESS_REQUEST_TIMEOUT_MS = 120_000;
const MODEL_ACCESS_DISCOVERY_ATTEMPTS = 2;

/**
 * The Copilot access route for one canonical base model: the exact editor
 * model reference requests must use, plus the access state the editor last
 * reported. Keyed by base model id in the catalogue — Copilot is a transport
 * for the logical model, never a separate model identity (#9635).
 */
export interface CopilotModelRoute {
  readonly access: LanguageModelAccessState;
  readonly reference: LanguageModelReference;
  /** Base config with the editor's context ceiling and subscription pricing. */
  readonly effectiveConfig: ModelConfig;
}

interface RuntimeModelDirectFallback {
  readonly model: string;
  readonly provider: ApiProvider;
  readonly chatGptSubscriptionEligible: boolean;
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
  /** The in-flight discovery, if one is running. */
  readonly pending?: Promise<RefreshRuntimeModelRegistryResult>;
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

async function discoverCopilotRoutes(): Promise<
  Map<string, CopilotModelRoute>
> {
  const languageModel = platform().languageModel;
  if (!languageModel.isAvailable()) return new Map();

  const discovered = await languageModel.selectModels({ vendor: 'copilot' });
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
}

interface RefreshRuntimeModelRegistryOptions {
  /** Re-query the adapter even when the current catalogue is marked fresh. */
  forceDiscovery?: boolean;
}

type RefreshRuntimeModelRegistryResult = 'current' | 'superseded';

/** Refresh editor-supplied routes after the native model/access cache changes. */
export async function refreshRuntimeModelRegistry(
  options: RefreshRuntimeModelRegistryOptions = {},
): Promise<RefreshRuntimeModelRegistryResult> {
  if (options.forceDiscovery) {
    // Overlapping user actions share one forced probe. A normal probe that
    // started earlier is superseded because its access snapshot may predate
    // the action that must authorize persistence.
    if (catalogue.pendingForceDiscovery && catalogue.pending) {
      return catalogue.pending;
    }
    invalidateRuntimeModelRegistry();
  }
  if (catalogue.discovered) return 'current';
  if (catalogue.pending) return catalogue.pending;

  // Both outcomes below replace the catalogue wholesale, which is also what
  // clears `pending`; a result whose generation has moved on was superseded by
  // an invalidation and is dropped instead of committed.
  const { generation, entries: previousEntries } = catalogue;
  const request = (async (): Promise<RefreshRuntimeModelRegistryResult> => {
    const entries = await discoverCopilotRoutes();
    if (catalogue.generation !== generation) return 'superseded';
    catalogue = { generation, entries, discovered: true };
    return 'current';
  })();
  catalogue = {
    ...catalogue,
    pending: request,
    pendingForceDiscovery: options.forceDiscovery === true,
  };
  try {
    return await request;
  } catch (error) {
    if (catalogue.generation === generation) {
      catalogue = {
        generation,
        // Discovery failure marks last-known presentation stale but does not
        // blank it. Authorization callers still receive the thrown error and
        // therefore cannot act on these retained entries.
        entries: previousEntries,
        discovered: false,
      };
    }
    throw error;
  }
}

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
  const config = MODEL_CONFIGS[model];
  return config && withDeepSeekVisionOverride(config);
}

/** Resolve a persisted model id to its user-facing registry label. */
export function getRuntimeModelLabel(model: string): string {
  return getRuntimeModelConfig(model)?.label ?? model;
}

/** All static model entries owned by TeXRA and llm-zoo. */
export function staticModelConfigEntries(): readonly (readonly [
  string,
  ModelConfig,
])[] {
  return Object.entries(MODEL_CONFIGS).map(
    ([id, config]) => [id, withDeepSeekVisionOverride(config)] as const,
  );
}

/**
 * Resolve a persisted model id to its static config after ensuring native
 * discovery has run in this host, so a Copilot route preference decided from
 * the result routes on a fresh catalogue.
 */
export async function resolveRuntimeModelConfig(
  model: string,
): Promise<ModelConfig | undefined> {
  await discoveredCopilotRoutes();
  return getRuntimeModelConfig(model);
}

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
export async function discoveredCopilotRoutes(): Promise<
  ReadonlyMap<string, CopilotModelRoute>
> {
  try {
    await refreshRuntimeModelRegistry();
  } catch {
    // Tolerated: presentation keeps the retained last-known catalogue.
  }
  return catalogue.entries;
}

/** Direct-key route for a model the editor was serving through Copilot. */
export function getRuntimeModelDirectFallback(
  model: string,
  useOpenRouter: boolean,
): RuntimeModelDirectFallback | undefined {
  const config = MODEL_CONFIGS[model];
  if (!config) return undefined;
  const provider = resolveModelApiKeyProvider(config, useOpenRouter);
  return provider
    ? {
        model,
        provider,
        chatGptSubscriptionEligible: Boolean(config.codexSubscription),
      }
    : undefined;
}

type RuntimeModelAccessRequestResult =
  'already-allowed' | 'requested' | 'unavailable';

/**
 * Ask the editor for access to one discovered model. Call only from a direct
 * user action: VS Code permits the first consent-producing request only there.
 */
export async function requestRuntimeModelAccess(
  model: string,
): Promise<RuntimeModelAccessRequestResult> {
  let refreshResult: RefreshRuntimeModelRegistryResult = 'superseded';
  for (
    let attempt = 0;
    attempt < MODEL_ACCESS_DISCOVERY_ATTEMPTS && refreshResult === 'superseded';
    attempt += 1
  ) {
    refreshResult = await refreshRuntimeModelRegistry({ forceDiscovery: true });
  }
  // Repeated native invalidations must fail closed rather than authorize from
  // the retained last-known catalogue.
  if (refreshResult === 'superseded') return 'unavailable';

  const route = catalogue.entries.get(model);
  if (!route) return 'unavailable';
  if (route.access === 'allowed') return 'already-allowed';
  if (route.access === 'unavailable') return 'unavailable';

  const signal = AbortSignal.timeout(MODEL_ACCESS_REQUEST_TIMEOUT_MS);
  for await (const _part of platform().languageModel.sendRequest(
    route.reference,
    [
      {
        role: 'user',
        content: [
          {
            kind: 'text',
            text: 'Reply with OK to confirm language-model access for TeXRA.',
          },
        ],
      },
    ],
    { justification: 'Use Copilot models in TeXRA.' },
    signal,
  )) {
    // The response is intentionally discarded; this request exists to let the
    // editor present its native consent prompt after the user clicks Grant.
  }
  return 'requested';
}
