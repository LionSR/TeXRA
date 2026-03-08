/**
 * Provider-specific streaming and endpoint configuration.
 *
 * Co-locates all provider runtime config (streaming toggles, custom endpoints)
 * in one place. Static provider constants (display names, URLs, etc.) live
 * in @shared/constants/providers.
 */

import { globalState } from '@common/state/stateBridge';

// ---------------------------------------------------------------------------
// State key constants (string values matching GlobalStateKey enum)
// ---------------------------------------------------------------------------

/** Map from provider string to state key for per-provider streaming. */
const STREAMING_KEY: Record<string, string> = {
  openai: 'texra.streaming.openai',
  anthropic: 'texra.streaming.anthropic',
  openrouter: 'texra.streaming.openrouter',
  google: 'texra.streaming.google',
  xai: 'texra.streaming.xai',
  deepseek: 'texra.streaming.deepseek',
  moonshot: 'texra.streaming.moonshot',
  dashscope: 'texra.streaming.dashscope',
};

/** Map from provider string to state key for per-provider endpoint. */
const ENDPOINT_KEY: Record<string, string> = {
  openai: 'texra.endpoint.openai',
  anthropic: 'texra.endpoint.anthropic',
  google: 'texra.endpoint.google',
  deepseek: 'texra.endpoint.deepseek',
  xai: 'texra.endpoint.xai',
  moonshot: 'texra.endpoint.moonshot',
  dashscope: 'texra.endpoint.dashscope',
};

const STREAMING_GLOBAL_KEY = 'texra.streaming.global';
const MEMORY_ENABLED_KEY = 'texra.memory.enabled';
const ANTHROPIC_DYNAMIC_FILTERING_KEY = 'texra.anthropic.dynamicFiltering';

// ---------------------------------------------------------------------------
// Streaming / Endpoint settings
// ---------------------------------------------------------------------------

/** Read the global streaming default. */
export function getGlobalStreaming(): boolean {
  return globalState.get<boolean>(STREAMING_GLOBAL_KEY, true) ?? true;
}

/** Set the global streaming default. */
export async function setGlobalStreaming(enabled: boolean): Promise<void> {
  await globalState.update(STREAMING_GLOBAL_KEY, enabled);
}

/** Read per-provider streaming setting, falling back to global default. */
export function getProviderStreaming(provider: string): boolean {
  const key = STREAMING_KEY[provider.toLowerCase()];
  if (!key) return getGlobalStreaming();
  const global = getGlobalStreaming();
  return globalState.get<boolean>(key, global) ?? global;
}

/** Set per-provider streaming setting. */
export async function setProviderStreaming(
  provider: string,
  enabled: boolean,
): Promise<void> {
  const key = STREAMING_KEY[provider.toLowerCase()];
  if (key) {
    await globalState.update(key, enabled);
  }
}

/** Read per-provider custom endpoint. Returns empty string when unset. */
export function getProviderEndpoint(provider: string): string {
  const key = ENDPOINT_KEY[provider.toLowerCase()];
  if (!key) return '';
  return globalState.get<string>(key, '') ?? '';
}

/** Set per-provider custom endpoint. */
export async function setProviderEndpoint(
  provider: string,
  endpoint: string,
): Promise<void> {
  const key = ENDPOINT_KEY[provider.toLowerCase()];
  if (key) {
    await globalState.update(key, endpoint);
  }
}

/** Whether the given provider has a configurable custom endpoint. */
export function supportsCustomEndpoint(provider: string): boolean {
  return provider.toLowerCase() in ENDPOINT_KEY;
}

// ---------------------------------------------------------------------------
// Memory / Anthropic API settings
// ---------------------------------------------------------------------------

/** Determine whether the memory tool is enabled for tool-use sessions. */
export function getToolUseMemoryEnabled(): boolean {
  return globalState.get<boolean>(MEMORY_ENABLED_KEY, true) ?? true;
}

/** Set whether the memory tool is enabled for tool-use sessions. */
export async function setToolUseMemoryEnabled(enabled: boolean): Promise<void> {
  await globalState.update(MEMORY_ENABLED_KEY, enabled);
}

/**
 * Whether Anthropic web_search/web_fetch should use dynamic filtering.
 * Defaults to false — tools use allowed_callers: ['direct'] to bypass
 * code execution and avoid the container_id requirement.
 */
export function getAnthropicDynamicFiltering(): boolean {
  return (
    globalState.get<boolean>(ANTHROPIC_DYNAMIC_FILTERING_KEY, false) ?? false
  );
}

/** Set Anthropic dynamic filtering preference. */
export async function setAnthropicDynamicFiltering(
  enabled: boolean,
): Promise<void> {
  await globalState.update(ANTHROPIC_DYNAMIC_FILTERING_KEY, enabled);
}
