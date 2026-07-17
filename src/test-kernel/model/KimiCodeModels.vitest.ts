// Third-party imports
import { describe, expect, it } from 'vitest';
import { MODEL_CONFIGS, ModelProvider } from 'llm-zoo';

// Local imports - agent runtime
import { modelHandlerCompatibilityKey } from '@agent/runtime/ModelFactory';

// Local imports - model
import { KIMI_CODE_MODEL_CONFIGS } from '@model/kimiCodeModels';
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
    ['kimiCodeK3', 'k3', 'openai', 'https://api.kimi.com/coding/v1'],
    [
      'kimiCodeCoding',
      'kimi-for-coding',
      'openai',
      'https://api.kimi.com/coding/v1',
    ],
    [
      'kimiCodeCodingFast',
      'kimi-for-coding-highspeed',
      'openai',
      'https://api.kimi.com/coding/v1',
    ],
    ['kimiCodeK3Anthropic', 'k3', 'anthropic', 'https://api.kimi.com/coding/'],
    [
      'kimiCodeCodingAnthropic',
      'kimi-for-coding',
      'anthropic',
      'https://api.kimi.com/coding/',
    ],
    [
      'kimiCodeCodingFastAnthropic',
      'kimi-for-coding-highspeed',
      'anthropic',
      'https://api.kimi.com/coding/',
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
    expect(
      resolveModelApiKeyProvider(KIMI_CODE_MODEL_CONFIGS.kimiCodeK3, true),
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
    expect(
      modelHandlerCompatibilityKey(
        KIMI_CODE_MODEL_CONFIGS.kimiCodeK3,
        true,
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
    expect(
      modelHandlerCompatibilityKey(
        KIMI_CODE_MODEL_CONFIGS.kimiCodeK3Anthropic,
        true,
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
