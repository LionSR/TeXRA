import { Redacted } from 'effect';
// Third-party imports
import { it } from '@effect/vitest';
import { Cause, Effect, Exit, Fiber } from 'effect';
import pDefer from 'p-defer';
import { describe, expect, vi } from 'vitest';

// Local imports
import {
  ProgressApiKeyRetryController,
  type ProgressApiKeyRetryControllerDeps,
} from '@controllers/progressView/ProgressApiKeyRetryController';
import type { ApiProvider } from '@model/apiProviders';
import { prefersCopilotRoute } from '@model/copilotRouting';
import type { QuotaFallbackRuntime } from '@model/quotaFallbackRoutes';
import type { QuotaFallbackRoute } from '@shared/quotaFallbackRoutes';
import type { RunId } from '@shared/schemas';
import { installPlatform } from '@test/support/setupPlatform';

const PROVIDERS = [
  'openai',
  'anthropic',
] as const satisfies readonly ApiProvider[];

function testRuntime(
  descriptor: Pick<
    QuotaFallbackRoute,
    'id' | 'exhaustionReason' | 'fallbackApiProvider'
  >,
  getEnabled: () => boolean,
  setEnabled: (enabled: boolean) => Promise<void>,
  restoreEnabled: (enabled: boolean) => Promise<void> = setEnabled,
): QuotaFallbackRuntime {
  return {
    descriptor: {
      retryFallbackName: descriptor.id,
      retrySourceName: descriptor.id,
      ...descriptor,
    },
    getEnabled,
    setEnabled,
    restoreEnabled,
  };
}

interface HarnessOptions {
  keys?: Partial<Record<ApiProvider, string | undefined>>;
  prompt?(keys: Map<ApiProvider, string | undefined>): void;
  glmCodingPlan?: boolean;
  kimiCode?: boolean;
  grok?: boolean;
  retryAvailable?: boolean;
  retryPending?: boolean;
  triggerRetry?: ProgressApiKeyRetryControllerDeps['triggerRetry'];
  isRetryPending?: ProgressApiKeyRetryControllerDeps['isRetryPending'];
  /** Replaces the ChatGPT runtime's rollback restore; `setEnabled` otherwise. */
  restoreChatGptSubscription?(enabled: boolean): Promise<void>;
}

function createHarness(options: HarnessOptions = {}): {
  controller: ProgressApiKeyRetryController;
  keys: Map<ApiProvider, string | undefined>;
  prompts: Array<ApiProvider | undefined>;
  chatGptSubscriptionValues: boolean[];
  glmCodingPlanValues: boolean[];
  kimiCodeValues: boolean[];
  grokSubscriptionValues: boolean[];
  retries: string[];
} {
  const keys = new Map<ApiProvider, string | undefined>(
    Object.entries(options.keys ?? {}) as Array<
      [ApiProvider, string | undefined]
    >,
  );
  const prompts: Array<ApiProvider | undefined> = [];
  const chatGptSubscriptionValues: boolean[] = [];
  const glmCodingPlanValues: boolean[] = [];
  const kimiCodeValues: boolean[] = [];
  const grokSubscriptionValues: boolean[] = [];
  let preferChatGptSubscription = true;
  let preferGrokSubscription = options.grok ?? true;
  let glmCodingPlan = options.glmCodingPlan ?? true;
  let kimiCode = options.kimiCode ?? true;
  const retries: string[] = [];

  return {
    keys,
    prompts,
    chatGptSubscriptionValues,
    glmCodingPlanValues,
    kimiCodeValues,
    grokSubscriptionValues,
    retries,
    controller: new ProgressApiKeyRetryController({
      providers: PROVIDERS,
      readKey: async (provider) => {
        // The fixture keeps plain strings; the port hands out sealed values,
        // which compare by value so a re-entered identical key reads unchanged.
        const key = keys.get(provider);
        return key === undefined ? undefined : Redacted.make(key);
      },
      hasUsableKey: async (provider) =>
        (keys.get(provider)?.trim().length ?? 0) > 0,
      promptForApiKey: async (provider) => {
        prompts.push(provider);
        options.prompt?.(keys);
      },
      quotaFallbackRuntimes: [
        testRuntime(
          {
            id: 'chatgpt',
            exhaustionReason: 'chatgpt-subscription',
            fallbackApiProvider: 'openai',
          },
          () => preferChatGptSubscription,
          async (enabled) => {
            preferChatGptSubscription = enabled;
            chatGptSubscriptionValues.push(enabled);
          },
          options.restoreChatGptSubscription,
        ),
        testRuntime(
          {
            id: 'grok',
            exhaustionReason: 'xai-subscription',
            fallbackApiProvider: 'xai',
          },
          () => preferGrokSubscription,
          async (enabled) => {
            preferGrokSubscription = enabled;
            grokSubscriptionValues.push(enabled);
          },
        ),
        testRuntime(
          {
            id: 'glmCodingPlan',
            exhaustionReason: 'glm-coding-plan',
          },
          () => glmCodingPlan,
          async (enabled) => {
            glmCodingPlan = enabled;
            glmCodingPlanValues.push(enabled);
          },
        ),
        testRuntime(
          {
            id: 'kimiCode',
            exhaustionReason: 'kimi-code-subscription',
          },
          () => kimiCode,
          async (enabled) => {
            kimiCode = enabled;
            kimiCodeValues.push(enabled);
          },
        ),
      ],
      isRetryPending:
        options.isRetryPending ?? (() => options.retryPending ?? true),
      triggerRetry:
        options.triggerRetry ??
        ((stream) =>
          Effect.sync(() => {
            retries.push(stream);
            return options.retryAvailable ?? true;
          })),
    }),
  };
}

describe('ProgressApiKeyRetryController', () => {
  it.effect(
    'requires a changed usable key after upstream credit depletion',
    () =>
      Effect.gen(function* () {
        const harness = createHarness({
          keys: { anthropic: 'old-key' },
          prompt: (keys) => {
            keys.set('anthropic', 'new-key');
          },
        });

        yield* harness.controller.useOwnApiKey({
          stream: 'stream-a' as RunId,
          requestId: 'retry-a',
          provider: 'anthropic',
          exhaustionReason: 'upstream-credit',
        });

        expect(harness.prompts).toStrictEqual(['anthropic']);
        expect(harness.retries).toStrictEqual(['stream-a']);
      }),
  );

  it.effect('does not retry when a depleted provider key was not changed', () =>
    Effect.gen(function* () {
      const harness = createHarness({
        keys: { anthropic: 'old-key' },
        prompt: (keys) => {
          keys.set('anthropic', 'old-key');
        },
      });

      yield* harness.controller.useOwnApiKey({
        stream: 'stream-a' as RunId,
        requestId: 'retry-a',
        provider: 'anthropic',
        exhaustionReason: 'upstream-credit',
      });

      expect(harness.prompts).toStrictEqual(['anthropic']);
      expect(harness.retries).toStrictEqual([]);
    }),
  );

  it.effect(
    'does not change routing after the retry request was replaced',
    () =>
      Effect.gen(function* () {
        const harness = createHarness({
          keys: { anthropic: 'stored-key' },
          retryPending: false,
        });

        yield* harness.controller.useOwnApiKey({
          stream: 'stream-a' as RunId,
          requestId: 'retry:stale',
          provider: 'anthropic',
          exhaustionReason: 'copilot-subscription',
        });

        expect(harness.retries).toStrictEqual([]);
      }),
  );

  it.effect(
    'accepts a changed key from any provider when depletion has no provider hint',
    () =>
      Effect.gen(function* () {
        const harness = createHarness({
          keys: { openai: 'old-openai', anthropic: undefined },
          prompt: (keys) => {
            keys.set('anthropic', 'new-anthropic');
          },
        });

        yield* harness.controller.useOwnApiKey({
          stream: 'stream-b' as RunId,
          requestId: 'retry-b',
          exhaustionReason: 'upstream-credit',
        });

        expect(harness.prompts).toStrictEqual([undefined]);
        expect(harness.retries).toStrictEqual(['stream-b']);
      }),
  );

  it.effect(
    'restores routing when the exact retry disappears during the switch',
    () =>
      Effect.gen(function* () {
        const harness = createHarness({
          keys: { openai: 'stored-openai' },
          retryAvailable: false,
        });

        yield* harness.controller.useOwnApiKey({
          stream: 'stream-race' as RunId,
          requestId: 'retry-race',
          provider: 'openai',
          exhaustionReason: 'chatgpt-subscription',
        });

        expect(harness.chatGptSubscriptionValues).toStrictEqual([false, true]);
        expect(harness.retries).toStrictEqual(['stream-race']);
      }),
  );

  it.effect(
    'disables the ChatGPT subscription and retries with the existing OpenAI key, no prompt',
    () =>
      Effect.gen(function* () {
        const harness = createHarness({
          keys: { openai: 'stored-openai' },
        });

        yield* harness.controller.useOwnApiKey({
          stream: 'stream-d' as RunId,
          requestId: 'retry-d',
          provider: 'openai',
          exhaustionReason: 'chatgpt-subscription',
        });

        // The subscription quota failed, not the key — a stored key is already
        // usable, so "Use your own API key" must not jump to the key-input prompt.
        expect(harness.prompts).toStrictEqual([]);
        expect(harness.chatGptSubscriptionValues).toStrictEqual([false]);
        expect(harness.retries).toStrictEqual(['stream-d']);
      }),
  );

  it.effect(
    'does not disable the subscription when no usable OpenAI key is available',
    () =>
      Effect.gen(function* () {
        const harness = createHarness({ keys: {} });

        yield* harness.controller.useOwnApiKey({
          stream: 'stream-e' as RunId,
          requestId: 'retry-e',
          provider: 'openai',
          exhaustionReason: 'chatgpt-subscription',
        });

        // No usable key exists, so the prompt is still shown (then declined here).
        expect(harness.prompts).toStrictEqual(['openai']);
        expect(harness.chatGptSubscriptionValues).toStrictEqual([]);
        expect(harness.retries).toStrictEqual([]);
      }),
  );

  it.effect('does not disable the GLM Coding Plan when it is already off', () =>
    Effect.gen(function* () {
      const harness = createHarness({
        keys: { glm: 'stored-glm' },
        glmCodingPlan: false,
      });

      yield* harness.controller.useOwnApiKey({
        stream: 'stream-glm2' as RunId,
        requestId: 'retry-glm2',
        provider: 'glm',
        exhaustionReason: 'glm-coding-plan',
      });

      expect(harness.glmCodingPlanValues).toStrictEqual([]);
      expect(harness.retries).toStrictEqual(['stream-glm2']);
    }),
  );

  it.effect(
    'prepares an existing direct key for a fresh Copilot fallback without retrying in place',
    () =>
      Effect.gen(function* () {
        const harness = createHarness({
          keys: { anthropic: 'stored-anthropic' },
        });

        const proceeded = yield* harness.controller.ensureOwnApiKey({
          provider: 'anthropic',
          exhaustionReason: 'copilot-subscription',
        });

        expect(proceeded).toBe(true);
        expect(harness.prompts).toStrictEqual([]);

        const started = yield* harness.controller.runCopilotFallbackWithRouting(
          {
            stream: 'stream-a' as RunId,
            requestId: 'retry-a',
            provider: 'anthropic',
            exhaustionReason: 'copilot-subscription',
          },
          () => Effect.succeed(true),
        );

        expect(started).toBe(true);
        // The ChatGPT preference is untouched and nothing is retried in place.
        expect(harness.chatGptSubscriptionValues).toStrictEqual([]);
        expect(harness.retries).toStrictEqual([]);
      }),
  );

  it.effect(
    'keeps a Copilot fallback on the OpenAI key instead of ChatGPT access',
    () =>
      Effect.gen(function* () {
        const harness = createHarness();

        const started = yield* harness.controller.runCopilotFallbackWithRouting(
          {
            stream: 'stream-a' as RunId,
            requestId: 'retry-a',
            exhaustionReason: 'copilot-subscription',
            chatGptSubscriptionEligible: true,
          },
          () => Effect.succeed(true),
        );

        expect(started).toBe(true);
        expect(harness.chatGptSubscriptionValues).toStrictEqual([false]);
      }),
  );

  it.effect(
    'restores ChatGPT access when an eligible Copilot fallback does not start',
    () =>
      Effect.gen(function* () {
        const harness = createHarness();

        const started = yield* harness.controller.runCopilotFallbackWithRouting(
          {
            stream: 'stream-a' as RunId,
            requestId: 'retry-a',
            exhaustionReason: 'copilot-subscription',
            chatGptSubscriptionEligible: true,
          },
          () => Effect.succeed(false),
        );

        expect(started).toBe(false);
        expect(harness.chatGptSubscriptionValues).toStrictEqual([false, true]);
      }),
  );

  it.effect(
    'keeps the global Copilot preference while scoping direct routing to the fallback launch',
    () =>
      Effect.gen(function* () {
        const { FakeStateStore } = yield* Effect.promise(
          () => import('@test/support/FakePlatform'),
        );
        const store = new FakeStateStore({
          'texra.copilotRouteModels': ['sonnet46'],
        });
        const persistedWrites: string[] = [];
        const originalUpdate = store.update.bind(store);
        store.update = async (key: string, value: unknown) => {
          persistedWrites.push(key);
          return originalUpdate(key, value);
        };
        yield* Effect.promise(() =>
          installPlatform({}, { globalState: store }),
        );
        const harness = createHarness();

        expect(prefersCopilotRoute('sonnet46')).toBe(true);
        const started = yield* harness.controller.runCopilotFallbackWithRouting(
          {
            stream: 'stream-a' as RunId,
            requestId: 'retry-a',
            model: 'sonnet46',
            exhaustionReason: 'copilot-subscription',
          },
          (copilotRouteOverride) => {
            expect(copilotRouteOverride).toBe('direct');
            // A concurrent launch still sees the user's standing preference; only
            // the replacement request receives the direct-route override.
            expect(prefersCopilotRoute('sonnet46')).toBe(true);
            return Effect.succeed(true);
          },
        );

        expect(started).toBe(true);
        // The suppression is launch-scoped and process-local: the persisted
        // preference is never written, so a crash mid-launch cannot drop it.
        expect(persistedWrites).toEqual([]);
        expect(prefersCopilotRoute('sonnet46')).toBe(true);
      }),
  );

  it.effect(
    'reports the retry failure over a failed rollback restore, and the restore failure alone when the retry did not run',
    () =>
      Effect.gen(function* () {
        const retryFailure = new Error('retry launch failed');
        const restoreFailure = new Error('restore failed');
        const request = {
          stream: 'stream-a' as RunId,
          requestId: 'retry-a',
          provider: 'openai',
          exhaustionReason: 'chatgpt-subscription',
        } as const;

        const bothFail = createHarness({
          keys: { openai: 'stored-openai' },
          triggerRetry: () => Effect.fail(retryFailure),
          restoreChatGptSubscription: () => Promise.reject(restoreFailure),
        });
        const retryError = yield* Effect.flip(
          bothFail.controller.useOwnApiKey(request),
        );
        expect(retryError).toBe(retryFailure);
        expect(bothFail.chatGptSubscriptionValues).toStrictEqual([false]);

        const restoreFails = createHarness({
          keys: { openai: 'stored-openai' },
          retryAvailable: false,
          restoreChatGptSubscription: () => Promise.reject(restoreFailure),
        });
        // The restore dies on an otherwise-successful run, so the caller sees
        // the defect itself; squash the cause the way the run edge would.
        const restoreExit = yield* Effect.exit(
          restoreFails.controller.useOwnApiKey(request),
        );
        expect(Exit.isFailure(restoreExit)).toBe(true);
        if (Exit.isFailure(restoreExit)) {
          expect(Cause.squash(restoreExit.cause)).toBe(restoreFailure);
        }
      }),
  );

  it.effect(
    'serializes routing rollback across concurrent stream retries',
    () =>
      Effect.gen(function* () {
        const firstTrigger = pDefer<boolean>();
        let retryBPendingCheck = false;
        const triggerOrder: string[] = [];
        const harness = createHarness({
          keys: { openai: 'stored-openai' },
          isRetryPending: (_stream, requestId) => {
            if (requestId === 'retry-b') retryBPendingCheck = true;
            return true;
          },
          triggerRetry: (stream) =>
            Effect.suspend(() => {
              triggerOrder.push(stream);
              return stream === 'stream-a'
                ? Effect.promise(() => firstTrigger.promise)
                : Effect.succeed(true);
            }),
        });

        const first = yield* Effect.forkChild(
          harness.controller.useOwnApiKey({
            stream: 'stream-a' as RunId,
            requestId: 'retry-a',
            provider: 'openai',
            exhaustionReason: 'chatgpt-subscription',
          }),
        );
        yield* Effect.promise(() =>
          vi.waitFor(() =>
            expect(harness.chatGptSubscriptionValues).toStrictEqual([false]),
          ),
        );
        const second = yield* Effect.forkChild(
          harness.controller.useOwnApiKey({
            stream: 'stream-b' as RunId,
            requestId: 'retry-b',
            provider: 'openai',
            exhaustionReason: 'chatgpt-subscription',
          }),
        );
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(retryBPendingCheck).toBe(true)),
        );

        // Retry B is queued behind retry A; its routing transaction must not start
        // while A's trigger is still pending.
        expect(harness.chatGptSubscriptionValues).toStrictEqual([false]);
        expect(triggerOrder).toStrictEqual(['stream-a']);

        firstTrigger.resolve(false);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(harness.chatGptSubscriptionValues).toStrictEqual([
          false,
          true,
          false,
        ]);
        expect(triggerOrder).toStrictEqual(['stream-a', 'stream-b']);
      }),
  );

  it.effect('refuses the API-key switch for a Kimi Code-exclusive model', () =>
    Effect.gen(function* () {
      const harness = createHarness({ keys: { openai: 'stored-openai' } });

      yield* harness.controller.useOwnApiKey({
        stream: 'stream-kimi-exclusive' as RunId,
        requestId: 'retry-kimi-exclusive',
        model: 'kimiCoding',
        exhaustionReason: 'kimi-code-subscription',
      });

      expect(harness.prompts).toStrictEqual([]);
      expect(harness.retries).toStrictEqual([]);
    }),
  );

  it.effect(
    'rechecks retry identity after the routing queue admits the request',
    () =>
      Effect.gen(function* () {
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

        yield* harness.controller.useOwnApiKey({
          stream: 'stream-stale-queue' as RunId,
          requestId: 'retry-stale-queue',
          provider: 'openai',
          exhaustionReason: 'chatgpt-subscription',
        });

        expect(harness.chatGptSubscriptionValues).toStrictEqual([]);
        expect(harness.retries).toStrictEqual([]);
        expect(pendingChecks).toBe(2);
      }),
  );

  it.effect(
    'prompts for the kimiCode credential when an exclusive model rebinds on credit depletion',
    () =>
      Effect.gen(function* () {
        const harness = createHarness({
          keys: { kimiCode: 'old-kimi', moonshot: 'old-moonshot' },
          prompt: (keys) => {
            keys.set('kimiCode', 'new-kimi');
          },
          kimiCode: true,
        });

        yield* harness.controller.useOwnApiKey({
          stream: 'stream-kimi-credit' as RunId,
          requestId: 'retry-kimi-credit',
          model: 'kimiCoding',
          provider: 'moonshot',
          exhaustionReason: 'upstream-credit',
          kimiCodeRoutedOnFailure: true,
        });

        // The SDK error identifies the open-platform Moonshot provider, but the
        // exclusive handler rebinds with `kimiCode`; the prompt and key check must
        // target the same credential or the retry repeats the same failure.
        expect(harness.prompts).toStrictEqual(['kimiCode']);
        expect(harness.keys.get('kimiCode')).toBe('new-kimi');
        expect(harness.keys.get('moonshot')).toBe('old-moonshot');
        expect(harness.kimiCodeValues).toStrictEqual([]);
        expect(harness.retries).toStrictEqual(['stream-kimi-credit']);
      }),
  );

  it.effect(
    'disables the Kimi Code preference for a dual-backend Kimi credit retry even when live routing would say not coding',
    () =>
      Effect.gen(function* () {
        const harness = createHarness({
          keys: { moonshot: 'old-moonshot', kimiCode: 'old-kimi' },
          prompt: (keys) => {
            keys.set('moonshot', 'new-moonshot');
          },
          kimiCode: true,
        });

        yield* harness.controller.useOwnApiKey({
          stream: 'stream-kimi-dual' as RunId,
          requestId: 'retry-kimi-dual',
          model: 'kimi3',
          provider: 'moonshot',
          exhaustionReason: 'upstream-credit',
          kimiCodeRoutedOnFailure: true,
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
        expect(harness.retries).toStrictEqual(['stream-kimi-dual']);
      }),
  );

  it.effect(
    'leaves the Kimi Code preference untouched for a non-Kimi-Code kimi3 credit retry',
    () =>
      Effect.gen(function* () {
        const harness = createHarness({
          keys: { moonshot: 'old-moonshot', kimiCode: 'old-kimi' },
          prompt: (keys) => {
            keys.set('moonshot', 'new-moonshot');
          },
          kimiCode: true,
        });

        yield* harness.controller.useOwnApiKey({
          stream: 'stream-kimi-moonshot' as RunId,
          requestId: 'retry-kimi-moonshot',
          model: 'kimi3',
          provider: 'moonshot',
          exhaustionReason: 'upstream-credit',
          kimiCodeRoutedOnFailure: false,
        });

        // A canonical `kimi3` can also fail through OpenRouter or Moonshot. Those
        // failed handlers were not dispatched onto the Kimi Code endpoint, so the
        // retry must not turn off the user's coding preference.
        expect(harness.prompts).toStrictEqual(['moonshot']);
        expect(harness.keys.get('moonshot')).toBe('new-moonshot');
        expect(harness.keys.get('kimiCode')).toBe('old-kimi');
        expect(harness.kimiCodeValues).toStrictEqual([]);
        expect(harness.retries).toStrictEqual(['stream-kimi-moonshot']);
      }),
  );

  it.effect(
    'rechecks Copilot fallback retry identity after the routing queue admits it',
    () =>
      Effect.gen(function* () {
        const firstStart = pDefer<boolean>();
        let stalePending = true;
        const startCalls: string[] = [];
        const harness = createHarness({
          isRetryPending: (_stream, requestId) =>
            requestId === 'retry-stale' ? stalePending : true,
        });

        const holder = yield* Effect.forkChild(
          harness.controller.runCopilotFallbackWithRouting(
            {
              stream: 'stream-holder' as RunId,
              requestId: 'retry-holder',
              exhaustionReason: 'copilot-subscription',
            },
            () => {
              startCalls.push('holder');
              return Effect.promise(() => firstStart.promise);
            },
          ),
        );
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(startCalls).toStrictEqual(['holder'])),
        );

        const stale = yield* Effect.forkChild(
          harness.controller.runCopilotFallbackWithRouting(
            {
              stream: 'stream-stale' as RunId,
              requestId: 'retry-stale',
              exhaustionReason: 'copilot-subscription',
            },
            () => {
              startCalls.push('stale');
              return Effect.succeed(true);
            },
          ),
        );

        // The stale request is queued behind the holder; dismissing it before the
        // queue admits it must make the in-queue recheck fail and prevent any
        // routing write or launch from the stale request.
        stalePending = false;
        firstStart.resolve(true);

        expect(yield* Fiber.join(holder)).toBe(true);
        expect(yield* Fiber.join(stale)).toBe(false);
        expect(startCalls).toStrictEqual(['holder']);
      }),
  );
});
