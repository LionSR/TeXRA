/**
 * The settings the harness keeps over the llm provider catalog: the
 * custom-endpoint row of each provider with an HTTP endpoint of its own, and
 * the China-region toggle of each provider with two platforms. The catalog
 * (`@texra-ai/llm`) owns the provider data; these rows are the host's, read
 * into `RouteFacts.endpoints` by `readModelSettings` and listed in the
 * settings catalog (`stateSettings.ts`). A row's title names the provider
 * as the catalog does. The rows cover the catalog exactly, which
 * `modelSettings.ts` checks at compile time.
 */

// Third-party imports
import { Effect, Schema } from 'effect';
import { providerDisplayName } from '@texra-ai/llm';

// Local imports
import type { SettingRow } from '@shared/state/stateSettings';

/** The schema of a boolean setting: `value` when the key is absent. */
export const booleanWithDefault = (value: boolean) =>
  Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(value)));

/** A provider's custom-endpoint row, stored as `<namespace>.endpoint.<id>`. */
const endpointRow = <const Id extends string>(id: Id) =>
  ({
    id,
    key: `endpoint.${id}` as const,
    schema: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(''))),
    title: `${providerDisplayName(id)} endpoint`,
    description: `Custom base URL for ${providerDisplayName(id)} API requests. Leave empty to use the default endpoint.`,
    slot: 'globalState',
  }) as const satisfies SettingRow<string> & { readonly id: Id };

/** GLM's custom-endpoint row, which also decides whether the Coding Plan
 *  route applies (`readModelSettings`). */
export const GLM_ENDPOINT_SETTING = endpointRow('glm');

/** The providers' custom-endpoint rows, in catalog order. */
export const PROVIDER_ENDPOINT_SETTINGS = [
  endpointRow('openai'),
  endpointRow('anthropic'),
  endpointRow('google'),
  endpointRow('xai'),
  endpointRow('deepseek'),
  endpointRow('moonshot'),
  endpointRow('dashscope'),
  endpointRow('minimax'),
  GLM_ENDPOINT_SETTING,
  endpointRow('meta'),
] as const;

/** A China-region toggle: "set" is the China region. */
type RegionSettingRow = SettingRow<boolean> & { readonly provider: string };

// China is the default since moonshot.cn is the primary platform; when
// toggled off (international), keys come from platform.moonshot.ai. Keys
// are platform-specific — a .cn key does not work on .ai.
export const MOONSHOT_REGION_SETTING = {
  provider: 'moonshot',
  key: 'moonshot.useChina',
  schema: booleanWithDefault(true),
  title: 'Kimi/Moonshot China region',
  description:
    'Use the China endpoint instead of the international one. Enabled by default. Keys are platform-specific: a key from one region does not work on the other.',
  slot: 'globalState',
} as const satisfies RegionSettingRow;

export const DASHSCOPE_REGION_SETTING = {
  provider: 'dashscope',
  key: 'dashscope.useChina',
  schema: booleanWithDefault(false),
  title: 'Qwen China region (Bailian)',
  description:
    'Use the China region endpoint instead of the international one. Display name switches to "Bailian".',
  slot: 'globalState',
} as const satisfies RegionSettingRow;

export const MINIMAX_REGION_SETTING = {
  provider: 'minimax',
  key: 'minimax.useChina',
  schema: booleanWithDefault(false),
  title: 'MiniMax China region',
  description:
    'Use the China region endpoint instead of the international one. API keys are region-specific — you must obtain a key from the matching region.',
  slot: 'globalState',
} as const satisfies RegionSettingRow;

// China is the default since bigmodel.cn is the primary platform; when
// toggled off (international), the key URL is z.ai.
export const GLM_REGION_SETTING = {
  provider: 'glm',
  key: 'glm.useChina',
  schema: booleanWithDefault(true),
  title: 'GLM China region',
  description:
    'Use the China region endpoint instead of the international one. Enabled by default. API keys work with either endpoint.',
  slot: 'globalState',
} as const satisfies RegionSettingRow;

/** The China-region toggles, in catalog order. */
export const PROVIDER_REGION_SETTINGS = [
  MOONSHOT_REGION_SETTING,
  DASHSCOPE_REGION_SETTING,
  MINIMAX_REGION_SETTING,
  GLM_REGION_SETTING,
] as const;

/** A provider's custom-endpoint row, if it offers one. */
export function providerEndpointSetting(
  provider: string,
): (typeof PROVIDER_ENDPOINT_SETTINGS)[number] | undefined {
  return PROVIDER_ENDPOINT_SETTINGS.find((row) => row.id === provider);
}

/** The region toggle of a provider, if the provider has two platforms. */
export function providerRegionSetting(
  provider: string,
): (typeof PROVIDER_REGION_SETTINGS)[number] | undefined {
  return PROVIDER_REGION_SETTINGS.find((row) => row.provider === provider);
}
