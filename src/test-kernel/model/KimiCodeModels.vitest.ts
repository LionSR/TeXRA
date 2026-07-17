// Third-party imports
import { describe, expect, it } from 'vitest';
import { MODEL_CONFIGS, ModelProvider } from 'llm-zoo';

// Local imports - agent runtime
import { modelHandlerCompatibilityKey } from '@agent/runtime/ModelFactory';

// Local imports - model
import { KIMI_CODE_MODEL_CONFIGS } from '@model/kimiCodeModels';
import {
  allowsModelRelay,
  resolveDirectModelBaseUrl,
  resolveModelApiKeyProvider,
  resolveModelSource,
  shouldRouteModelThroughOpenRouter,
} from '@model/openRouterRouting';
import { getRuntimeModelConfig } from '@model/runtimeModelRegistry';
import {
  resolveSetupModel,
  SETUP_MODEL_BY_PROVIDER,
} from '@model/setupModelDefaults';

describe('Kimi Code model registry', () => {
  it('exposes one entry for each user-selectable model', () => {
    expect(Object.keys(KIMI_CODE_MODEL_CONFIGS).toSorted()).toEqual([
      'kimiCodeCoding',
      'kimiCodeCodingFast',
      'kimiCodeK3',
    ]);
  });

  it.each([
    ['kimiCodeK3', 'k3'],
    ['kimiCodeCoding', 'kimi-for-coding'],
    ['kimiCodeCodingFast', 'kimi-for-coding-highspeed'],
  ])('maps %s to managed model %s', (texraId, fullName) => {
    const config = KIMI_CODE_MODEL_CONFIGS[texraId];
    expect(config).toBeDefined();
    expect(config.fullName).toBe(fullName);
    expect(config.provider).toBe(ModelProvider.MOONSHOT);
    expect(config.contextWindow).toBe(262_144);
    expect(resolveModelSource(config)).toBe('kimiCode');
    expect(resolveDirectModelBaseUrl(config)).toBe(
      'https://api.kimi.com/coding/v1',
    );
  });

  it('resolves Kimi Code entries through the runtime registry', () => {
    expect(getRuntimeModelConfig('kimiCodeK3')).toBe(
      KIMI_CODE_MODEL_CONFIGS.kimiCodeK3,
    );
    expect(getRuntimeModelConfig('kimiCodeCodingFast')).toBe(
      KIMI_CODE_MODEL_CONFIGS.kimiCodeCodingFast,
    );
  });

  it('keeps ordinary static registry lookups unchanged', () => {
    expect(getRuntimeModelConfig('kimi25T')).toBe(MODEL_CONFIGS.kimi25T);
  });

  it('exports immutable registry entries', () => {
    const config = KIMI_CODE_MODEL_CONFIGS.kimiCodeK3;
    expect(Object.isFrozen(KIMI_CODE_MODEL_CONFIGS)).toBe(true);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.directAccess)).toBe(true);
    expect(Object.isFrozen(config.capabilities)).toBe(true);
  });
});

describe('Kimi Code routing', () => {
  it('keeps the direct Kimi Code route when OpenRouter is globally enabled', () => {
    expect(
      resolveModelApiKeyProvider(KIMI_CODE_MODEL_CONFIGS.kimiCodeK3, false),
    ).toBe('kimiCode');
    expect(
      resolveModelApiKeyProvider(KIMI_CODE_MODEL_CONFIGS.kimiCodeK3, true),
    ).toBe('kimiCode');
    expect(
      shouldRouteModelThroughOpenRouter(
        KIMI_CODE_MODEL_CONFIGS.kimiCodeK3,
        true,
      ),
    ).toBe(false);
  });

  it('uses the shared Kimi handler', () => {
    expect(
      modelHandlerCompatibilityKey(
        KIMI_CODE_MODEL_CONFIGS.kimiCodeK3,
        false,
        false,
      ),
    ).toBe('ModelHandlerKimi');
  });

  it('never sends managed-service credentials through the TeXRA relay', () => {
    expect(allowsModelRelay(KIMI_CODE_MODEL_CONFIGS.kimiCodeCoding)).toBe(
      false,
    );
  });
});

describe('Kimi Code setup defaults', () => {
  it('includes a setup model for the kimiCode provider', () => {
    expect(SETUP_MODEL_BY_PROVIDER.kimiCode).toBe('kimiCodeCoding');
  });

  it('resolves the preferred setup model to a live Kimi Code entry', () => {
    expect(resolveSetupModel('kimiCode')).toBe('kimiCodeCoding');
  });
});
