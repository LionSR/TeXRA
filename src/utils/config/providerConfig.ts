/**
 * Provider-specific streaming and endpoint configuration.
 *
 * Co-locates all provider runtime config (streaming toggles, custom endpoints)
 * in one place. Static provider constants (display names, URLs, etc.) live
 * in @shared/constants/providers.
 */

import { globalSM, GlobalStateKey } from '@common/state/stateManager';

/** Map from provider string to GlobalStateKey for per-provider streaming. */
const STREAMING_KEY: Record<string, GlobalStateKey> = {
  openai: GlobalStateKey.STREAMING_OPENAI,
  anthropic: GlobalStateKey.STREAMING_ANTHROPIC,
  openrouter: GlobalStateKey.STREAMING_OPENROUTER,
  google: GlobalStateKey.STREAMING_GOOGLE,
  xai: GlobalStateKey.STREAMING_XAI,
  deepseek: GlobalStateKey.STREAMING_DEEPSEEK,
  moonshot: GlobalStateKey.STREAMING_MOONSHOT,
  dashscope: GlobalStateKey.STREAMING_DASHSCOPE,
};

/** Map from provider string to GlobalStateKey for per-provider endpoint. */
const ENDPOINT_KEY: Record<string, GlobalStateKey> = {
  openai: GlobalStateKey.ENDPOINT_OPENAI,
  anthropic: GlobalStateKey.ENDPOINT_ANTHROPIC,
  google: GlobalStateKey.ENDPOINT_GOOGLE,
  deepseek: GlobalStateKey.ENDPOINT_DEEPSEEK,
  xai: GlobalStateKey.ENDPOINT_XAI,
  moonshot: GlobalStateKey.ENDPOINT_MOONSHOT,
  dashscope: GlobalStateKey.ENDPOINT_DASHSCOPE,
};

/** Read the global streaming default. */
export function getGlobalStreaming(): boolean {
  return globalSM?.get<boolean>(GlobalStateKey.STREAMING_GLOBAL, true) ?? true;
}

/** Set the global streaming default. */
export async function setGlobalStreaming(enabled: boolean): Promise<void> {
  await globalSM?.update(GlobalStateKey.STREAMING_GLOBAL, enabled);
}

/** Read per-provider streaming setting, falling back to global default. */
export function getProviderStreaming(provider: string): boolean {
  const key = STREAMING_KEY[provider.toLowerCase()];
  if (!key) return getGlobalStreaming();
  const global = getGlobalStreaming();
  return globalSM?.get<boolean>(key, global) ?? global;
}

/** Set per-provider streaming setting. */
export async function setProviderStreaming(
  provider: string,
  enabled: boolean,
): Promise<void> {
  const key = STREAMING_KEY[provider.toLowerCase()];
  if (key) {
    await globalSM?.update(key, enabled);
  }
}

/** Read per-provider custom endpoint. Returns empty string when unset. */
export function getProviderEndpoint(provider: string): string {
  const key = ENDPOINT_KEY[provider.toLowerCase()];
  if (!key) return '';
  return globalSM?.get<string>(key, '') ?? '';
}

/** Set per-provider custom endpoint. */
export async function setProviderEndpoint(
  provider: string,
  endpoint: string,
): Promise<void> {
  const key = ENDPOINT_KEY[provider.toLowerCase()];
  if (key) {
    await globalSM?.update(key, endpoint);
  }
}

/** Whether the given provider has a configurable custom endpoint. */
export function supportsCustomEndpoint(provider: string): boolean {
  return provider.toLowerCase() in ENDPOINT_KEY;
}

/**
 * Whether Anthropic web_search/web_fetch should use dynamic filtering.
 * When true, Claude can write code to filter fetched content before it
 * enters context (requires code execution container support).
 * Defaults to false — tools use allowed_callers: ['direct'] to bypass
 * code execution and avoid the container_id requirement.
 */
export function getAnthropicDynamicFiltering(): boolean {
  return (
    globalSM?.get<boolean>(GlobalStateKey.ANTHROPIC_DYNAMIC_FILTERING, false) ??
    false
  );
}

/** Set Anthropic dynamic filtering preference. */
export async function setAnthropicDynamicFiltering(
  enabled: boolean,
): Promise<void> {
  await globalSM?.update(GlobalStateKey.ANTHROPIC_DYNAMIC_FILTERING, enabled);
}

// ---------------------------------------------------------------------------
// DashScope region setting (globalSM-backed)
// ---------------------------------------------------------------------------

/** Whether DashScope is set to use the China (Bailian) region. */
export function getDashScopeUseChina(): boolean {
  return (
    globalSM?.get<boolean>(GlobalStateKey.DASHSCOPE_USE_CHINA, false) ?? false
  );
}

// ---------------------------------------------------------------------------
// WebSocket transport setting (globalSM-backed)
// ---------------------------------------------------------------------------

/** Read the WebSocket transport setting for OpenAI. */
export function getWebSocketEnabled(): boolean {
  return (
    globalSM?.get<boolean>(GlobalStateKey.WEBSOCKET_OPENAI, false) ?? false
  );
}
