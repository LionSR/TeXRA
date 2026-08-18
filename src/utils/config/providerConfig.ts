/**
 * Provider-specific streaming, endpoint, and region configuration.
 *
 * The shared provider registry owns provider state keys and region metadata.
 * This module only reads/writes those keys through the active platform state.
 *
 * Canonical read path: keys registered in the state-setting catalog
 * (`src/shared/schemas/stateSettings.ts`) are read via `readPlatformSetting()`,
 * which resolves the default from the entry's schema and snaps an
 * invalid/stale stored value back to that default. Keys not yet in the
 * catalog (the per-provider streaming toggles below) fall back to the
 * local `read()` helper — migrate a key to
 * `readPlatformSetting()` once it gets a catalog entry rather than adding a
 * fourth read path.
 */

import { platform } from '@platform/platform';
import type { StateStore } from '@platform/interfaces';
import {
  PROVIDER_STATE_ENTRIES,
  PROVIDER_URLS,
  type ProviderStateEntry,
} from '@shared/constants/providers';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { readPlatformSetting } from './platformSettings';

const PROVIDERS: ReadonlyMap<string, ProviderStateEntry> = new Map(
  PROVIDER_STATE_ENTRIES.map((provider) => [provider.id, provider]),
);

function entry(provider: string): ProviderStateEntry | undefined {
  return PROVIDERS.get(provider) ?? PROVIDERS.get(provider.toLowerCase());
}

/** Non-catalog fallback — see the module-level "Canonical read path" note. */
function read<T>(key: GlobalStateKey, defaultValue: T): T {
  return platform().globalState.get(key, defaultValue);
}

function regionSet(provider: string): boolean | undefined {
  const region = entry(provider)?.region;
  // Region keys are catalog-modeled, so the default comes from the entry's
  // schema (kept aligned with the registry's `region.default` by the
  // state-settings guardrail suite).
  return region ? readPlatformSetting<boolean>(region.key) : undefined;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export function getGlobalStreaming(): boolean {
  return read(GlobalStateKey.STREAMING_GLOBAL, true);
}

export function getProviderStreaming(provider: string): boolean {
  const fallback = getGlobalStreaming();
  const key = entry(provider)?.streamingKey;
  return key ? read(key, fallback) : fallback;
}

// ---------------------------------------------------------------------------
// Endpoint
// ---------------------------------------------------------------------------

export function getProviderEndpoint(provider: string): string {
  const key = entry(provider)?.endpointKey;
  // Catalog-modeled (see PROVIDER_ENDPOINT_SETTINGS in stateSettings.ts).
  return key ? readPlatformSetting<string>(key) : '';
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

export function getProviderKeyUrl(provider: string): string | undefined;
export function getProviderKeyUrl(provider: string, defaultUrl: string): string;
export function getProviderKeyUrl(
  provider: string,
  defaultUrl = PROVIDER_URLS[provider],
): string | undefined {
  if (!defaultUrl) return undefined;
  const region = entry(provider)?.region;
  if (!region) return defaultUrl;
  const isSet = regionSet(provider);
  if (isSet === true && region.keyUrlWhenSet) return region.keyUrlWhenSet;
  if (isSet === false && region.keyUrlWhenUnset) return region.keyUrlWhenUnset;
  return defaultUrl;
}

// China-region routing defaults per provider, used when the provider's region
// key is unset (providers without region metadata).
const USE_CHINA_DEFAULT: Readonly<Record<string, boolean>> = {
  dashscope: false,
  minimax: false,
  moonshot: true,
  glm: true,
};

/** Whether a provider routes through its China-region endpoint. */
export function useChinaRegion(provider: string): boolean {
  return regionSet(provider) ?? USE_CHINA_DEFAULT[provider] ?? false;
}

// ---------------------------------------------------------------------------
// Standalone toggles
// ---------------------------------------------------------------------------

export function getGLMCodingPlan(): boolean {
  return readPlatformSetting<boolean>(GlobalStateKey.GLM_CODING_PLAN);
}

export async function setGLMCodingPlan(enabled: boolean): Promise<void> {
  await platform().globalState.update(GlobalStateKey.GLM_CODING_PLAN, enabled);
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

/**
 * Set the Kimi Code routing preference and its OpenRouter exclusion.
 *
 * Kimi Code and OpenRouter are alternative routes for dual-backend Kimi
 * models. Keeping both writes here gives every caller the same transition.
 */
export async function setPreferKimiCode(
  enabled: boolean,
  state: StateStore = platform().globalState,
  options: { readonly preserveOpenRouter?: boolean } = {},
): Promise<void> {
  await state.update(GlobalStateKey.KIMI_CODE_PREFER, enabled);
  if (enabled && options.preserveOpenRouter !== true) {
    await state.update(GlobalStateKey.USE_OPENROUTER, false);
  }
}

export function getWebSocketEnabled(): boolean {
  // WEBSOCKET_OPENAI is catalog-modeled, so its default comes from the schema
  // via the shared accessor.
  return readPlatformSetting<boolean>(GlobalStateKey.WEBSOCKET_OPENAI);
}

/**
 * Whether to route all API calls through OpenRouter. Catalog-modeled (see
 * `stateSettings.ts`); the legacy VS Code config fallback this used to carry
 * for pre-globalSM-migration users was dead code — `StateStore.get(key,
 * defaultValue)` always resolves to `defaultValue` once the platform is
 * initialized, so the config fallback could only ever fire before
 * initialization, at which point `getConfig` also just returns its own
 * `defaultValue` (`false`). Removed rather than folded into
 * `readPlatformSetting()`.
 */
export function getUseOpenRouter(): boolean {
  return readPlatformSetting<boolean>(GlobalStateKey.USE_OPENROUTER);
}
