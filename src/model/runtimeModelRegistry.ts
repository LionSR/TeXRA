import {
  DEFAULT_MODEL_CAPABILITIES,
  MODEL_CONFIGS,
  ModelProvider,
  type ModelConfig,
} from 'llm-zoo';

import { platform } from '@platform/platform';
import type { ApiProvider } from '@model/apiProviders';
import { resolveModelApiKeyProvider } from '@model/openRouterRouting';

import { KIMI_CODE_MODEL_CONFIGS } from './kimiCodeModels';

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

const runtimeModels = new Map<string, RuntimeModelEntry>();
let discoveryEpoch = 0;
let discoveryComplete = false;
let pendingDiscovery: Promise<void> | undefined;

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
    .filter(([, config]) => !config.retired && !config.deprecated)
    .filter(([, config]) =>
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
    contextWindow: info.maxInputTokens,
    inputPrice: 0,
    outputPrice: 0,
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
  if (discoveryComplete) return;
  if (pendingDiscovery) return pendingDiscovery;

  const epoch = discoveryEpoch;
  const request = (async () => {
    const discovered = await discoverCopilotModels();
    if (epoch !== discoveryEpoch) return;
    runtimeModels.clear();
    for (const [id, entry] of discovered) runtimeModels.set(id, entry);
    discoveryComplete = true;
  })();
  pendingDiscovery = request;
  try {
    await request;
  } catch (error) {
    if (epoch === discoveryEpoch) runtimeModels.clear();
    throw error;
  } finally {
    if (pendingDiscovery === request) pendingDiscovery = undefined;
  }
}

/** Mark discovery stale while retaining last-known configs for sync readers. */
export function invalidateRuntimeModelRegistry(): void {
  discoveryEpoch += 1;
  discoveryComplete = false;
  pendingDiscovery = undefined;
}

/** Resolve a static or editor-discovered model config by its persisted id. */
export function getRuntimeModelConfig(model: string): ModelConfig | undefined {
  return (
    runtimeModels.get(model)?.config ??
    KIMI_CODE_MODEL_CONFIGS[model] ??
    MODEL_CONFIGS[model]
  );
}

/** All static model entries owned by TeXRA and llm-zoo. */
export function staticModelConfigEntries(): readonly (readonly [
  string,
  ModelConfig,
])[] {
  return [
    ...Object.entries(MODEL_CONFIGS),
    ...Object.entries(KIMI_CODE_MODEL_CONFIGS),
  ];
}

/** Resolve a model after ensuring native discovery has run in this host. */
export async function resolveRuntimeModelConfig(
  model: string,
): Promise<ModelConfig | undefined> {
  const staticConfig = KIMI_CODE_MODEL_CONFIGS[model] ?? MODEL_CONFIGS[model];
  if (staticConfig) return staticConfig;

  await refreshRuntimeModelRegistry();
  return runtimeModels.get(model)?.config;
}

/** Available editor-supplied model ids appended to ordinary visible models. */
export function availableRuntimeModelIds(): readonly string[] {
  return [...runtimeModels]
    .filter(([, entry]) => entry.access === 'allowed')
    .map(([id]) => id);
}

/** All compatible editor-supplied models, including models awaiting consent. */
export function runtimeModelIds(): readonly string[] {
  return [...runtimeModels.keys()];
}

/** Access state reported by the editor for a discovered runtime model. */
export function runtimeModelAccess(
  model: string,
): LanguageModelAccessState | undefined {
  return runtimeModels.get(model)?.access;
}

/** Direct-key model represented by an editor-supplied subscription model. */
export function getRuntimeModelDirectFallback(
  model: string,
  useOpenRouter: boolean,
): RuntimeModelDirectFallback | undefined {
  const directModel = runtimeModels.get(model)?.directModel;
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
  const entry = runtimeModels.get(model);
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
  return runtimeModels.has(model);
}

/** Static and discovered entries for consumers that enumerate the registry. */
export function runtimeModelConfigEntries(): readonly (readonly [
  string,
  ModelConfig,
])[] {
  return [
    ...staticModelConfigEntries(),
    ...[...runtimeModels].map(([id, entry]) => [id, entry.config] as const),
  ];
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
  return [...runtimeModels].map(([id, entry]) => [id, entry.config] as const);
}
