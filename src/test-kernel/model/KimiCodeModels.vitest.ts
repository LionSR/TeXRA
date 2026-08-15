import { describe, expect, it } from 'vitest';
import { MODEL_CONFIGS, ModelProvider } from 'llm-zoo';

import { resolveModelHandlerCompatibilityKey } from '@agent/runtime/ModelFactory';

import { kimiCodeWireModelId } from '@model/kimiCodeSubscriptionRouting';
import {
  allowsModelRelay,
  resolveModelApiKeyProvider,
  resolveModelSource,
  shouldRouteModelThroughOpenRouter,
} from '@model/openRouterRouting';
import { getRuntimeModelConfig } from '@model/runtimeModelRegistry';
import { SETUP_MODEL_BY_PROVIDER } from '@model/setupModelDefaults';
import {
  isKimiCodeExclusiveModel,
  isKimiCodeExclusiveRetryModel,
  isKimiCodeSubscriptionRetryBlocked,
  isKimiSubscriptionEligible,
} from '@shared/model/kimiCodeRetryGate';

describe('Kimi Code model registry', () => {
  it.each([
    ['kimiCoding', 'kimi-for-coding'],
    ['kimiCodingFast', 'kimi-for-coding-highspeed'],
  ])(
    'registers exclusive plan alias %s with wire id %s',
    (texraId, fullName) => {
      const config = MODEL_CONFIGS[texraId];
      expect(config).toBeDefined();
      expect(config.fullName).toBe(fullName);
      expect(config.provider).toBe(ModelProvider.MOONSHOT);
      expect(config.contextWindow).toBe(262_144);
      expect(config.baseUrl).toBe('https://api.kimi.com/coding/v1');
      expect(isKimiCodeExclusiveModel(config)).toBe(true);
      expect(resolveModelSource(config)).toBe('kimiCode');
      // Plan aliases already use the wire id as fullName — no rename.
      expect(kimiCodeWireModelId(config)).toBe(fullName);
    },
  );

  it('flags kimi3 as dual-backend (subscription-eligible, not exclusive)', () => {
    const config = MODEL_CONFIGS.kimi3;
    expect(isKimiSubscriptionEligible(config)).toBe(true);
    expect(isKimiCodeExclusiveModel(config)).toBe(false);
    // The open platform stays its home: source and key owner are moonshot.
    expect(resolveModelSource(config)).toBe(ModelProvider.MOONSHOT);
    expect(resolveModelApiKeyProvider(config, false)).toBe('moonshot');
    // On the coding endpoint the wire id is `k3`.
    expect(kimiCodeWireModelId(config)).toBe('k3');
  });

  it('resolves plan aliases through the runtime registry like any model', () => {
    expect(getRuntimeModelConfig('kimiCoding')).toBe(MODEL_CONFIGS.kimiCoding);
    expect(getRuntimeModelConfig('kimi25T')).toBe(MODEL_CONFIGS.kimi25T);
  });
});

describe('Kimi Code exclusivity single-source', () => {
  it('keeps the retry model-id gate aligned with the shared field predicate', () => {
    for (const [id, config] of Object.entries(MODEL_CONFIGS)) {
      expect(isKimiCodeExclusiveRetryModel(id)).toBe(
        isKimiCodeExclusiveModel(config),
      );
    }
    expect(isKimiCodeExclusiveRetryModel(undefined)).toBe(false);
    expect(isKimiCodeExclusiveRetryModel('not-a-registered-model')).toBe(false);
  });

  it('blocks the personal-key switch only for exclusive plan-quota exhaustion', () => {
    expect(
      isKimiCodeSubscriptionRetryBlocked(
        'kimiCoding',
        'kimi-code-subscription',
      ),
    ).toBe(true);
    expect(
      isKimiCodeSubscriptionRetryBlocked('kimiCoding', 'upstream-credit'),
    ).toBe(false);
    expect(
      isKimiCodeSubscriptionRetryBlocked('kimi3', 'kimi-code-subscription'),
    ).toBe(false);
    expect(
      isKimiCodeSubscriptionRetryBlocked(undefined, 'kimi-code-subscription'),
    ).toBe(false);
  });
});

describe('Kimi Code routing', () => {
  it('keeps the direct Kimi Code route when OpenRouter is globally enabled', () => {
    expect(resolveModelApiKeyProvider(MODEL_CONFIGS.kimiCoding, false)).toBe(
      'kimiCode',
    );
    expect(resolveModelApiKeyProvider(MODEL_CONFIGS.kimiCoding, true)).toBe(
      'kimiCode',
    );
    expect(
      shouldRouteModelThroughOpenRouter(MODEL_CONFIGS.kimiCoding, true),
    ).toBe(false);
  });

  it('uses the shared Kimi handler', () => {
    expect(
      resolveModelHandlerCompatibilityKey(
        MODEL_CONFIGS.kimiCoding,
        false,
        false,
      ),
    ).toBe('ModelHandlerKimi');
  });

  it('routes dual-backend kimi3 through OpenRouter when the toggle is on', () => {
    // The factory's Kimi Code reroute is guarded on compat key
    // 'ModelHandlerKimi'. Because kimi3 carries an openrouterFullName, an
    // OpenRouter-enabled session persists as 'ModelHandlerOpenRouterNative'
    // instead — so a resumed 'ModelHandlerKimi' kimi3 was, by construction, a
    // direct (non-OpenRouter) session, which is why the resume path's
    // useOpenRouter=false is correct.
    expect(
      resolveModelHandlerCompatibilityKey(MODEL_CONFIGS.kimi3, false, false),
    ).toBe('ModelHandlerKimi');
    expect(
      resolveModelHandlerCompatibilityKey(MODEL_CONFIGS.kimi3, true, false),
    ).toBe('ModelHandlerOpenRouterNative');
  });

  it('never sends managed-service credentials through the TeXRA relay', () => {
    expect(allowsModelRelay(MODEL_CONFIGS.kimiCoding)).toBe(false);
    expect(allowsModelRelay(MODEL_CONFIGS.kimiCodingFast)).toBe(false);
  });

  it('does not divert other moonshot models off their normal routes', () => {
    expect(allowsModelRelay(MODEL_CONFIGS.kimi3)).toBe(true);
    expect(resolveModelApiKeyProvider(MODEL_CONFIGS.kimi25T, false)).toBe(
      'moonshot',
    );
  });
});

describe('Kimi Code setup defaults', () => {
  it('includes a setup model for the kimiCode provider', () => {
    expect(SETUP_MODEL_BY_PROVIDER.kimiCode).toBe('kimiCoding');
  });
});
