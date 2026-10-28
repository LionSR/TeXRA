/**
 * The settings the harness keeps over the llm provider catalog: the
 * custom-endpoint setting of each provider with an HTTP endpoint of its own, and the
 * China-region toggle of each provider with two platforms, with the toggle's
 * default and its Models tab control copy. The catalog (`@texra-ai/llm`)
 * owns the provider data; these rows are the host's, read into
 * `RouteFacts.endpoints` by `readModelSettings` and catalogued in
 * `stateSettings.ts`. These rows own the setting keys; readers name the
 * path.
 *
 * Plain data with no import of the catalog: the settings catalog is reachable
 * from stored shapes, which the llm package may not own. The rows cover the
 * catalog exactly, which `modelSettings.ts` checks at compile time.
 */

/** A provider's custom-endpoint row; its setting key is `texra.endpoint.<id>`. */
const endpointRow = <const Id extends string>(id: Id, displayName: string) => ({
  id,
  displayName,
  endpointKey: `texra.endpoint.${id}` as const,
});

/** The providers with a custom-endpoint setting, in catalog order. */
export const PROVIDER_ENDPOINT_STATE_ENTRIES = [
  endpointRow('openai', 'OpenAI'),
  endpointRow('anthropic', 'Anthropic'),
  endpointRow('google', 'Google'),
  endpointRow('xai', 'xAI'),
  endpointRow('deepseek', 'DeepSeek'),
  endpointRow('moonshot', 'Moonshot'),
  endpointRow('dashscope', 'Qwen'),
  endpointRow('minimax', 'MiniMax'),
  endpointRow('glm', 'GLM'),
  endpointRow('meta', 'Meta'),
] as const;

/** The China-region toggles, in catalog order. "Set" is the China region. */
export const PROVIDER_REGION_SETTINGS = [
  {
    // China is the default since moonshot.cn is the primary platform; when
    // toggled off (international), keys come from platform.moonshot.ai. Keys
    // are platform-specific — a .cn key does not work on .ai.
    provider: 'moonshot',
    key: 'texra.moonshot.useChina',
    default: true,
    control: {
      label: 'Kimi/Moonshot China region',
      description:
        'Use the China endpoint (api.moonshot.cn) instead of international (api.moonshot.ai). Enabled by default. Keys are platform-specific — get international keys at platform.moonshot.ai.',
      warning:
        'A platform.moonshot.cn key does not work with the international endpoint, and vice versa.',
      warningUrl: 'https://platform.moonshot.ai/console',
      warningUrlLabel: 'International console',
    },
  },
  {
    provider: 'dashscope',
    key: 'texra.dashscope.useChina',
    default: false,
    control: {
      label: 'Qwen China region (Bailian)',
      description:
        'Use the China region endpoint (dashscope.aliyuncs.com) instead of international (dashscope-intl.aliyuncs.com). Display name switches to "Bailian".',
    },
  },
  {
    provider: 'minimax',
    key: 'texra.minimax.useChina',
    default: false,
    control: {
      label: 'MiniMax China region',
      description:
        'Use the China region endpoint (api.minimax.cn) instead of international (api.minimax.io). API keys are region-specific — you must obtain a key from the matching region.',
      warning:
        'International keys do not work with the China endpoint, and vice versa. Coding Plan keys are also region-specific.',
      warningUrl: 'https://platform.minimax.io/',
      warningUrlLabel: 'Get API key',
    },
  },
  {
    // China is the default since bigmodel.cn is the primary platform; when
    // toggled off (international), the key URL is z.ai.
    provider: 'glm',
    key: 'texra.glm.useChina',
    default: true,
    control: {
      label: 'GLM China region',
      description:
        'Use the China region endpoint (open.bigmodel.cn) instead of international (api.z.ai). Enabled by default. API keys work with either endpoint.',
      warningUrl: 'https://open.bigmodel.cn/',
      warningUrlLabel: 'BigModel console',
    },
  },
] as const;

/** The custom-endpoint setting key of a provider, if it offers one. */
export function providerEndpointKey(
  provider: string,
): (typeof PROVIDER_ENDPOINT_STATE_ENTRIES)[number]['endpointKey'] | undefined {
  return PROVIDER_ENDPOINT_STATE_ENTRIES.find((entry) => entry.id === provider)
    ?.endpointKey;
}

/** The region toggle of a provider, if the provider has two platforms. */
export function providerRegionSetting(
  provider: string,
): (typeof PROVIDER_REGION_SETTINGS)[number] | undefined {
  return PROVIDER_REGION_SETTINGS.find((entry) => entry.provider === provider);
}
