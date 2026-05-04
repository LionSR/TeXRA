/**
 * Provider-specific streaming, endpoint, and region configuration.
 *
 * Each entry in PROVIDERS bundles a provider's globalSM keys and any
 * region-toggle metadata that drives display name / key URL overrides.
 * Static provider constants (default URLs, descriptions, etc.) live in
 * @shared/constants/providers.
 */

import { tryGlobalState } from '@platform/platform';
import { GlobalStateKey } from '@common/state/stateKeys';
import { getConfig } from '@utils/config';

/**
 * When `key` is set in globalSM (treated as boolean), the provider is in its
 * alternate region. `displayName` overrides the default name; `keyUrlWhenSet`
 * and `keyUrlWhenUnset` override the default key URL passed to
 * `getProviderKeyUrl`. Each is optional — only the dimensions that actually
 * differ across regions are populated.
 */
type RegionOverride = {
  key: GlobalStateKey;
  default: boolean;
  displayName?: string;
  keyUrlWhenSet?: string;
  keyUrlWhenUnset?: string;
};

type ProviderEntry = {
  streaming?: GlobalStateKey;
  endpoint?: GlobalStateKey;
  region?: RegionOverride;
};

const PROVIDERS: Record<string, ProviderEntry> = {
  openai: {
    streaming: GlobalStateKey.STREAMING_OPENAI,
    endpoint: GlobalStateKey.ENDPOINT_OPENAI,
  },
  anthropic: {
    streaming: GlobalStateKey.STREAMING_ANTHROPIC,
    endpoint: GlobalStateKey.ENDPOINT_ANTHROPIC,
  },
  openrouter: { streaming: GlobalStateKey.STREAMING_OPENROUTER },
  google: {
    streaming: GlobalStateKey.STREAMING_GOOGLE,
    endpoint: GlobalStateKey.ENDPOINT_GOOGLE,
  },
  xai: {
    streaming: GlobalStateKey.STREAMING_XAI,
    endpoint: GlobalStateKey.ENDPOINT_XAI,
  },
  deepseek: {
    streaming: GlobalStateKey.STREAMING_DEEPSEEK,
    endpoint: GlobalStateKey.ENDPOINT_DEEPSEEK,
  },
  moonshot: {
    streaming: GlobalStateKey.STREAMING_MOONSHOT,
    endpoint: GlobalStateKey.ENDPOINT_MOONSHOT,
  },
  dashscope: {
    streaming: GlobalStateKey.STREAMING_DASHSCOPE,
    endpoint: GlobalStateKey.ENDPOINT_DASHSCOPE,
    region: {
      key: GlobalStateKey.DASHSCOPE_USE_CHINA,
      default: false,
      displayName: 'Bailian',
      keyUrlWhenSet: 'https://bailian.console.aliyun.com/',
    },
  },
  minimax: {
    streaming: GlobalStateKey.STREAMING_MINIMAX,
    endpoint: GlobalStateKey.ENDPOINT_MINIMAX,
    region: {
      key: GlobalStateKey.MINIMAX_USE_CHINA,
      default: false,
      keyUrlWhenSet: 'https://platform.minimaxi.com/',
    },
  },
  glm: {
    streaming: GlobalStateKey.STREAMING_GLM,
    endpoint: GlobalStateKey.ENDPOINT_GLM,
    // China=true is the default since bigmodel.cn is the primary platform;
    // when toggled off (international), the key URL is z.ai.
    region: {
      key: GlobalStateKey.GLM_USE_CHINA,
      default: true,
      keyUrlWhenUnset: 'https://z.ai/',
    },
  },
};

function entry(provider: string): ProviderEntry | undefined {
  return PROVIDERS[provider.toLowerCase()];
}

function read<T>(key: GlobalStateKey, defaultValue: T): T {
  return tryGlobalState()?.get(key, defaultValue) ?? defaultValue;
}

function regionSet(provider: string): boolean | undefined {
  const region = entry(provider)?.region;
  return region ? read(region.key, region.default) : undefined;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export function getGlobalStreaming(): boolean {
  return read(GlobalStateKey.STREAMING_GLOBAL, true);
}

export async function setGlobalStreaming(enabled: boolean): Promise<void> {
  await tryGlobalState()?.update(GlobalStateKey.STREAMING_GLOBAL, enabled);
}

export function getProviderStreaming(provider: string): boolean {
  const fallback = getGlobalStreaming();
  const key = entry(provider)?.streaming;
  return key ? read(key, fallback) : fallback;
}

export async function setProviderStreaming(
  provider: string,
  enabled: boolean,
): Promise<void> {
  const key = entry(provider)?.streaming;
  if (key) await tryGlobalState()?.update(key, enabled);
}

// ---------------------------------------------------------------------------
// Endpoint
// ---------------------------------------------------------------------------

export function getProviderEndpoint(provider: string): string {
  const key = entry(provider)?.endpoint;
  return key ? read(key, '') : '';
}

export async function setProviderEndpoint(
  provider: string,
  endpoint: string,
): Promise<void> {
  const key = entry(provider)?.endpoint;
  if (key) await tryGlobalState()?.update(key, endpoint);
}

export function supportsCustomEndpoint(provider: string): boolean {
  return entry(provider)?.endpoint !== undefined;
}

// ---------------------------------------------------------------------------
// Region (display name + key URL)
// ---------------------------------------------------------------------------

export function getProviderDisplayName(
  provider: string,
  defaultName: string,
): string {
  const region = entry(provider)?.region;
  if (!region?.displayName) return defaultName;
  return regionSet(provider) ? region.displayName : defaultName;
}

export function getProviderKeyUrl(
  provider: string,
  defaultUrl: string,
): string {
  const region = entry(provider)?.region;
  if (!region) return defaultUrl;
  const isSet = regionSet(provider);
  if (isSet === true && region.keyUrlWhenSet) return region.keyUrlWhenSet;
  if (isSet === false && region.keyUrlWhenUnset) return region.keyUrlWhenUnset;
  return defaultUrl;
}

// Named region accessors retained for direct callers in other files.
export function getDashScopeUseChina(): boolean {
  return regionSet('dashscope') ?? false;
}

export function getMiniMaxUseChina(): boolean {
  return regionSet('minimax') ?? false;
}

export function getGLMUseChina(): boolean {
  return regionSet('glm') ?? true;
}

// ---------------------------------------------------------------------------
// Standalone toggles
// ---------------------------------------------------------------------------

export function getAnthropicDynamicFiltering(): boolean {
  return read(GlobalStateKey.ANTHROPIC_DYNAMIC_FILTERING, false);
}

export function getGLMCodingPlan(): boolean {
  return read(GlobalStateKey.GLM_CODING_PLAN, false);
}

export function getWebSocketEnabled(): boolean {
  return read(GlobalStateKey.WEBSOCKET_OPENAI, false);
}

/**
 * Whether to route all API calls through OpenRouter.
 * Falls back to the legacy VS Code config key for users upgrading from
 * before the globalSM migration.
 */
export function getUseOpenRouter(): boolean {
  return (
    tryGlobalState()?.get(GlobalStateKey.USE_OPENROUTER, false) ??
    getConfig<boolean>('texra.model.useOpenRouter', false)
  );
}
