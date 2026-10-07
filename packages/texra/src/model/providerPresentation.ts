/**
 * What a user sees about a model provider beyond its own name: the page that
 * issues its API keys and, for a provider with a China and an international
 * platform, the name and key page of the platform the region toggle picks.
 * Keys are platform-specific (a moonshot.cn key does not work on
 * moonshot.ai), so the key page follows the same toggle the endpoint does.
 */
import { Effect } from 'effect';

import {
  providerDisplayName,
  type ApiKeyProviderId,
  type RegionalProviderId,
} from '@texra-ai/llm';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { providerRegionSetting } from '@shared/state/providerSettings';
import { useChinaRegion } from '@utils/config/providerConfig';
import type { StateReadFailed } from '@texra-ai/harness';

/** A value that differs between a provider's two platforms. */
interface Regional {
  readonly china: string;
  readonly international: string;
}

/** Each key provider's key page; a regional provider names one per platform. */
const KEY_PAGES: {
  readonly [P in ApiKeyProviderId]: P extends RegionalProviderId
    ? Regional
    : string;
} = {
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/',
  google: 'https://aistudio.google.com/app/apikey',
  xai: 'https://console.x.ai/',
  deepseek: 'https://platform.deepseek.com/api_keys',
  moonshot: {
    china: 'https://platform.moonshot.cn/console',
    international: 'https://platform.moonshot.ai/console',
  },
  dashscope: {
    china: 'https://bailian.console.aliyun.com/',
    international: 'https://dashscope.aliyun.com/api-console/',
  },
  minimax: {
    china: 'https://platform.minimaxi.com/',
    international: 'https://platform.minimax.io/',
  },
  glm: {
    china: 'https://open.bigmodel.cn/',
    international: 'https://z.ai/',
  },
  meta: 'https://dev.meta.ai/',
  openRouter: 'https://openrouter.ai/keys',
  kimiCode: 'https://www.kimi.com/code/console',
};

const KEY_PAGE_BY_PROVIDER = new Map<string, string | Regional>(
  Object.entries(KEY_PAGES),
);

/** Providers whose China platform goes by another name. */
const CHINA_PLATFORM_NAMES = new Map<string, string>([
  ['dashscope', 'Bailian'],
]);

/**
 * The name a provider goes by on the platform its region toggle picks:
 * Qwen's China platform is Bailian. Every other provider keeps its own name.
 */
export function getProviderDisplayName(
  stores: SettingsStores,
  provider: string,
): Effect.Effect<string, StateReadFailed> {
  return Effect.gen(function* () {
    const chinaName = CHINA_PLATFORM_NAMES.get(provider);
    if (chinaName === undefined) return providerDisplayName(provider);
    return (yield* useChinaRegion(stores, provider))
      ? chinaName
      : providerDisplayName(provider);
  });
}

/**
 * The page where a user obtains an API key for a provider, or `undefined` for
 * a provider without one. A regional provider's page is the one of the
 * platform `chinaRegion` names, or of its region toggle's default platform
 * when the caller holds no setting.
 */
export function providerKeyUrl(
  provider: string,
  chinaRegion: boolean = providerRegionSetting(provider)?.default ?? false,
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
