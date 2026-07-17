// Third-party imports
import { describe, expect, it } from 'vitest';
import { MODEL_CONFIGS, ModelProvider } from 'llm-zoo';

// Local imports - test support
import { installPlatform } from '@test/support/setupPlatform';

// Local imports - auth
import {
  KIMI_CODE_BASE_URL,
  KIMI_CODE_PREFER_SUBSCRIPTION_KEY,
  KIMI_CODE_SUBSCRIPTION_TOOL_USE_ONLY_KEY,
} from '@auth/kimiCode';

// Local imports - model
import {
  isKimiCodeExclusiveModel,
  isKimiSubscriptionEligible,
  resolveKimiCodeRoute,
  type KimiCodeCredentialFacts,
} from '@model/kimiCodeSubscriptionRouting';
import { AgentCategory } from '@shared/schemas/agent';

const NO_CREDENTIALS: KimiCodeCredentialFacts = {
  oauthReady: false,
  keySet: false,
};
const OAUTH_ONLY: KimiCodeCredentialFacts = { oauthReady: true, keySet: false };
const KEY_ONLY: KimiCodeCredentialFacts = { oauthReady: false, keySet: true };
const BOTH: KimiCodeCredentialFacts = { oauthReady: true, keySet: true };

async function installPreferencePlatform(options?: {
  preferSubscription?: boolean;
  toolUseOnly?: boolean;
}): Promise<void> {
  await installPlatform({
    config: {
      [KIMI_CODE_PREFER_SUBSCRIPTION_KEY]:
        options?.preferSubscription ?? true,
      [KIMI_CODE_SUBSCRIPTION_TOOL_USE_ONLY_KEY]:
        options?.toolUseOnly ?? false,
    },
  });
}

describe('Kimi subscription eligibility', () => {
  it('never resolves a non-Moonshot config eligible', () => {
    expect(
      isKimiSubscriptionEligible({
        provider: ModelProvider.OPENAI,
        kimiSubscription: true,
      }),
    ).toBe(false);
    expect(isKimiSubscriptionEligible(MODEL_CONFIGS.gpt55)).toBe(false);
  });

  it('requires the registry kimiSubscription flag', () => {
    expect(
      isKimiSubscriptionEligible({ provider: ModelProvider.MOONSHOT }),
    ).toBe(false);
    expect(
      isKimiSubscriptionEligible({
        provider: ModelProvider.MOONSHOT,
        kimiSubscription: true,
      }),
    ).toBe(true);
  });

  it('marks a model exclusive only with the pinned coding baseUrl', () => {
    expect(MODEL_CONFIGS.kimiCoding.baseUrl).toBe(KIMI_CODE_BASE_URL);
    expect(isKimiCodeExclusiveModel(MODEL_CONFIGS.kimiCoding)).toBe(true);
    expect(isKimiCodeExclusiveModel(MODEL_CONFIGS.kimi3)).toBe(false);
    // An eligible model pinned elsewhere is not coding-endpoint exclusive.
    expect(
      isKimiCodeExclusiveModel({
        provider: ModelProvider.MOONSHOT,
        kimiSubscription: true,
        baseUrl: 'https://api.moonshot.ai/v1',
      }),
    ).toBe(false);
  });
});

describe('resolveKimiCodeRoute', () => {
  it('returns null for models that are not subscription-eligible', async () => {
    await installPreferencePlatform();

    expect(resolveKimiCodeRoute(MODEL_CONFIGS.gpt55, false, BOTH, undefined)).toBeNull();
  });

  it('routes exclusive models regardless of the OpenRouter toggle', async () => {
    await installPreferencePlatform();

    expect(
      resolveKimiCodeRoute(MODEL_CONFIGS.kimiCoding, true, OAUTH_ONLY, undefined),
    ).toBe('oauth');
    expect(
      resolveKimiCodeRoute(MODEL_CONFIGS.kimiCoding, false, OAUTH_ONLY, undefined),
    ).toBe('oauth');
  });

  it('serves exclusive models by console key even with the preference off', async () => {
    await installPreferencePlatform({ preferSubscription: false });

    expect(
      resolveKimiCodeRoute(MODEL_CONFIGS.kimiCoding, true, KEY_ONLY, undefined),
    ).toBe('api-key');
  });

  it('defers dual-backend models to OpenRouter when the toggle is on', async () => {
    await installPreferencePlatform();

    expect(
      resolveKimiCodeRoute(MODEL_CONFIGS.kimi3, true, BOTH, undefined),
    ).toBeNull();
  });

  it('keeps dual-backend models on the open platform with the preference off', async () => {
    await installPreferencePlatform({ preferSubscription: false });

    expect(
      resolveKimiCodeRoute(MODEL_CONFIGS.kimi3, false, BOTH, undefined),
    ).toBeNull();
  });

  it('prefers the OAuth session over the console key', async () => {
    await installPreferencePlatform();

    expect(resolveKimiCodeRoute(MODEL_CONFIGS.kimi3, false, BOTH, undefined)).toBe(
      'oauth',
    );
  });

  it('falls back to the console key when no OAuth session is routable', async () => {
    await installPreferencePlatform();

    expect(
      resolveKimiCodeRoute(MODEL_CONFIGS.kimi3, false, KEY_ONLY, undefined),
    ).toBe('api-key');
    expect(
      resolveKimiCodeRoute(MODEL_CONFIGS.kimi3, false, NO_CREDENTIALS, undefined),
    ).toBeNull();
  });

  it('restricts the OAuth session to tool-use agents when configured', async () => {
    await installPreferencePlatform({ toolUseOnly: true });

    expect(
      resolveKimiCodeRoute(
        MODEL_CONFIGS.kimiCoding,
        false,
        OAUTH_ONLY,
        AgentCategory.ToolUse,
      ),
    ).toBe('oauth');
    // Workflow agents skip the OAuth session; without a key there is no route.
    expect(
      resolveKimiCodeRoute(
        MODEL_CONFIGS.kimiCoding,
        false,
        OAUTH_ONLY,
        AgentCategory.Workflow,
      ),
    ).toBeNull();
    expect(
      resolveKimiCodeRoute(
        MODEL_CONFIGS.kimiCoding,
        false,
        OAUTH_ONLY,
        undefined,
      ),
    ).toBeNull();
    // The console key is not gated by the tool-use-only switch.
    expect(
      resolveKimiCodeRoute(
        MODEL_CONFIGS.kimiCoding,
        false,
        BOTH,
        AgentCategory.Workflow,
      ),
    ).toBe('api-key');
  });
});
