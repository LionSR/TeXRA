/**
 * Kimi Code managed-service models.
 *
 * Kimi Code membership provides an API Key that works with two protocols:
 * - OpenAI-compatible: https://api.kimi.com/coding/v1
 * - Anthropic-compatible: https://api.kimi.com/coding/
 *
 * Both protocols accept the same three model IDs:
 * - k3
 * - kimi-for-coding
 * - kimi-for-coding-highspeed
 *
 * These entries piggy-back on the Moonshot provider slot (the underlying models
 * are Kimi models) but carry a custom `baseUrl` and `apiKeyProvider` so they
 * authenticate with the Kimi Code API key and route to the Kimi Code endpoints
 * instead of the pay-as-you-go Moonshot Platform.
 */
import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelProvider,
  type ModelConfig,
} from 'llm-zoo';

const KIMI_CODE_OPENAI_BASE_URL = 'https://api.kimi.com/coding/v1';
const KIMI_CODE_ANTHROPIC_BASE_URL = 'https://api.kimi.com/coding/';

/** Recognized Kimi Code model IDs. */
const KIMI_CODE_MODEL_IDS = [
  'k3',
  'kimi-for-coding',
  'kimi-for-coding-highspeed',
] as const;

type KimiCodeModelId = (typeof KIMI_CODE_MODEL_IDS)[number];

type KimiCodeProtocol = 'openai' | 'anthropic';

/**
 * Marker fields that live on top of llm-zoo's ModelConfig. They are consumed by
 * the model handler and by availability checks; TypeScript sees them via the
 * local {@link KimiCodeModelConfig} type and casts at the boundary.
 */
interface KimiCodeModelConfig extends ModelConfig {
  /** Which API-key namespace holds the Kimi Code key. */
  readonly apiKeyProvider: 'kimiCode';
  /** Which Kimi Code wire protocol this entry uses. */
  readonly kimiCodeProtocol: KimiCodeProtocol;
}

const K3_CONTEXT_WINDOW = 1_048_576;
const K27_CONTEXT_WINDOW = 262_144;
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

/**
 * Build a Kimi Code model config for one protocol.
 * TeXRA model ids encode the protocol so users can choose explicitly.
 */
function buildKimiCodeModelConfig(
  texraId: string,
  modelId: KimiCodeModelId,
  protocol: KimiCodeProtocol,
  label: string,
  contextWindow: number,
  supportsReasoning: boolean,
): KimiCodeModelConfig {
  const baseUrl =
    protocol === 'openai'
      ? KIMI_CODE_OPENAI_BASE_URL
      : KIMI_CODE_ANTHROPIC_BASE_URL;

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
    baseUrl,
    apiKeyProvider: 'kimiCode',
    kimiCodeProtocol: protocol,
    capabilities: {
      ...DEFAULT_MODEL_CAPABILITIES,
      supportsReasoning,
      supportsFunctionCalling: true,
      supportsVision: true,
      supportsTokenCounting: false,
    },
  } as KimiCodeModelConfig;
}

/**
 * Static registry of Kimi Code models. These are merged into the runtime model
 * registry so they appear in model selection and can be requested by id.
 */
export const KIMI_CODE_MODEL_CONFIGS: Record<string, KimiCodeModelConfig> = {
  // OpenAI-compatible entries
  kimiCodeK3: buildKimiCodeModelConfig(
    'kimiCodeK3',
    'k3',
    'openai',
    'Kimi Code K3 (OpenAI)',
    K3_CONTEXT_WINDOW,
    true,
  ),
  kimiCodeCoding: buildKimiCodeModelConfig(
    'kimiCodeCoding',
    'kimi-for-coding',
    'openai',
    'Kimi Code K2.7 (OpenAI)',
    K27_CONTEXT_WINDOW,
    true,
  ),
  kimiCodeCodingFast: buildKimiCodeModelConfig(
    'kimiCodeCodingFast',
    'kimi-for-coding-highspeed',
    'openai',
    'Kimi Code K2.7 HighSpeed (OpenAI)',
    K27_CONTEXT_WINDOW,
    true,
  ),
  // Anthropic-compatible entries
  kimiCodeK3Anthropic: buildKimiCodeModelConfig(
    'kimiCodeK3Anthropic',
    'k3',
    'anthropic',
    'Kimi Code K3 (Anthropic)',
    K3_CONTEXT_WINDOW,
    true,
  ),
  kimiCodeCodingAnthropic: buildKimiCodeModelConfig(
    'kimiCodeCodingAnthropic',
    'kimi-for-coding',
    'anthropic',
    'Kimi Code K2.7 (Anthropic)',
    K27_CONTEXT_WINDOW,
    true,
  ),
  kimiCodeCodingFastAnthropic: buildKimiCodeModelConfig(
    'kimiCodeCodingFastAnthropic',
    'kimi-for-coding-highspeed',
    'anthropic',
    'Kimi Code K2.7 HighSpeed (Anthropic)',
    K27_CONTEXT_WINDOW,
    true,
  ),
};
