import { Effect } from 'effect';
/**
 * Provider streaming, endpoint, and region configuration.
 *
 * The shared provider registry owns provider state keys and region metadata.
 * This module only reads/writes those keys through the active platform state.
 *
 * Canonical read path: every key read here is registered in the state-setting
 * catalog (`src/shared/schemas/stateSettings.ts`) and read via
 * `readSettingFrom()`, which resolves the default from the entry's schema
 * and snaps an invalid/stale stored value back to that default. A key that
 * has no catalog entry should be catalogued, not given another read path.
 *
 * Every function here takes the three setting slots it answers for. Nothing in
 * this module looks a host up, so a read answers for the workspace its caller
 * holds rather than for whichever roots frame the calling fiber happens to
 * carry.
 */

import type { ConfigWriteFailed } from '@platform/interfaces';
import {
  PROVIDER_STATE_ENTRIES,
  PROVIDER_URLS,
  type ProviderStateEntry,
} from '@shared/constants/providers';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { readSettingFrom, writeSettingTo } from './platformSettings';

const PROVIDERS: ReadonlyMap<string, ProviderStateEntry> = new Map(
  PROVIDER_STATE_ENTRIES.map((provider) => [provider.id, provider]),
);

function regionSet(stores: SettingsStores, provider: string) {
  return Effect.gen(function* () {
    const region = PROVIDERS.get(provider)?.region;
    // Region keys are catalog-modeled, so the default comes from the entry's
    // schema (kept aligned with the registry's `region.default` by the
    // state-settings guardrail suite).
    return region
      ? yield* readSettingFrom<boolean>(stores, region.key)
      : undefined;
  });
}

// ---------------------------------------------------------------------------
// Endpoint
// ---------------------------------------------------------------------------

export function getProviderEndpoint(stores: SettingsStores, provider: string) {
  return Effect.gen(function* () {
    const key = PROVIDERS.get(provider)?.endpointKey;
    // Catalog-modeled (see PROVIDER_ENDPOINT_SETTINGS in stateSettings.ts).
    return key ? yield* readSettingFrom<string>(stores, key) : '';
  });
}

export function supportsCustomEndpoint(provider: string): boolean {
  return PROVIDERS.get(provider)?.endpointKey !== undefined;
}

// ---------------------------------------------------------------------------
// Region (display name + key URL)
// ---------------------------------------------------------------------------

export function getProviderDisplayName(
  stores: SettingsStores,
  provider: string,
  defaultName: string,
) {
  return Effect.gen(function* () {
    const region = PROVIDERS.get(provider)?.region;
    if (!region?.displayName) return defaultName;
    return (yield* regionSet(stores, provider))
      ? region.displayName
      : defaultName;
  });
}

export function getProviderKeyUrl(stores: SettingsStores, provider: string) {
  return Effect.gen(function* () {
    // PROVIDER_URLS is a Record<string, string>, so this lookup is typed as
    // string even for an unknown provider; the guard is what makes it honest.
    const defaultUrl = PROVIDER_URLS[provider];
    if (!defaultUrl) return undefined;
    const region = PROVIDERS.get(provider)?.region;
    if (!region) return defaultUrl;
    const isSet = yield* regionSet(stores, provider);
    if (isSet === true && region.keyUrlWhenSet) return region.keyUrlWhenSet;
    if (isSet === false && region.keyUrlWhenUnset)
      return region.keyUrlWhenUnset;
    return defaultUrl;
  });
}

/** Whether a provider routes through its China-region endpoint. */
export function useChinaRegion(stores: SettingsStores, provider: string) {
  return regionSet(stores, provider).pipe(Effect.map((set) => set ?? false));
}

// ---------------------------------------------------------------------------
// Standalone toggles
// ---------------------------------------------------------------------------

export function getGLMCodingPlan(stores: SettingsStores) {
  return readSettingFrom<boolean>(stores, GlobalStateKey.GLM_CODING_PLAN);
}

export function setGLMCodingPlan(
  stores: SettingsStores,
  enabled: boolean,
): Effect.Effect<void, ConfigWriteFailed | Error> {
  return writeSettingTo(stores, GlobalStateKey.GLM_CODING_PLAN, enabled);
}

/**
 * Whether the user opted to route dual-backend Kimi models (K3) through the
 * Kimi Code coding endpoint when a Kimi Code API key is set. The two
 * coding-only Kimi models always use that key regardless of this switch.
 * Catalog-modeled (see `stateSettings.ts`), so the default comes from the
 * schema via the shared accessor.
 */
export function getPreferKimiCode(stores: SettingsStores) {
  return readSettingFrom<boolean>(stores, GlobalStateKey.KIMI_CODE_PREFER);
}

/**
 * Whether to route all API calls through OpenRouter. Catalog-modeled (see
 * `stateSettings.ts`), so the default comes from the schema via the shared
 * accessor.
 */
export function getUseOpenRouter(stores: SettingsStores) {
  return readSettingFrom<boolean>(stores, GlobalStateKey.USE_OPENROUTER);
}
