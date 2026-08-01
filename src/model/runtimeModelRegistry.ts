import {
  DEFAULT_MODEL_CAPABILITIES,
  MODEL_CONFIGS,
  ModelProvider,
  type ModelConfig,
} from 'llm-zoo';

import type { ApiProvider } from '@model/apiProviders';
import { resolveModelApiKeyProvider } from '@model/openRouterRouting';
import { zeroCostAccessOverrides } from '@model/subscriptionAccessOverrides';
import { platform } from '@platform/platform';

import type {
  LanguageModelAccessState,
  LanguageModelInfo,
  LanguageModelReference,
} from '@platform/languageModel';

const COPILOT_MODEL_PREFIX = 'copilot:';
const MODEL_ACCESS_REQUEST_TIMEOUT_MS = 120_000;

interface RuntimeModelEntry {
  readonly config: ModelConfig;
  readonly access: LanguageModelAccessState;
  readonly reference: LanguageModelReference;
  readonly directModel?: string;
}

export interface RuntimeModelDirectFallback {
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
   * Last-known discovered entries. Retained across invalidation so synchronous
   * readers keep answering while the next discovery runs.
   */
  readonly entries: ReadonlyMap<string, RuntimeModelEntry>;
  /** Whether {@link entries} reflect a discovery that is still current. */
  readonly discovered: boolean;
  /** The in-flight discovery, if one is running. */
  readonly pending?: Promise<void>;
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

function matchingBaseModel(
  info: LanguageModelInfo,
): readonly [string, ModelConfig] | undefined {
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
    .at(0);
}

function runtimeModelId(baseModel: string): string {
  return `${COPILOT_MODEL_PREFIX}${baseModel}`;
}

function runtimeConfig(
  id: string,
  base: ModelConfig,
  info: LanguageModelInfo,
): ModelConfig {
  return {
    ...base,
    name: id,
    label: `Copilot · ${info.name || base.label}`,
    fullName: info.id,
    shortName: info.id,
    provider: ModelProvider.COPILOT,
    ...zeroCostAccessOverrides(info.maxInputTokens),
    openRouterOnly: false,
    openrouterFullName: undefined,
    vscodeLMFullName: info.id,
    copilotFullName: info.id,
    codexSubscription: false,
    deprecated: false,
    retired: false,
    capabilities: {
      ...DEFAULT_MODEL_CAPABILITIES,
      supportsFunctionCalling: base.capabilities.supportsFunctionCalling,
      supportsReasoning: base.capabilities.supportsReasoning,
      supportsTokenCounting: true,
      supportsVision: base.capabilities.supportsVision,
      supportsSystemPrompt: false,
    },
  };
}

async function discoverCopilotModels(): Promise<
  Map<string, RuntimeModelEntry>
> {
  const languageModel = platform().languageModel;
  if (!languageModel.isAvailable()) return new Map();

  const discovered = await languageModel.selectModels({ vendor: 'copilot' });
  const entries = new Map<string, RuntimeModelEntry>();
  for (const info of discovered.toSorted((left, right) =>
    right.version.localeCompare(left.version),
  )) {
    const match = matchingBaseModel(info);
    if (!match) continue;
    const [baseModel, baseConfig] = match;
    const id = runtimeModelId(baseModel);
    if (entries.has(id)) continue;
    entries.set(id, {
      config: runtimeConfig(id, baseConfig, info),
      access: info.access,
      reference: {
        vendor: info.vendor,
        id: info.id,
      },
      directModel: baseModel,
    });
  }
  return entries;
}

/** Refresh editor-supplied models after the native model/access cache changes. */
export async function refreshRuntimeModelRegistry(): Promise<void> {
  if (catalogue.discovered) return;
  if (catalogue.pending) return catalogue.pending;

  // Both outcomes below replace the catalogue wholesale, which is also what
  // clears `pending`; a result whose generation has moved on was superseded by
  // an invalidation and is dropped instead of committed.
  const { generation } = catalogue;
  const request = (async () => {
    const entries = await discoverCopilotModels();
    if (catalogue.generation !== generation) return;
    catalogue = { generation, entries, discovered: true };
  })();
  catalogue = { ...catalogue, pending: request };
  try {
    await request;
  } catch (error) {
    if (catalogue.generation === generation) {
      catalogue = { generation, entries: new Map(), discovered: false };
    }
    throw error;
  }
}

/** Mark discovery stale while retaining last-known configs for sync readers. */
export function invalidateRuntimeModelRegistry(): void {
  catalogue = {
    generation: catalogue.generation + 1,
    entries: catalogue.entries,
    discovered: false,
  };
}

/** Resolve a static or editor-discovered model config by its persisted id. */
export function getRuntimeModelConfig(model: string): ModelConfig | undefined {
  return catalogue.entries.get(model)?.config ?? MODEL_CONFIGS[model];
}

/** All static model entries owned by TeXRA and llm-zoo. */
export function staticModelConfigEntries(): readonly (readonly [
  string,
  ModelConfig,
])[] {
  return Object.entries(MODEL_CONFIGS);
}

function discoveredModelConfigEntries(): readonly (readonly [
  string,
  ModelConfig,
])[] {
  return [...catalogue.entries].map(
    ([id, entry]) => [id, entry.config] as const,
  );
}

/** Resolve a model after ensuring native discovery has run in this host. */
export async function resolveRuntimeModelConfig(
  model: string,
): Promise<ModelConfig | undefined> {
  const staticConfig = MODEL_CONFIGS[model];
  if (staticConfig) return staticConfig;

  await refreshRuntimeModelRegistry();
  return catalogue.entries.get(model)?.config;
}

/** Available editor-supplied model ids appended to ordinary visible models. */
export function availableRuntimeModelIds(): readonly string[] {
  return [...catalogue.entries]
    .filter(([, entry]) => entry.access === 'allowed')
    .map(([id]) => id);
}

/** Access state reported by the editor for a discovered runtime model. */
export function runtimeModelAccess(
  model: string,
): LanguageModelAccessState | undefined {
  return catalogue.entries.get(model)?.access;
}

/** Direct-key model represented by an editor-supplied subscription model. */
export function getRuntimeModelDirectFallback(
  model: string,
  useOpenRouter: boolean,
): RuntimeModelDirectFallback | undefined {
  const directModel = catalogue.entries.get(model)?.directModel;
  if (!directModel) return undefined;
  const config = MODEL_CONFIGS[directModel];
  if (!config) return undefined;
  const provider = resolveModelApiKeyProvider(config, useOpenRouter);
  return provider
    ? {
        model: directModel,
        provider,
        chatGptSubscriptionEligible: Boolean(config.codexSubscription),
      }
    : undefined;
}

export type RuntimeModelAccessRequestResult =
  'already-allowed' | 'requested' | 'unavailable';

/**
 * Ask the editor for access to one discovered model. Call only from a direct
 * user action: VS Code permits the first consent-producing request only there.
 */
export async function requestRuntimeModelAccess(
  model: string,
): Promise<RuntimeModelAccessRequestResult> {
  await refreshRuntimeModelRegistry();
  const entry = catalogue.entries.get(model);
  if (!entry) return 'unavailable';
  if (entry.access === 'allowed') return 'already-allowed';
  if (entry.access === 'unavailable') return 'unavailable';

  const signal = AbortSignal.timeout(MODEL_ACCESS_REQUEST_TIMEOUT_MS);
  for await (const _part of platform().languageModel.sendRequest(
    entry.reference,
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

/** Whether an id belongs to the currently discovered editor model catalog. */
export function isRuntimeModel(model: string): boolean {
  return catalogue.entries.has(model);
}

/** Static and discovered entries for consumers that enumerate the registry. */
export function runtimeModelConfigEntries(): readonly (readonly [
  string,
  ModelConfig,
])[] {
  return [...staticModelConfigEntries(), ...discoveredModelConfigEntries()];
}

/** Refresh and return only the editor-discovered model catalogue. */
export async function discoveredRuntimeModelConfigEntries(): Promise<
  readonly (readonly [string, ModelConfig])[]
> {
  try {
    await refreshRuntimeModelRegistry();
  } catch {
    // Runtime discovery is an optional host capability. The host adapter logs
    // failures; consumers receive an empty catalogue instead of stale entries.
    return [];
  }
  return discoveredModelConfigEntries();
}
