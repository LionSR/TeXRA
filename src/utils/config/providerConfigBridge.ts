/**
 * Platform-agnostic provider streaming and endpoint configuration.
 *
 * Mirrors the functions in providerConfig.ts but uses stateBridge instead of
 * importing globalSM directly. Safe to import from VS Code-free zones.
 */

import { globalState } from '@common/state/stateBridge';

// Re-declare the keys (enum values are just strings) to avoid importing
// from the VS Code-coupled stateManager module.
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

/** Read the global streaming default. */
export function getGlobalStreaming(): boolean {
  return globalState.get<boolean>(STREAMING_GLOBAL_KEY, true) ?? true;
}

/** Read per-provider streaming setting, falling back to global default. */
export function getProviderStreaming(provider: string): boolean {
  const key = STREAMING_KEY[provider.toLowerCase()];
  if (!key) return getGlobalStreaming();
  const global = getGlobalStreaming();
  return globalState.get<boolean>(key, global) ?? global;
}

/** Read per-provider custom endpoint. Returns empty string when unset. */
export function getProviderEndpoint(provider: string): string {
  const key = ENDPOINT_KEY[provider.toLowerCase()];
  if (!key) return '';
  return globalState.get<string>(key, '') ?? '';
}

/** Determine whether the memory tool is enabled for tool-use sessions. */
export function getToolUseMemoryEnabled(): boolean {
  return globalState.get<boolean>(MEMORY_ENABLED_KEY, true) ?? true;
}

const ANTHROPIC_DYNAMIC_FILTERING_KEY = 'texra.anthropic.dynamicFiltering';

/** Whether Anthropic web_search/web_fetch should use dynamic filtering. */
export function getAnthropicDynamicFiltering(): boolean {
  return (
    globalState.get<boolean>(ANTHROPIC_DYNAMIC_FILTERING_KEY, false) ?? false
  );
}
