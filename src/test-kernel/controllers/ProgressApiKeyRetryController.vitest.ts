import { Redacted } from 'effect';
// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import { ProgressApiKeyRetryController } from '@controllers/progressView/ProgressApiKeyRetryController';
import type { ApiProvider } from '@model/apiProviders';
import type { AppState } from '@platform/interfaces';
import type { RunId } from '@shared/schemas';
import { fakeProcessServices } from '@test/support/setupPlatform';

/**
 * `it.effect` for this suite. Every controller entry point reads the process
 * global state through `AppState`; the fake host installed for the test
 * supplies it, so the services are provided per test rather than captured at
 * collection time.
 */
function itHosted<A, E>(
  name: string,
  body: () => Effect.Effect<A, E, AppState>,
): void {
  it.effect(name, () => Effect.provide(body(), fakeProcessServices()));
}

/** The controller's deps are file-local; derive them from its constructor. */
type ProgressApiKeyRetryControllerDeps = ConstructorParameters<
  typeof ProgressApiKeyRetryController
>[0];

interface HarnessOptions {
  keys?: Partial<Record<ApiProvider, string | undefined>>;
  prompt?(keys: Map<ApiProvider, string | undefined>): void;
  retryAvailable?: boolean;
  retryPending?: boolean;
  isRetryPending?: ProgressApiKeyRetryControllerDeps['isRetryPending'];
}

function createHarness(options: HarnessOptions = {}): {
  controller: ProgressApiKeyRetryController;
  keys: Map<ApiProvider, string | undefined>;
  prompts: ApiProvider[];
  retries: string[];
} {
  const keys = new Map<ApiProvider, string | undefined>(
    Object.entries(options.keys ?? {}) as Array<
      [ApiProvider, string | undefined]
    >,
  );
  const prompts: ApiProvider[] = [];
  const retries: string[] = [];

  return {
    keys,
    prompts,
    retries,
    controller: new ProgressApiKeyRetryController({
      readKey: (provider) =>
        Effect.sync(() => {
          // The fixture keeps plain strings; the port hands out sealed values,
          // which compare by value so a re-entered identical key reads
          // unchanged.
          const key = keys.get(provider);
          return key === undefined ? undefined : Redacted.make(key);
        }),
      hasUsableKey: (provider) =>
        Effect.sync(() => (keys.get(provider)?.trim().length ?? 0) > 0),
      promptForApiKey: (provider) =>
        Effect.sync(() => {
          prompts.push(provider);
          options.prompt?.(keys);
        }),
      isRetryPending:
        options.isRetryPending ?? (() => options.retryPending ?? true),
      triggerRetry: (stream) =>
        Effect.sync(() => {
          retries.push(stream);
          return options.retryAvailable ?? true;
        }),
    }),
  };
}

describe('ProgressApiKeyRetryController', () => {
  itHosted(
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
          requireNewKey: true,
        });

        expect(harness.prompts).toStrictEqual(['anthropic']);
        expect(harness.retries).toStrictEqual(['stream-a']);
      }),
  );

  itHosted('does not retry when a depleted provider key was not changed', () =>
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
        requireNewKey: true,
      });

      expect(harness.prompts).toStrictEqual(['anthropic']);
      expect(harness.retries).toStrictEqual([]);
    }),
  );

  itHosted('does not retry after the retry request was replaced', () =>
    Effect.gen(function* () {
      const harness = createHarness({
        keys: { anthropic: 'stored-key' },
        retryPending: false,
      });

      yield* harness.controller.useOwnApiKey({
        stream: 'stream-a' as RunId,
        requestId: 'retry:stale',
        provider: 'anthropic',
        requireNewKey: false,
      });

      expect(harness.retries).toStrictEqual([]);
    }),
  );

  itHosted('retries with the existing OpenAI key without prompting', () =>
    Effect.gen(function* () {
      const harness = createHarness({ keys: { openai: 'stored-openai' } });

      yield* harness.controller.useOwnApiKey({
        stream: 'stream-d' as RunId,
        requestId: 'retry-d',
        provider: 'openai',
        requireNewKey: false,
      });

      // The subscription quota failed, not the key — a stored key is already
      // usable, so "Use your own API key" must not jump to the key-input
      // prompt. The route the run turns away from is the run's own decision,
      // recorded on its ledger, not a write to the user's settings.
      expect(harness.prompts).toStrictEqual([]);
      expect(harness.retries).toStrictEqual(['stream-d']);
    }),
  );

  itHosted('does not retry when no usable OpenAI key is available', () =>
    Effect.gen(function* () {
      const harness = createHarness({ keys: {} });

      yield* harness.controller.useOwnApiKey({
        stream: 'stream-e' as RunId,
        requestId: 'retry-e',
        provider: 'openai',
        requireNewKey: false,
      });

      // No usable key exists, so the prompt is still shown (then declined here).
      expect(harness.prompts).toStrictEqual(['openai']);
      expect(harness.retries).toStrictEqual([]);
    }),
  );

  itHosted(
    'prepares an existing direct key for a fresh Copilot fallback without retrying in place',
    () =>
      Effect.gen(function* () {
        const harness = createHarness({
          keys: { anthropic: 'stored-anthropic' },
        });

        const proceeded = yield* harness.controller.ensureOwnApiKey(
          'anthropic',
          false,
        );

        expect(proceeded).toBe(true);
        expect(harness.prompts).toStrictEqual([]);
        // The Copilot fallback launches a replacement run; nothing is retried
        // in place, and no preference of the user's is written.
        expect(harness.retries).toStrictEqual([]);
      }),
  );

  itHosted('rechecks the retry identity after the key prompt', () =>
    Effect.gen(function* () {
      let pendingChecks = 0;
      const harness = createHarness({
        keys: { openai: 'stored-openai' },
        isRetryPending: () => {
          pendingChecks += 1;
          return false;
        },
      });

      yield* harness.controller.useOwnApiKey({
        stream: 'stream-stale' as RunId,
        requestId: 'retry-stale',
        provider: 'openai',
        requireNewKey: false,
      });

      expect(harness.retries).toStrictEqual([]);
      expect(pendingChecks).toBe(1);
    }),
  );
});
