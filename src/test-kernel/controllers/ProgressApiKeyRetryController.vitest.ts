// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { ProgressApiKeyRetryController } from '@controllers/progressView/ProgressApiKeyRetryController';
import type { ApiProvider } from '@model/apiProviders';
import { prefersCopilotRoute } from '@model/copilotRouting';
import { installPlatform } from '@test/support/setupPlatform';

const PROVIDERS = [
  'openai',
  'anthropic',
] as const satisfies readonly ApiProvider[];

// The two dominant outcomes: the controller refused to act, or it switched to
// a stored key and triggered the retry.
const IDLE_RESULT = {
  proceeded: false,
  retried: false,
  disabledIncludedModelAccess: false,
  disabledChatGptSubscription: false,
  disabledCodingPlans: [],
};
const RETRIED_WITH_OWN_KEY_RESULT = {
  proceeded: true,
  retried: true,
  disabledIncludedModelAccess: true,
  disabledChatGptSubscription: false,
  disabledCodingPlans: [],
};

interface HarnessOptions {
  keys?: Partial<Record<ApiProvider, string | undefined>>;
  prompt?(keys: Map<ApiProvider, string | undefined>): void;
  preferChatGptSubscription?: boolean;
  glmCodingPlan?: boolean;
  retryAvailable?: boolean;
  retryPending?: boolean;
}

function createHarness(options: HarnessOptions = {}): {
  controller: ProgressApiKeyRetryController;
  keys: Map<ApiProvider, string | undefined>;
  prompts: Array<ApiProvider | undefined>;
  includedAccessValues: boolean[];
  chatGptSubscriptionValues: boolean[];
  glmCodingPlanValues: boolean[];
  invalidations: number;
  retries: string[];
} {
  const keys = new Map<ApiProvider, string | undefined>(
    Object.entries(options.keys ?? {}) as Array<
      [ApiProvider, string | undefined]
    >,
  );
  const prompts: Array<ApiProvider | undefined> = [];
  const includedAccessValues: boolean[] = [];
  const chatGptSubscriptionValues: boolean[] = [];
  const glmCodingPlanValues: boolean[] = [];
  let preferChatGptSubscription = options.preferChatGptSubscription ?? true;
  let glmCodingPlan = options.glmCodingPlan ?? true;
  let invalidations = 0;
  const retries: string[] = [];

  return {
    keys,
    prompts,
    includedAccessValues,
    chatGptSubscriptionValues,
    glmCodingPlanValues,
    get invalidations() {
      return invalidations;
    },
    retries,
    controller: new ProgressApiKeyRetryController({
      providers: PROVIDERS,
      readKey: async (provider) => keys.get(provider),
      hasUsableKey: async (provider) =>
        (keys.get(provider)?.trim().length ?? 0) > 0,
      promptForApiKey: async (provider) => {
        prompts.push(provider);
        options.prompt?.(keys);
      },
      getUseIncludedModelAccess: () => true,
      setUseIncludedModelAccess: async (enabled) => {
        includedAccessValues.push(enabled);
      },
      getPreferChatGptSubscription: () => preferChatGptSubscription,
      setPreferChatGptSubscription: async (enabled) => {
        preferChatGptSubscription = enabled;
        chatGptSubscriptionValues.push(enabled);
      },
      codingPlanToggles: [
        {
          exhaustionReason: 'glm-coding-plan',
          getEnabled: () => glmCodingPlan,
          setEnabled: async (enabled) => {
            glmCodingPlan = enabled;
            glmCodingPlanValues.push(enabled);
          },
        },
      ],
      invalidateModelOptionsCache: () => {
        invalidations += 1;
      },
      isRetryPending: () => options.retryPending ?? true,
      triggerRetry: (stream) => {
        retries.push(stream);
        return options.retryAvailable ?? true;
      },
    }),
  };
}

describe('ProgressApiKeyRetryController', () => {
  it('requires a changed usable key after upstream credit depletion', async () => {
    const harness = createHarness({
      keys: { anthropic: 'old-key' },
      prompt: (keys) => {
        keys.set('anthropic', 'new-key');
      },
    });

    const result = await harness.controller.useOwnApiKey({
      stream: 'stream-a',
      requestId: 'retry-a',
      provider: 'anthropic',
      exhaustionReason: 'upstream-credit',
      viaRelay: true,
    });

    assert.deepEqual(result, RETRIED_WITH_OWN_KEY_RESULT);
    assert.deepEqual(harness.prompts, ['anthropic']);
    assert.deepEqual(harness.includedAccessValues, [false]);
    assert.equal(harness.invalidations, 1);
    assert.deepEqual(harness.retries, ['stream-a']);
  });

  it('does not retry when a depleted provider key was not changed', async () => {
    const harness = createHarness({
      keys: { anthropic: 'old-key' },
      prompt: (keys) => {
        keys.set('anthropic', 'old-key');
      },
    });

    const result = await harness.controller.useOwnApiKey({
      stream: 'stream-a',
      requestId: 'retry-a',
      provider: 'anthropic',
      exhaustionReason: 'upstream-credit',
      viaRelay: true,
    });

    assert.deepEqual(result, IDLE_RESULT);
    assert.deepEqual(harness.prompts, ['anthropic']);
    assert.deepEqual(harness.includedAccessValues, []);
    assert.equal(harness.invalidations, 0);
    assert.deepEqual(harness.retries, []);
  });

  it('does not change routing after the retry request was replaced', async () => {
    const harness = createHarness({
      keys: { anthropic: 'stored-key' },
      retryPending: false,
    });

    const result = await harness.controller.useOwnApiKey({
      stream: 'stream-a',
      requestId: 'retry:stale',
      provider: 'anthropic',
      exhaustionReason: 'copilot-subscription',
    });

    assert.deepEqual(result, IDLE_RESULT);
    assert.deepEqual(harness.includedAccessValues, []);
    assert.equal(harness.invalidations, 0);
    assert.deepEqual(harness.retries, []);
  });

  it('returns a fresh result when no retry occurs', async () => {
    const harness = createHarness({
      keys: { anthropic: 'stored-key' },
      retryPending: false,
    });
    const request = {
      stream: 'stream-a' as const,
      requestId: 'retry:stale',
      provider: 'anthropic' as const,
      exhaustionReason: 'copilot-subscription' as const,
    };

    const first = await harness.controller.useOwnApiKey(request);
    const second = await harness.controller.useOwnApiKey(request);

    assert.notStrictEqual(first, second);
    assert.deepEqual(first, second);
  });

  it('accepts a changed key from any provider when depletion has no provider hint', async () => {
    const harness = createHarness({
      keys: { openai: 'old-openai', anthropic: undefined },
      prompt: (keys) => {
        keys.set('anthropic', 'new-anthropic');
      },
    });

    const result = await harness.controller.useOwnApiKey({
      stream: 'stream-b',
      requestId: 'retry-b',
      exhaustionReason: 'upstream-credit',
      viaRelay: true,
    });

    assert.deepEqual(result, RETRIED_WITH_OWN_KEY_RESULT);
    assert.deepEqual(harness.prompts, [undefined]);
    assert.deepEqual(harness.includedAccessValues, [false]);
    assert.equal(harness.invalidations, 1);
    assert.deepEqual(harness.retries, ['stream-b']);
  });

  it('uses any existing usable key for relay-limit consent without re-prompting', async () => {
    const harness = createHarness({
      keys: { openai: 'stored-key' },
    });

    const result = await harness.controller.useOwnApiKey({
      stream: 'stream-b',
      requestId: 'retry-b',
      viaRelay: true,
    });

    assert.deepEqual(result, RETRIED_WITH_OWN_KEY_RESULT);
    // A usable key already exists, so the switch must not pop the key prompt.
    assert.deepEqual(harness.prompts, []);
    assert.deepEqual(harness.includedAccessValues, [false]);
    assert.equal(harness.invalidations, 1);
    assert.deepEqual(harness.retries, ['stream-b']);
  });

  it('keeps relay enabled for direct-key failures', async () => {
    const harness = createHarness({
      keys: { anthropic: 'new-key' },
      retryAvailable: false,
    });

    const result = await harness.controller.useOwnApiKey({
      stream: 'stream-c',
      requestId: 'retry-c',
      provider: 'anthropic',
      viaRelay: false,
    });

    assert.deepEqual(result, IDLE_RESULT);
    assert.deepEqual(harness.includedAccessValues, []);
    assert.equal(harness.invalidations, 0);
    assert.deepEqual(harness.retries, ['stream-c']);
  });

  it('restores routing when the exact retry disappears during the switch', async () => {
    const harness = createHarness({
      keys: { openai: 'stored-openai' },
      retryAvailable: false,
    });

    const result = await harness.controller.useOwnApiKey({
      stream: 'stream-race',
      requestId: 'retry-race',
      provider: 'openai',
      exhaustionReason: 'chatgpt-subscription',
    });

    assert.deepEqual(result, IDLE_RESULT);
    assert.deepEqual(harness.includedAccessValues, [false, true]);
    assert.deepEqual(harness.chatGptSubscriptionValues, [false, true]);
    assert.equal(harness.invalidations, 3);
    assert.deepEqual(harness.retries, ['stream-race']);
  });

  it('disables the ChatGPT subscription and retries with the existing OpenAI key, no prompt', async () => {
    const harness = createHarness({
      keys: { openai: 'stored-openai' },
    });

    const result = await harness.controller.useOwnApiKey({
      stream: 'stream-d',
      requestId: 'retry-d',
      provider: 'openai',
      exhaustionReason: 'chatgpt-subscription',
    });

    // The subscription switch also drops relay so the retry reaches the stored
    // OpenAI key rather than the relay JWT.
    assert.deepEqual(result, {
      proceeded: true,
      retried: true,
      disabledIncludedModelAccess: true,
      disabledChatGptSubscription: true,
      disabledCodingPlans: [],
    });
    // The subscription quota failed, not the key — a stored key is already
    // usable, so "Use your own API key" must not jump to the key-input prompt.
    assert.deepEqual(harness.prompts, []);
    assert.deepEqual(harness.includedAccessValues, [false]);
    assert.deepEqual(harness.chatGptSubscriptionValues, [false]);
    assert.equal(harness.invalidations, 2);
    assert.deepEqual(harness.retries, ['stream-d']);
  });

  it('does not disable the subscription when no usable OpenAI key is available', async () => {
    const harness = createHarness({ keys: {} });

    const result = await harness.controller.useOwnApiKey({
      stream: 'stream-e',
      requestId: 'retry-e',
      provider: 'openai',
      exhaustionReason: 'chatgpt-subscription',
    });

    assert.deepEqual(result, IDLE_RESULT);
    // No usable key exists, so the prompt is still shown (then declined here).
    assert.deepEqual(harness.prompts, ['openai']);
    assert.deepEqual(harness.chatGptSubscriptionValues, []);
    assert.deepEqual(harness.retries, []);
  });

  it('disables the GLM Coding Plan and retries with the existing GLM key, no prompt', async () => {
    const harness = createHarness({
      keys: { glm: 'stored-glm' },
    });

    const result = await harness.controller.useOwnApiKey({
      stream: 'stream-glm',
      requestId: 'retry-glm',
      provider: 'glm',
      exhaustionReason: 'glm-coding-plan',
    });

    assert.deepEqual(result, {
      proceeded: true,
      retried: true,
      disabledIncludedModelAccess: false,
      disabledChatGptSubscription: false,
      disabledCodingPlans: ['glm-coding-plan'],
    });
    // The coding-plan quota failed, not the key — a stored key is already
    // usable, so "Use your own API key" must not jump to the key-input prompt.
    assert.deepEqual(harness.prompts, []);
    assert.deepEqual(harness.includedAccessValues, []);
    assert.deepEqual(harness.glmCodingPlanValues, [false]);
    assert.equal(harness.invalidations, 1);
    assert.deepEqual(harness.retries, ['stream-glm']);
  });

  it('does not disable the GLM Coding Plan when it is already off', async () => {
    const harness = createHarness({
      keys: { glm: 'stored-glm' },
      glmCodingPlan: false,
    });

    const result = await harness.controller.useOwnApiKey({
      stream: 'stream-glm2',
      requestId: 'retry-glm2',
      provider: 'glm',
      exhaustionReason: 'glm-coding-plan',
    });

    assert.deepEqual(result, {
      proceeded: true,
      retried: true,
      disabledIncludedModelAccess: false,
      disabledChatGptSubscription: false,
      disabledCodingPlans: [],
    });
    assert.deepEqual(harness.glmCodingPlanValues, []);
  });

  it('prepares an existing direct key for a fresh Copilot fallback without retrying in place', async () => {
    const harness = createHarness({
      keys: { anthropic: 'stored-anthropic' },
    });

    const proceeded = await harness.controller.ensureOwnApiKey({
      provider: 'anthropic',
      exhaustionReason: 'copilot-subscription',
    });

    assert.equal(proceeded, true);
    assert.deepEqual(harness.prompts, []);
    assert.deepEqual(harness.includedAccessValues, []);

    const started = await harness.controller.runCopilotFallbackWithRouting(
      { provider: 'anthropic', exhaustionReason: 'copilot-subscription' },
      async () => true,
    );

    assert.equal(started, true);
    // Included access is disabled for the fallback and, because it started,
    // left disabled; the ChatGPT preference is untouched and nothing is
    // retried in place.
    assert.deepEqual(harness.includedAccessValues, [false]);
    assert.deepEqual(harness.chatGptSubscriptionValues, []);
    assert.deepEqual(harness.retries, []);
  });

  it('restores included access when a fresh Copilot fallback does not start', async () => {
    const harness = createHarness();

    const started = await harness.controller.runCopilotFallbackWithRouting(
      { exhaustionReason: 'copilot-subscription' },
      async () => false,
    );

    assert.equal(started, false);
    assert.deepEqual(harness.includedAccessValues, [false, true]);
    assert.equal(harness.invalidations, 2);
  });

  it('keeps a Copilot fallback on the OpenAI key instead of ChatGPT access', async () => {
    const harness = createHarness();

    const started = await harness.controller.runCopilotFallbackWithRouting(
      {
        exhaustionReason: 'copilot-subscription',
        chatGptSubscriptionEligible: true,
      },
      async () => true,
    );

    assert.equal(started, true);
    assert.deepEqual(harness.includedAccessValues, [false]);
    assert.deepEqual(harness.chatGptSubscriptionValues, [false]);
    assert.equal(harness.invalidations, 2);
  });

  it('restores ChatGPT access when an eligible Copilot fallback does not start', async () => {
    const harness = createHarness();

    const started = await harness.controller.runCopilotFallbackWithRouting(
      {
        exhaustionReason: 'copilot-subscription',
        chatGptSubscriptionEligible: true,
      },
      async () => false,
    );

    assert.equal(started, false);
    assert.deepEqual(harness.includedAccessValues, [false, true]);
    assert.deepEqual(harness.chatGptSubscriptionValues, [false, true]);
    assert.equal(harness.invalidations, 3);
  });

  it('keeps direct routing when a fresh Copilot fallback starts', async () => {
    const harness = createHarness();

    const started = await harness.controller.runCopilotFallbackWithRouting(
      { exhaustionReason: 'copilot-subscription' },
      async () => true,
    );

    assert.equal(started, true);
    assert.deepEqual(harness.includedAccessValues, [false]);
    assert.equal(harness.invalidations, 1);
  });

  it('keeps the global Copilot preference while scoping direct routing to the fallback launch', async () => {
    const { FakeStateStore } = await import('@test/support/FakePlatform');
    const store = new FakeStateStore({
      'texra.copilotRouteModels': ['sonnet46'],
    });
    const persistedWrites: string[] = [];
    const originalUpdate = store.update.bind(store);
    store.update = async (key: string, value: unknown) => {
      persistedWrites.push(key);
      return originalUpdate(key, value);
    };
    await installPlatform({}, { globalState: store });
    const harness = createHarness();

    expect(prefersCopilotRoute('sonnet46')).toBe(true);
    const started = await harness.controller.runCopilotFallbackWithRouting(
      { model: 'sonnet46', exhaustionReason: 'copilot-subscription' },
      async (copilotRouteOverride) => {
        expect(copilotRouteOverride).toBe('direct');
        // A concurrent launch still sees the user's standing preference; only
        // the replacement request receives the direct-route override.
        expect(prefersCopilotRoute('sonnet46')).toBe(true);
        return true;
      },
    );

    expect(started).toBe(true);
    // The suppression is launch-scoped and process-local: the persisted
    // preference is never written, so a crash mid-launch cannot drop it.
    expect(persistedWrites).toEqual([]);
    expect(prefersCopilotRoute('sonnet46')).toBe(true);
  });
});
