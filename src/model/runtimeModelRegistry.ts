import {
  DEFAULT_MODEL_CAPABILITIES,
  MODEL_CONFIGS,
  ModelProvider,
  type ModelConfig,
} from 'llm-zoo';

import { platform } from '@platform/platform';
import type { LanguageModelInfo } from '@platform/languageModel';

const COPILOT_MODEL_PREFIX = 'copilot:';

interface RuntimeModelEntry {
  readonly config: ModelConfig;
  readonly access: boolean | undefined;
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
      supportsVision: false,
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
      access: await languageModel.canSendRequest({
        vendor: info.vendor,
        id: info.id,
      }),
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
  } finally {
    if (pendingDiscovery === request) pendingDiscovery = undefined;
  }
}

/** Drop native discovery state; the next async registry read repopulates it. */
export function invalidateRuntimeModelRegistry(): void {
  discoveryEpoch += 1;
  discoveryComplete = false;
  pendingDiscovery = undefined;
  runtimeModels.clear();
}

/** Resolve a static or editor-discovered model config by its persisted id. */
export function getRuntimeModelConfig(model: string): ModelConfig | undefined {
  return runtimeModels.get(model)?.config ?? MODEL_CONFIGS[model];
}

/** Resolve a model after ensuring native discovery has run in this host. */
export async function resolveRuntimeModelConfig(
  model: string,
): Promise<ModelConfig | undefined> {
  await refreshRuntimeModelRegistry();
  return getRuntimeModelConfig(model);
}

/** Available editor-supplied model ids appended to ordinary visible models. */
export function availableRuntimeModelIds(): readonly string[] {
  return [...runtimeModels]
    .filter(([, entry]) => entry.access === true)
    .map(([id]) => id);
}

/** Access state reported by the editor for a discovered runtime model. */
export function runtimeModelAccess(model: string): boolean | undefined {
  return runtimeModels.get(model)?.access;
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
    ...Object.entries(MODEL_CONFIGS),
    ...[...runtimeModels].map(([id, entry]) => [id, entry.config] as const),
  ];
}
