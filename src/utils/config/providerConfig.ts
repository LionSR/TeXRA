import { Effect } from 'effect';
/**
 * Provider streaming, endpoint, and region configuration.
 *
 * The provider settings (`@shared/state/providerSettings`) own the provider
 * state keys; the llm catalog owns the region copy.
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

import {
  findModelProviderPlugin,
  PROVIDER_URLS,
  type EndpointProviderId,
  type RegionalProviderId,
} from '@texra-ai/llm';

import type { ConfigWriteFailed } from '@platform/interfaces';
import type { SettingsStores } from '@shared/config/settingsAccess';
import {
  PROVIDER_ENDPOINT_STATE_ENTRIES,
  PROVIDER_REGION_SETTINGS,
  providerEndpointKey,
  providerRegionSetting,
} from '@shared/state/providerSettings';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { readSettingFrom, writeSettingTo } from './platformSettings';

type AssertNever<T extends never> = T;

/**
 * The settings rows cover the catalog exactly: every provider with an HTTP
 * endpoint of its own has a custom-endpoint row and every regional provider
 * a region toggle, and no row names another provider. The error names the
 * provider ids on either side that lack their counterpart.
 */
type _EndpointRowsCoverTheCatalog = AssertNever<
  | Exclude<
      EndpointProviderId,
      (typeof PROVIDER_ENDPOINT_STATE_ENTRIES)[number]['id']
    >
  | Exclude<
      (typeof PROVIDER_ENDPOINT_STATE_ENTRIES)[number]['id'],
      EndpointProviderId
    >
>;
type _RegionRowsCoverTheCatalog = AssertNever<
  | Exclude<
      RegionalProviderId,
      (typeof PROVIDER_REGION_SETTINGS)[number]['provider']
    >
  | Exclude<
      (typeof PROVIDER_REGION_SETTINGS)[number]['provider'],
      RegionalProviderId
    >
>;

function regionSet(stores: SettingsStores, provider: string) {
  return Effect.gen(function* () {
    const region = providerRegionSetting(provider);
    // Region keys are catalog-modeled, so the default comes from the entry's
    // schema, which the catalog builds from the region's China default.
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
    const key = providerEndpointKey(provider);
    // Catalog-modeled (see PROVIDER_ENDPOINT_SETTINGS in stateSettings.ts).
    return key ? yield* readSettingFrom<string>(stores, key) : '';
  });
}

export function supportsCustomEndpoint(provider: string): boolean {
  return providerEndpointKey(provider) !== undefined;
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
    const region = findModelProviderPlugin(provider)?.region;
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
    const region = findModelProviderPlugin(provider)?.region;
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
