import { describe, expect, it } from 'vitest';
import { MODEL_CONFIGS, ModelProvider } from 'llm-zoo';

import { resolveModelCompatibilityKey } from '@agent/runtime/modelRoutes';

import {
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
import { FakeStateStore } from '@test/support/FakePlatform';

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
  const globalState = new FakeStateStore();

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
      resolveModelCompatibilityKey(
        MODEL_CONFIGS.kimiCoding,
        globalState,
        false,
      ),
    ).toBe('Kimi');
  });

  it('routes dual-backend kimi3 through OpenRouter when the toggle is on', () => {
    // The factory's Kimi Code reroute is guarded on compat key
    // 'Kimi'. Because kimi3 carries an openrouterFullName, an
    // OpenRouter-enabled session persists as 'OpenRouterNative'
    // instead — so a resumed 'Kimi' kimi3 was, by construction, a
    // direct (non-OpenRouter) session, which is why the resume path's
    // useOpenRouter=false is correct.
    expect(
      resolveModelCompatibilityKey(MODEL_CONFIGS.kimi3, globalState, false),
    ).toBe('Kimi');
    expect(
      resolveModelCompatibilityKey(MODEL_CONFIGS.kimi3, globalState, true),
    ).toBe('OpenRouterNative');
  });

  it('does not divert other moonshot models off their normal routes', () => {
    expect(resolveModelApiKeyProvider(MODEL_CONFIGS.kimi25T, false)).toBe(
      'moonshot',
    );
  });
});
