import pDefer from 'p-defer';
import { describe, expect, it, vi } from 'vitest';

import {
  ProgressApiKeyRetryController,
  type ProgressApiKeyRetryControllerDeps,
} from '@controllers/progressView/ProgressApiKeyRetryController';
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
  glmCodingPlan?: boolean;
  kimiCode?: boolean;
  retryAvailable?: boolean;
  retryPending?: boolean;
  triggerRetry?: ProgressApiKeyRetryControllerDeps['triggerRetry'];
  isRetryPending?: ProgressApiKeyRetryControllerDeps['isRetryPending'];
}

function createHarness(options: HarnessOptions = {}): {
  controller: ProgressApiKeyRetryController;
  keys: Map<ApiProvider, string | undefined>;
  prompts: Array<ApiProvider | undefined>;
  includedAccessValues: boolean[];
  chatGptSubscriptionValues: boolean[];
  glmCodingPlanValues: boolean[];
  kimiCodeValues: boolean[];
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
  const kimiCodeValues: boolean[] = [];
  let preferChatGptSubscription = true;
  let glmCodingPlan = options.glmCodingPlan ?? true;
  let kimiCode = options.kimiCode ?? true;
  let invalidations = 0;
  const retries: string[] = [];

  return {
    keys,
    prompts,
    includedAccessValues,
    chatGptSubscriptionValues,
    glmCodingPlanValues,
    kimiCodeValues,
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
        {
          exhaustionReason: 'kimi-code-subscription',
          getEnabled: () => kimiCode,
          setEnabled: async (enabled) => {
            kimiCode = enabled;
            kimiCodeValues.push(enabled);
          },
        },
      ],
      invalidateModelOptionsCache: () => {
        invalidations += 1;
      },
      isRetryPending:
        options.isRetryPending ?? (() => options.retryPending ?? true),
      triggerRetry:
        options.triggerRetry ??
        ((stream) => {
          retries.push(stream);
          return options.retryAvailable ?? true;
        }),
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

    expect(result).toStrictEqual(RETRIED_WITH_OWN_KEY_RESULT);
    expect(harness.prompts).toStrictEqual(['anthropic']);
    expect(harness.includedAccessValues).toStrictEqual([false]);
    expect(harness.invalidations).toBe(1);
    expect(harness.retries).toStrictEqual(['stream-a']);
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

    expect(result).toStrictEqual(IDLE_RESULT);
    expect(harness.prompts).toStrictEqual(['anthropic']);
    expect(harness.includedAccessValues).toStrictEqual([]);
    expect(harness.invalidations).toBe(0);
    expect(harness.retries).toStrictEqual([]);
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

    expect(result).toStrictEqual(IDLE_RESULT);
    expect(harness.includedAccessValues).toStrictEqual([]);
    expect(harness.invalidations).toBe(0);
    expect(harness.retries).toStrictEqual([]);
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

    expect(first).not.toBe(second);
    expect(first).toStrictEqual(second);
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

    expect(result).toStrictEqual(RETRIED_WITH_OWN_KEY_RESULT);
    expect(harness.prompts).toStrictEqual([undefined]);
    expect(harness.includedAccessValues).toStrictEqual([false]);
    expect(harness.invalidations).toBe(1);
    expect(harness.retries).toStrictEqual(['stream-b']);
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

    expect(result).toStrictEqual(RETRIED_WITH_OWN_KEY_RESULT);
    // A usable key already exists, so the switch must not pop the key prompt.
    expect(harness.prompts).toStrictEqual([]);
    expect(harness.includedAccessValues).toStrictEqual([false]);
    expect(harness.invalidations).toBe(1);
    expect(harness.retries).toStrictEqual(['stream-b']);
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

    expect(result).toStrictEqual(IDLE_RESULT);
    expect(harness.includedAccessValues).toStrictEqual([]);
    expect(harness.invalidations).toBe(0);
    expect(harness.retries).toStrictEqual(['stream-c']);
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

    expect(result).toStrictEqual(IDLE_RESULT);
    expect(harness.includedAccessValues).toStrictEqual([false, true]);
    expect(harness.chatGptSubscriptionValues).toStrictEqual([false, true]);
    expect(harness.invalidations).toBe(3);
    expect(harness.retries).toStrictEqual(['stream-race']);
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
    expect(result).toStrictEqual({
      proceeded: true,
      retried: true,
      disabledIncludedModelAccess: true,
      disabledChatGptSubscription: true,
      disabledCodingPlans: [],
    });
    // The subscription quota failed, not the key — a stored key is already
    // usable, so "Use your own API key" must not jump to the key-input prompt.
    expect(harness.prompts).toStrictEqual([]);
    expect(harness.includedAccessValues).toStrictEqual([false]);
    expect(harness.chatGptSubscriptionValues).toStrictEqual([false]);
    expect(harness.invalidations).toBe(2);
    expect(harness.retries).toStrictEqual(['stream-d']);
  });

  it('resolves the OpenAI key from the exhaustion reason when no provider is given', async () => {
    // Only an Anthropic key is usable. If the controller fell back to
    // checking every provider (the pre-fix behavior when `provider` is
    // absent), it would find this key and retry on it, which is wrong for a
    // ChatGPT-subscription exhaustion that specifically requires OpenAI.
    const harness = createHarness({
      keys: { anthropic: 'stored-anthropic' },
    });

    // The caller (webview) forwards whatever provider the error was tagged
    // with, which may be absent — the controller, not the caller, owns the
    // chatgpt-subscription-always-means-openai policy.
    const result = await harness.controller.useOwnApiKey({
      stream: 'stream-f',
      requestId: 'retry-f',
      exhaustionReason: 'chatgpt-subscription',
    });

    expect(result).toStrictEqual(IDLE_RESULT);
    expect(harness.prompts).toStrictEqual(['openai']);
    expect(harness.retries).toStrictEqual([]);
  });

  it('does not disable the subscription when no usable OpenAI key is available', async () => {
    const harness = createHarness({ keys: {} });

    const result = await harness.controller.useOwnApiKey({
      stream: 'stream-e',
      requestId: 'retry-e',
      provider: 'openai',
      exhaustionReason: 'chatgpt-subscription',
    });

    expect(result).toStrictEqual(IDLE_RESULT);
    // No usable key exists, so the prompt is still shown (then declined here).
    expect(harness.prompts).toStrictEqual(['openai']);
    expect(harness.chatGptSubscriptionValues).toStrictEqual([]);
    expect(harness.retries).toStrictEqual([]);
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

    expect(result).toStrictEqual({
      proceeded: true,
      retried: true,
      disabledIncludedModelAccess: false,
      disabledChatGptSubscription: false,
      disabledCodingPlans: ['glm-coding-plan'],
    });
    // The coding-plan quota failed, not the key — a stored key is already
    // usable, so "Use your own API key" must not jump to the key-input prompt.
    expect(harness.prompts).toStrictEqual([]);
    expect(harness.includedAccessValues).toStrictEqual([]);
    expect(harness.glmCodingPlanValues).toStrictEqual([false]);
    expect(harness.invalidations).toBe(1);
    expect(harness.retries).toStrictEqual(['stream-glm']);
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

    expect(result).toStrictEqual({
      proceeded: true,
      retried: true,
      disabledIncludedModelAccess: false,
      disabledChatGptSubscription: false,
      disabledCodingPlans: [],
    });
    expect(harness.glmCodingPlanValues).toStrictEqual([]);
  });

  it('prepares an existing direct key for a fresh Copilot fallback without retrying in place', async () => {
    const harness = createHarness({
      keys: { anthropic: 'stored-anthropic' },
    });

    const proceeded = await harness.controller.ensureOwnApiKey({
      provider: 'anthropic',
      exhaustionReason: 'copilot-subscription',
    });

    expect(proceeded).toBe(true);
    expect(harness.prompts).toStrictEqual([]);
    expect(harness.includedAccessValues).toStrictEqual([]);

    const started = await harness.controller.runCopilotFallbackWithRouting(
      {
        stream: 'stream-a',
        requestId: 'retry-a',
        provider: 'anthropic',
        exhaustionReason: 'copilot-subscription',
      },
      async () => true,
    );

    expect(started).toBe(true);
    // Included access is disabled for the fallback and, because it started,
    // left disabled; the ChatGPT preference is untouched and nothing is
    // retried in place.
    expect(harness.includedAccessValues).toStrictEqual([false]);
    expect(harness.chatGptSubscriptionValues).toStrictEqual([]);
    expect(harness.retries).toStrictEqual([]);
  });

  it('restores included access when a fresh Copilot fallback does not start', async () => {
    const harness = createHarness();

    const started = await harness.controller.runCopilotFallbackWithRouting(
      {
        stream: 'stream-a',
        requestId: 'retry-a',
        exhaustionReason: 'copilot-subscription',
      },
      async () => false,
    );

    expect(started).toBe(false);
    expect(harness.includedAccessValues).toStrictEqual([false, true]);
    expect(harness.invalidations).toBe(2);
  });

  it('keeps a Copilot fallback on the OpenAI key instead of ChatGPT access', async () => {
    const harness = createHarness();

    const started = await harness.controller.runCopilotFallbackWithRouting(
      {
        stream: 'stream-a',
        requestId: 'retry-a',
        exhaustionReason: 'copilot-subscription',
        chatGptSubscriptionEligible: true,
      },
      async () => true,
    );

    expect(started).toBe(true);
    expect(harness.includedAccessValues).toStrictEqual([false]);
    expect(harness.chatGptSubscriptionValues).toStrictEqual([false]);
    expect(harness.invalidations).toBe(2);
  });

  it('restores ChatGPT access when an eligible Copilot fallback does not start', async () => {
    const harness = createHarness();

    const started = await harness.controller.runCopilotFallbackWithRouting(
      {
        stream: 'stream-a',
        requestId: 'retry-a',
        exhaustionReason: 'copilot-subscription',
        chatGptSubscriptionEligible: true,
      },
      async () => false,
    );

    expect(started).toBe(false);
    expect(harness.includedAccessValues).toStrictEqual([false, true]);
    expect(harness.chatGptSubscriptionValues).toStrictEqual([false, true]);
    expect(harness.invalidations).toBe(3);
  });

  it('keeps direct routing when a fresh Copilot fallback starts', async () => {
    const harness = createHarness();

    const started = await harness.controller.runCopilotFallbackWithRouting(
      {
        stream: 'stream-a',
        requestId: 'retry-a',
        exhaustionReason: 'copilot-subscription',
      },
      async () => true,
    );

    expect(started).toBe(true);
    expect(harness.includedAccessValues).toStrictEqual([false]);
    expect(harness.invalidations).toBe(1);
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
      {
        stream: 'stream-a',
        requestId: 'retry-a',
        model: 'sonnet46',
        exhaustionReason: 'copilot-subscription',
      },
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

  it('serializes routing rollback across concurrent stream retries', async () => {
    const firstTrigger = pDefer<boolean>();
    let retryBPendingCheck = false;
    const triggerOrder: string[] = [];
    const harness = createHarness({
      keys: { openai: 'stored-openai' },
      isRetryPending: (_stream, requestId) => {
        if (requestId === 'retry-b') retryBPendingCheck = true;
        return true;
      },
      triggerRetry: (stream) => {
        triggerOrder.push(stream);
        return stream === 'stream-a' ? firstTrigger.promise : true;
      },
    });

    const first = harness.controller.useOwnApiKey({
      stream: 'stream-a',
      requestId: 'retry-a',
      provider: 'openai',
      exhaustionReason: 'chatgpt-subscription',
    });
    await vi.waitFor(() =>
      expect(harness.includedAccessValues).toStrictEqual([false]),
    );
    const second = harness.controller.useOwnApiKey({
      stream: 'stream-b',
      requestId: 'retry-b',
      provider: 'openai',
      exhaustionReason: 'chatgpt-subscription',
    });
    await vi.waitFor(() => expect(retryBPendingCheck).toBe(true));

    // Retry B is queued behind retry A; its routing transaction must not start
    // while A's trigger is still pending.
    expect(harness.chatGptSubscriptionValues).toStrictEqual([false]);
    expect(triggerOrder).toStrictEqual(['stream-a']);

    firstTrigger.resolve(false);
    await expect(first).resolves.toStrictEqual(IDLE_RESULT);
    await expect(second).resolves.toStrictEqual({
      proceeded: true,
      retried: true,
      disabledIncludedModelAccess: true,
      disabledChatGptSubscription: true,
      disabledCodingPlans: [],
    });
    expect(harness.includedAccessValues).toStrictEqual([false, true, false]);
    expect(harness.chatGptSubscriptionValues).toStrictEqual([
      false,
      true,
      false,
    ]);
    expect(triggerOrder).toStrictEqual(['stream-a', 'stream-b']);
  });

  it('refuses the API-key switch for a Kimi Code-exclusive model', async () => {
    const harness = createHarness({ keys: { openai: 'stored-openai' } });

    const result = await harness.controller.useOwnApiKey({
      stream: 'stream-kimi-exclusive',
      requestId: 'retry-kimi-exclusive',
      model: 'kimiCoding',
      exhaustionReason: 'kimi-code-subscription',
    });

    expect(result).toStrictEqual(IDLE_RESULT);
    expect(harness.prompts).toStrictEqual([]);
    expect(harness.includedAccessValues).toStrictEqual([]);
    expect(harness.retries).toStrictEqual([]);
  });

  it('rechecks retry identity after the routing queue admits the request', async () => {
    let pendingChecks = 0;
    const harness = createHarness({
      keys: { openai: 'stored-openai' },
      isRetryPending: () => {
        pendingChecks += 1;
        // The pre-queue check passes; the request is dismissed before the
        // serialized callback starts, so the in-queue recheck must fail.
        return pendingChecks === 1;
      },
    });

    const result = await harness.controller.useOwnApiKey({
      stream: 'stream-stale-queue',
      requestId: 'retry-stale-queue',
      provider: 'openai',
      exhaustionReason: 'chatgpt-subscription',
    });

    expect(result).toStrictEqual(IDLE_RESULT);
    expect(harness.includedAccessValues).toStrictEqual([]);
    expect(harness.chatGptSubscriptionValues).toStrictEqual([]);
    expect(harness.retries).toStrictEqual([]);
    expect(pendingChecks).toBe(2);
  });

  it('prompts for the kimiCode credential when an exclusive model rebinds on credit depletion', async () => {
    const harness = createHarness({
      keys: { kimiCode: 'old-kimi', moonshot: 'old-moonshot' },
      prompt: (keys) => {
        keys.set('kimiCode', 'new-kimi');
      },
      kimiCode: true,
    });

    const result = await harness.controller.useOwnApiKey({
      stream: 'stream-kimi-credit',
      requestId: 'retry-kimi-credit',
      model: 'kimiCoding',
      provider: 'moonshot',
      exhaustionReason: 'upstream-credit',
      kimiCodeRoutedOnFailure: true,
    });

    expect(result).toStrictEqual({
      proceeded: true,
      retried: true,
      disabledIncludedModelAccess: false,
      disabledChatGptSubscription: false,
      disabledCodingPlans: [],
    });
    // The SDK error identifies the open-platform Moonshot provider, but the
    // exclusive handler rebinds with `kimiCode`; the prompt and key check must
    // target the same credential or the retry repeats the same failure.
    expect(harness.prompts).toStrictEqual(['kimiCode']);
    expect(harness.keys.get('kimiCode')).toBe('new-kimi');
    expect(harness.keys.get('moonshot')).toBe('old-moonshot');
    expect(harness.kimiCodeValues).toStrictEqual([]);
    expect(harness.retries).toStrictEqual(['stream-kimi-credit']);
  });

  it('disables the Kimi Code preference for a dual-backend Kimi credit retry even when live routing would say not coding', async () => {
    const harness = createHarness({
      keys: { moonshot: 'old-moonshot', kimiCode: 'old-kimi' },
      prompt: (keys) => {
        keys.set('moonshot', 'new-moonshot');
      },
      kimiCode: true,
    });

    const result = await harness.controller.useOwnApiKey({
      stream: 'stream-kimi-dual',
      requestId: 'retry-kimi-dual',
      model: 'kimi3',
      provider: 'moonshot',
      exhaustionReason: 'upstream-credit',
      kimiCodeRoutedOnFailure: true,
    });

    expect(result).toStrictEqual({
      proceeded: true,
      retried: true,
      disabledIncludedModelAccess: false,
      disabledChatGptSubscription: false,
      disabledCodingPlans: ['kimi-code-subscription'],
    });
    // The forwarded SDK provider is `moonshot`, so that is the credential the
    // panel asks to replace; the routing step then turns off "Prefer Kimi
    // Code" so the rebuilt handler actually uses the new Moonshot key. The
    // controller does not consult the live route resolver here: the failed
    // handler was dispatched under `ModelHandlerKimi`, and the rebuild pins
    // that key, so a later OpenRouter preference change must not keep the
    // exhausted coding route selected.
    expect(harness.prompts).toStrictEqual(['moonshot']);
    expect(harness.keys.get('moonshot')).toBe('new-moonshot');
    expect(harness.keys.get('kimiCode')).toBe('old-kimi');
    expect(harness.kimiCodeValues).toStrictEqual([false]);
    expect(harness.invalidations).toBe(1);
    expect(harness.retries).toStrictEqual(['stream-kimi-dual']);
  });

  it('leaves the Kimi Code preference untouched for a non-Kimi-Code kimi3 credit retry', async () => {
    const harness = createHarness({
      keys: { moonshot: 'old-moonshot', kimiCode: 'old-kimi' },
      prompt: (keys) => {
        keys.set('moonshot', 'new-moonshot');
      },
      kimiCode: true,
    });

    const result = await harness.controller.useOwnApiKey({
      stream: 'stream-kimi-moonshot',
      requestId: 'retry-kimi-moonshot',
      model: 'kimi3',
      provider: 'moonshot',
      exhaustionReason: 'upstream-credit',
      kimiCodeRoutedOnFailure: false,
    });

    expect(result).toStrictEqual({
      proceeded: true,
      retried: true,
      disabledIncludedModelAccess: false,
      disabledChatGptSubscription: false,
      disabledCodingPlans: [],
    });
    // A canonical `kimi3` can also fail through OpenRouter, Moonshot, or the
    // relay. Those failed handlers were not dispatched onto the Kimi Code
    // endpoint, so the retry must not turn off the user's coding preference.
    expect(harness.prompts).toStrictEqual(['moonshot']);
    expect(harness.keys.get('moonshot')).toBe('new-moonshot');
    expect(harness.keys.get('kimiCode')).toBe('old-kimi');
    expect(harness.kimiCodeValues).toStrictEqual([]);
    expect(harness.invalidations).toBe(0);
    expect(harness.retries).toStrictEqual(['stream-kimi-moonshot']);
  });

  it('rechecks Copilot fallback retry identity after the routing queue admits it', async () => {
    const firstStart = pDefer<boolean>();
    let stalePending = true;
    const startCalls: string[] = [];
    const harness = createHarness({
      isRetryPending: (_stream, requestId) =>
        requestId === 'retry-stale' ? stalePending : true,
    });

    const holder = harness.controller.runCopilotFallbackWithRouting(
      {
        stream: 'stream-holder',
        requestId: 'retry-holder',
        exhaustionReason: 'copilot-subscription',
      },
      async () => {
        startCalls.push('holder');
        return firstStart.promise;
      },
    );
    await vi.waitFor(() =>
      expect(harness.includedAccessValues).toStrictEqual([false]),
    );
    await vi.waitFor(() => expect(startCalls).toStrictEqual(['holder']));

    const stale = harness.controller.runCopilotFallbackWithRouting(
      {
        stream: 'stream-stale',
        requestId: 'retry-stale',
        exhaustionReason: 'copilot-subscription',
      },
      async () => {
        startCalls.push('stale');
        return true;
      },
    );

    // The stale request is queued behind the holder; dismissing it before the
    // queue admits it must make the in-queue recheck fail and prevent any
    // routing write or launch from the stale request.
    stalePending = false;
    firstStart.resolve(true);

    await expect(holder).resolves.toBe(true);
    await expect(stale).resolves.toBe(false);
    expect(startCalls).toStrictEqual(['holder']);
    expect(harness.includedAccessValues).toStrictEqual([false]);
    expect(harness.invalidations).toBe(1);
  });
});
