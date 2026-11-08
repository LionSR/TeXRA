/**
 * The settings the harness keeps over the llm provider catalog: the
 * custom-endpoint row of each provider with an HTTP endpoint of its own, and
 * the China-region toggle of each provider with two platforms. The catalog
 * (`@texra-ai/llm`) owns the provider data; these rows are the host's, read
 * into `RouteFacts.endpoints` by `readModelSettings` and listed in the
 * settings catalog (`stateSettings.ts`).
 *
 * No import of the llm catalog: the settings catalog is reachable from stored
 * shapes, which the llm package may not own. The rows cover the catalog
 * exactly, which `modelSettings.ts` checks at compile time.
 */

// Third-party imports
import { Effect, Schema } from 'effect';

// Local imports
import type { SettingRow } from '@shared/state/stateSettings';

/** A provider's custom-endpoint row, stored as `<namespace>.endpoint.<id>`. */
const endpointRow = <const Id extends string>(id: Id, displayName: string) =>
  ({
    id,
    key: `endpoint.${id}` as const,
    schema: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(''))),
    title: `${displayName} endpoint`,
    description: `Custom base URL for ${displayName} API requests. Leave empty to use the default endpoint.`,
    slot: 'globalState',
  }) as const satisfies SettingRow<string> & { readonly id: Id };

/** GLM's custom-endpoint row, which also decides whether the Coding Plan
 *  route applies (`readModelSettings`). */
export const GLM_ENDPOINT_SETTING = endpointRow('glm', 'GLM');

/** The providers' custom-endpoint rows, in catalog order. */
export const PROVIDER_ENDPOINT_SETTINGS = [
  endpointRow('openai', 'OpenAI'),
  endpointRow('anthropic', 'Anthropic'),
  endpointRow('google', 'Google'),
  endpointRow('xai', 'xAI'),
  endpointRow('deepseek', 'DeepSeek'),
  endpointRow('moonshot', 'Moonshot'),
  endpointRow('dashscope', 'Qwen'),
  endpointRow('minimax', 'MiniMax'),
  GLM_ENDPOINT_SETTING,
  endpointRow('meta', 'Meta'),
] as const;

/** A China-region toggle: "set" is the China region. */
type RegionSettingRow = SettingRow<boolean> & { readonly provider: string };

// China is the default since moonshot.cn is the primary platform; when
// toggled off (international), keys come from platform.moonshot.ai. Keys
// are platform-specific — a .cn key does not work on .ai.
export const MOONSHOT_REGION_SETTING = {
  provider: 'moonshot',
  key: 'moonshot.useChina',
  schema: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  title: 'Kimi/Moonshot China region',
  description:
    'Use the China endpoint instead of the international one. Enabled by default. Keys are platform-specific: a key from one region does not work on the other.',
  slot: 'globalState',
} as const satisfies RegionSettingRow;

export const DASHSCOPE_REGION_SETTING = {
  provider: 'dashscope',
  key: 'dashscope.useChina',
  schema: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  title: 'Qwen China region (Bailian)',
  description:
    'Use the China region endpoint instead of the international one. Display name switches to "Bailian".',
  slot: 'globalState',
} as const satisfies RegionSettingRow;

export const MINIMAX_REGION_SETTING = {
  provider: 'minimax',
  key: 'minimax.useChina',
  schema: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
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
  schema: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
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
