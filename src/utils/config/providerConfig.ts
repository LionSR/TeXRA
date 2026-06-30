/**
 * Provider-specific streaming, endpoint, and region configuration.
 *
 * The shared provider registry owns provider state keys and region metadata.
 * This module only reads/writes those keys through the active platform state.
 */

import { tryGlobalState } from '@platform/platform';
import {
  PROVIDER_STATE_ENTRIES,
  type ProviderStateEntry,
} from '@shared/constants/providers';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { getConfig } from '@utils/config';
import { readPlatformSetting } from './platformSettings';

const PROVIDERS: ReadonlyMap<string, ProviderStateEntry> = new Map(
  PROVIDER_STATE_ENTRIES.map((provider) => [
    provider.id.toLowerCase(),
    provider,
  ]),
);

function entry(provider: string): ProviderStateEntry | undefined {
  return PROVIDERS.get(provider.toLowerCase());
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
  const key = entry(provider)?.streamingKey;
  return key ? read(key, fallback) : fallback;
}

export async function setProviderStreaming(
  provider: string,
  enabled: boolean,
): Promise<void> {
  const key = entry(provider)?.streamingKey;
  if (key) await tryGlobalState()?.update(key, enabled);
}

// ---------------------------------------------------------------------------
// Endpoint
// ---------------------------------------------------------------------------

export function getProviderEndpoint(provider: string): string {
  const key = entry(provider)?.endpointKey;
  return key ? read(key, '') : '';
}

export async function setProviderEndpoint(
  provider: string,
  endpoint: string,
): Promise<void> {
  const key = entry(provider)?.endpointKey;
  if (key) await tryGlobalState()?.update(key, endpoint);
}

export function supportsCustomEndpoint(provider: string): boolean {
  return entry(provider)?.endpointKey !== undefined;
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

/**
 * Per-process override for the OpenAI WebSocket toggle, set from the CLI
 * `--websocket`/`--no-websocket` flag. The global-state key has no CLI setter,
 * so this lets a single CLI invocation flip the transport without persisting to
 * `~/.texra/global-storage/state.json`. `undefined` falls through to the stored
 * setting (the extension/desktop UI toggle). Hosts other than the CLI never set
 * it, so the stored value remains authoritative there.
 */
let webSocketEnabledOverride: boolean | undefined;

export function setWebSocketEnabledOverride(value: boolean | undefined): void {
  webSocketEnabledOverride = value;
}

export function getWebSocketEnabled(): boolean {
  // WEBSOCKET_OPENAI is catalog-modeled, so its default comes from the schema
  // via the shared accessor. The other provider toggles below are not in the
  // catalog and stay on the local `read`.
  return (
    webSocketEnabledOverride ??
    readPlatformSetting<boolean>(GlobalStateKey.WEBSOCKET_OPENAI)
  );
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
