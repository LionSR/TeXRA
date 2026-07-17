// Third-party imports
import { describe, expect, it } from 'vitest';
import { MODEL_CONFIGS, ModelProvider } from 'llm-zoo';

// Local imports - agent runtime
import { modelHandlerCompatibilityKey } from '@agent/runtime/ModelFactory';

// Local imports - model
import {
  KIMI_CODE_ANTHROPIC_BASE_URL,
  KIMI_CODE_MODEL_CONFIGS,
  KIMI_CODE_OPENAI_BASE_URL,
  isKimiCodeModelConfig,
} from '@model/kimiCodeModels';
import { resolveModelApiKeyProvider } from '@model/openRouterRouting';
import { getRuntimeModelConfig } from '@model/runtimeModelRegistry';
import {
  resolveSetupModel,
  SETUP_MODEL_BY_PROVIDER,
} from '@model/setupModelDefaults';

describe('Kimi Code model registry', () => {
  it('exposes six TeXRA ids covering both protocols', () => {
    expect(Object.keys(KIMI_CODE_MODEL_CONFIGS).sort()).toEqual(
      [
        'kimiCodeK3',
        'kimiCodeCoding',
        'kimiCodeCodingFast',
        'kimiCodeK3Anthropic',
        'kimiCodeCodingAnthropic',
        'kimiCodeCodingFastAnthropic',
      ].sort(),
    );
  });

  it.each([
    ['kimiCodeK3', 'k3', 'openai', KIMI_CODE_OPENAI_BASE_URL],
    ['kimiCodeCoding', 'kimi-for-coding', 'openai', KIMI_CODE_OPENAI_BASE_URL],
    [
      'kimiCodeCodingFast',
      'kimi-for-coding-highspeed',
      'openai',
      KIMI_CODE_OPENAI_BASE_URL,
    ],
    ['kimiCodeK3Anthropic', 'k3', 'anthropic', KIMI_CODE_ANTHROPIC_BASE_URL],
    [
      'kimiCodeCodingAnthropic',
      'kimi-for-coding',
      'anthropic',
      KIMI_CODE_ANTHROPIC_BASE_URL,
    ],
    [
      'kimiCodeCodingFastAnthropic',
      'kimi-for-coding-highspeed',
      'anthropic',
      KIMI_CODE_ANTHROPIC_BASE_URL,
    ],
  ])(
    'maps %s to model %s via %s protocol',
    (texraId, fullName, protocol, baseUrl) => {
      const config = KIMI_CODE_MODEL_CONFIGS[texraId];
      expect(config).toBeDefined();
      expect(config.fullName).toBe(fullName);
      expect(config.kimiCodeProtocol).toBe(protocol);
      expect(config.baseUrl).toBe(baseUrl);
      expect(config.provider).toBe(ModelProvider.MOONSHOT);
      expect(config.apiKeyProvider).toBe('kimiCode');
    },
  );

  it('resolves Kimi Code entries through the runtime registry', () => {
    expect(getRuntimeModelConfig('kimiCodeK3')).toBe(
      KIMI_CODE_MODEL_CONFIGS.kimiCodeK3,
    );
    expect(getRuntimeModelConfig('kimiCodeCodingAnthropic')).toBe(
      KIMI_CODE_MODEL_CONFIGS.kimiCodeCodingAnthropic,
    );
  });

  it('keeps ordinary static registry lookups unchanged', () => {
    expect(getRuntimeModelConfig('kimi25T')).toBe(MODEL_CONFIGS.kimi25T);
  });

  it('identifies Kimi Code configs via the type guard', () => {
    expect(isKimiCodeModelConfig(KIMI_CODE_MODEL_CONFIGS.kimiCodeK3)).toBe(
      true,
    );
    expect(isKimiCodeModelConfig(MODEL_CONFIGS.kimi25T)).toBe(false);
    expect(isKimiCodeModelConfig(undefined)).toBe(false);
  });
});

describe('Kimi Code routing', () => {
  it('resolves the API key provider to kimiCode', () => {
    expect(
      resolveModelApiKeyProvider(KIMI_CODE_MODEL_CONFIGS.kimiCodeK3, false),
    ).toBe('kimiCode');
    expect(
      resolveModelApiKeyProvider(
        KIMI_CODE_MODEL_CONFIGS.kimiCodeK3Anthropic,
        false,
      ),
    ).toBe('kimiCode');
  });

  it('routes OpenAI-protocol models through the Moonshot/Kimi handler', () => {
    // OpenAI-protocol Kimi Code entries ride the Moonshot provider slot; the
    // Kimi handler is OpenAI-compatible and applies the Kimi Code base URL.
    expect(
      modelHandlerCompatibilityKey(
        KIMI_CODE_MODEL_CONFIGS.kimiCodeK3,
        false,
        false,
      ),
    ).toBe('ModelHandlerKimi');
  });

  it('routes Anthropic-protocol models through the Anthropic handler', () => {
    expect(
      modelHandlerCompatibilityKey(
        KIMI_CODE_MODEL_CONFIGS.kimiCodeK3Anthropic,
        false,
        false,
      ),
    ).toBe('ModelHandlerAnthropic');
  });
});

describe('Kimi Code setup defaults', () => {
  it('includes a setup model for the kimiCode provider', () => {
    expect(SETUP_MODEL_BY_PROVIDER.kimiCode).toBe('kimiCodeK3');
  });

  it('resolves the preferred setup model to a live Kimi Code entry', () => {
    expect(resolveSetupModel('kimiCode')).toBe('kimiCodeK3');
  });
});
