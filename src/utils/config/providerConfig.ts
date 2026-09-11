/**
 * Provider streaming, endpoint, and region configuration.
 *
 * The shared provider registry owns provider state keys and region metadata.
 * This module only reads/writes those keys through the active platform state.
 *
 * Canonical read path: every key read here is registered in the state-setting
 * catalog (`src/shared/schemas/stateSettings.ts`) and read via
 * `readPlatformSetting()`, which resolves the default from the entry's schema
 * and snaps an invalid/stale stored value back to that default. A key that
 * has no catalog entry should be catalogued, not given another read path.
 */

import {
  PROVIDER_STATE_ENTRIES,
  PROVIDER_URLS,
  type ProviderStateEntry,
} from '@shared/constants/providers';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { readPlatformSetting, writePlatformSetting } from './platformSettings';

const PROVIDERS: ReadonlyMap<string, ProviderStateEntry> = new Map(
  PROVIDER_STATE_ENTRIES.map((provider) => [provider.id, provider]),
);

function regionSet(provider: string): boolean | undefined {
  const region = PROVIDERS.get(provider)?.region;
  // Region keys are catalog-modeled, so the default comes from the entry's
  // schema (kept aligned with the registry's `region.default` by the
  // state-settings guardrail suite).
  return region ? readPlatformSetting<boolean>(region.key) : undefined;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export function getGlobalStreaming(): boolean {
  return readPlatformSetting<boolean>(GlobalStateKey.STREAMING_GLOBAL);
}

// ---------------------------------------------------------------------------
// Endpoint
// ---------------------------------------------------------------------------

export function getProviderEndpoint(provider: string): string {
  const key = PROVIDERS.get(provider)?.endpointKey;
  // Catalog-modeled (see PROVIDER_ENDPOINT_SETTINGS in stateSettings.ts).
  return key ? readPlatformSetting<string>(key) : '';
}

export function supportsCustomEndpoint(provider: string): boolean {
  return PROVIDERS.get(provider)?.endpointKey !== undefined;
}

// ---------------------------------------------------------------------------
// Region (display name + key URL)
// ---------------------------------------------------------------------------

export function getProviderDisplayName(
  provider: string,
  defaultName: string,
): string {
  const region = PROVIDERS.get(provider)?.region;
  if (!region?.displayName) return defaultName;
  return regionSet(provider) ? region.displayName : defaultName;
}

export function getProviderKeyUrl(provider: string): string | undefined {
  // PROVIDER_URLS is a Record<string, string>, so this lookup is typed as
  // string even for an unknown provider; the guard is what makes it honest.
  const defaultUrl = PROVIDER_URLS[provider];
  if (!defaultUrl) return undefined;
  const region = PROVIDERS.get(provider)?.region;
  if (!region) return defaultUrl;
  const isSet = regionSet(provider);
  if (isSet === true && region.keyUrlWhenSet) return region.keyUrlWhenSet;
  if (isSet === false && region.keyUrlWhenUnset) return region.keyUrlWhenUnset;
  return defaultUrl;
}

/** Whether a provider routes through its China-region endpoint. */
export function useChinaRegion(provider: string): boolean {
  return regionSet(provider) ?? false;
}

// ---------------------------------------------------------------------------
// Standalone toggles
// ---------------------------------------------------------------------------

export function getGLMCodingPlan(): boolean {
  return readPlatformSetting<boolean>(GlobalStateKey.GLM_CODING_PLAN);
}

export function setGLMCodingPlan(enabled: boolean): Promise<void> {
  return writePlatformSetting(GlobalStateKey.GLM_CODING_PLAN, enabled);
}

/**
 * Whether the user opted to route dual-backend Kimi models (K3) through the
 * Kimi Code coding endpoint when a Kimi Code API key is set. The two
 * coding-only Kimi models always use that key regardless of this switch.
 * Catalog-modeled (see `stateSettings.ts`), so the default comes from the
 * schema via the shared accessor.
 */
export function getPreferKimiCode(): boolean {
  return readPlatformSetting<boolean>(GlobalStateKey.KIMI_CODE_PREFER);
}

export function getWebSocketEnabled(): boolean {
  // WEBSOCKET_OPENAI is catalog-modeled, so its default comes from the schema
  // via the shared accessor.
  return readPlatformSetting<boolean>(GlobalStateKey.WEBSOCKET_OPENAI);
}

/**
 * Whether to route all API calls through OpenRouter. Catalog-modeled (see
 * `stateSettings.ts`), so the default comes from the schema via the shared
 * accessor.
 */
export function getUseOpenRouter(): boolean {
  return readPlatformSetting<boolean>(GlobalStateKey.USE_OPENROUTER);
}
