/**
 * Kimi Code managed-service models.
 *
 * TeXRA uses Kimi Code's OpenAI-compatible endpoint. Protocol selection is a
 * transport concern rather than a second set of user-facing model entries.
 *
 * The managed service exposes three model IDs:
 * - k3
 * - kimi-for-coding
 * - kimi-for-coding-highspeed
 *
 * These entries retain Moonshot as the underlying model family, while one
 * direct-access profile owns their Kimi Code credential, endpoint, handler,
 * model-source grouping, and relay/OpenRouter policy.
 */
import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelProvider,
  type ModelConfig,
} from 'llm-zoo';
import type { DirectModelRoutingConfig } from '@model/openRouterRouting';

const KIMI_CODE_OPENAI_BASE_URL = 'https://api.kimi.com/coding/v1';

/** Recognized Kimi Code model IDs. */
const KIMI_CODE_MODEL_IDS = [
  'k3',
  'kimi-for-coding',
  'kimi-for-coding-highspeed',
] as const;

type KimiCodeModelId = (typeof KIMI_CODE_MODEL_IDS)[number];

/**
 * Marker fields that live on top of llm-zoo's ModelConfig. They are consumed by
 * the model handler and by availability checks; TypeScript sees them via the
 * local {@link KimiCodeModelConfig} type and casts at the boundary.
 */
interface KimiCodeModelConfig extends ModelConfig, DirectModelRoutingConfig {
  readonly directAccess: NonNullable<DirectModelRoutingConfig['directAccess']>;
}

const KIMI_CODE_CONTEXT_WINDOW = 262_144;
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

/**
 * Build a Kimi Code model config on the managed service's direct route.
 */
function buildKimiCodeModelConfig(
  texraId: string,
  modelId: KimiCodeModelId,
  label: string,
  contextWindow: number,
): KimiCodeModelConfig {
  return {
    name: texraId,
    fullName: modelId,
    shortName: modelId,
    provider: ModelProvider.MOONSHOT,
    label,
    contextWindow,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    inputPrice: 0,
    outputPrice: 0,
    openRouterOnly: false,
    directAccess: {
      source: 'kimiCode',
      credential: 'kimiCode',
      baseUrl: KIMI_CODE_OPENAI_BASE_URL,
      handlerProfile: 'openai-reasoning',
      allowOpenRouter: false,
      allowRelay: false,
    },
    capabilities: {
      ...DEFAULT_MODEL_CAPABILITIES,
      supportsReasoning: true,
      supportsFunctionCalling: true,
      supportsVision: true,
      supportsTokenCounting: false,
    },
  } satisfies KimiCodeModelConfig;
}

/**
 * Static registry of Kimi Code models. These are merged into the runtime model
 * registry so they appear in model selection and can be requested by id.
 */
export const KIMI_CODE_MODEL_CONFIGS: Readonly<
  Record<string, KimiCodeModelConfig>
> = {
  kimiCodeK3: buildKimiCodeModelConfig(
    'kimiCodeK3',
    'k3',
    'Kimi Code K3',
    KIMI_CODE_CONTEXT_WINDOW,
  ),
  kimiCodeCoding: buildKimiCodeModelConfig(
    'kimiCodeCoding',
    'kimi-for-coding',
    'Kimi Code K2.7',
    KIMI_CODE_CONTEXT_WINDOW,
  ),
  kimiCodeCodingFast: buildKimiCodeModelConfig(
    'kimiCodeCodingFast',
    'kimi-for-coding-highspeed',
    'Kimi Code K2.7 HighSpeed',
    KIMI_CODE_CONTEXT_WINDOW,
  ),
};
