/**
 * What a user sees about a model provider beyond its own name: the page that
 * issues its API keys and, for a provider with a China and an international
 * platform, the name and key page of the platform the region toggle picks.
 * Keys are platform-specific (a moonshot.cn key does not work on
 * moonshot.ai), so the key page follows the same toggle the endpoint does.
 */
import {
  Settings,
  type SettingsStores,
  type StateReadFailed,
} from '@texra-ai/harness/plugins';
import { Effect } from 'effect';

import { providerDisplayName, type ApiKeyProviderId } from '@texra-ai/llm';
import { providerRegionSetting } from '@texra-ai/harness/schemas';
import { KEY_PAGES } from '@texra/shared/model/providerKeyPages';
import { TEXRA_SETTINGS } from '@texra/shared/settings/texraSettings';

/** Whether `provider`'s region toggle picks its China platform. */
function useChinaRegion(
  stores: SettingsStores,
  provider: string,
): Effect.Effect<boolean, StateReadFailed> {
  const toggle = providerRegionSetting(provider);
  return toggle ? Settings.get(stores, toggle) : Effect.succeed(false);
}

/** Whether `provider`'s region toggle picks its China platform while unset. */
function regionByDefault(provider: string): boolean {
  const toggle = providerRegionSetting(provider);
  return toggle ? Settings.defaultOf(TEXRA_SETTINGS.catalog, toggle) : false;
}

const KEY_PAGE_BY_PROVIDER = new Map<
  string,
  (typeof KEY_PAGES)[ApiKeyProviderId]
>(Object.entries(KEY_PAGES));

/** Providers whose China platform goes by another name. */
const CHINA_PLATFORM_NAMES = new Map<string, string>([
  ['dashscope', 'Bailian'],
]);

/**
 * The name a provider goes by on the platform its region toggle picks:
 * Qwen's China platform is Bailian. Every other provider keeps its own name.
 */
export const getProviderDisplayName = Effect.fn('getProviderDisplayName')(
  function* (
    stores: SettingsStores,
    provider: string,
  ): Effect.fn.Return<string, StateReadFailed> {
    const chinaName = CHINA_PLATFORM_NAMES.get(provider);
    if (chinaName === undefined) return providerDisplayName(provider);
    return (yield* useChinaRegion(stores, provider))
      ? chinaName
      : providerDisplayName(provider);
  },
);

/**
 * The page where a user obtains an API key for a provider, or `undefined` for
 * a provider without one. A regional provider's page is the one of the
 * platform `chinaRegion` names, or of its region toggle's default platform
 * when the caller holds no setting.
 */
export function providerKeyUrl(
  provider: string,
  chinaRegion: boolean = regionByDefault(provider),
): string | undefined {
  const page = KEY_PAGE_BY_PROVIDER.get(provider);
  if (page === undefined || typeof page === 'string') return page;
  return chinaRegion ? page.china : page.international;
}

/** {@link providerKeyUrl} on the platform the provider's region toggle picks. */
export function getProviderKeyUrl(
  stores: SettingsStores,
  provider: string,
): Effect.Effect<string | undefined, StateReadFailed> {
  return useChinaRegion(stores, provider).pipe(
    Effect.map((chinaRegion) => providerKeyUrl(provider, chinaRegion)),
  );
}
