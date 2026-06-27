// Standard library imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';

// Local imports - controllers
import { ProgressApiKeyRetryController } from '@controllers/progressView/ProgressApiKeyRetryController';

// Local imports - model
import type { ApiProvider } from '@model/apiProviders';

const PROVIDERS = [
  'openai',
  'anthropic',
] as const satisfies readonly ApiProvider[];

interface HarnessOptions {
  keys?: Partial<Record<ApiProvider, string | undefined>>;
  prompt?(keys: Map<ApiProvider, string | undefined>): void;
  retryAvailable?: boolean;
}

function createHarness(options: HarnessOptions = {}): {
  controller: ProgressApiKeyRetryController;
  keys: Map<ApiProvider, string | undefined>;
  prompts: Array<ApiProvider | undefined>;
  includedAccessValues: boolean[];
  codexDisableCount: number;
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
  let codexDisableCount = 0;
  let invalidations = 0;
  const retries: string[] = [];

  return {
    keys,
    prompts,
    includedAccessValues,
    get codexDisableCount() {
      return codexDisableCount;
    },
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
      setUseIncludedModelAccess: async (enabled) => {
        includedAccessValues.push(enabled);
      },
      disablePreferCodexSubscription: async () => {
        codexDisableCount += 1;
      },
      invalidateModelOptionsCache: () => {
        invalidations += 1;
      },
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
      provider: 'anthropic',
      upstreamCreditDepleted: true,
      viaRelay: true,
    });

    assert.deepEqual(result, {
      proceeded: true,
      retried: true,
      disabledIncludedModelAccess: true,
      disabledChatGptSubscription: false,
    });
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
      provider: 'anthropic',
      upstreamCreditDepleted: true,
      viaRelay: true,
    });

    assert.deepEqual(result, {
      proceeded: false,
      retried: false,
      disabledIncludedModelAccess: false,
      disabledChatGptSubscription: false,
    });
    assert.deepEqual(harness.prompts, ['anthropic']);
    assert.deepEqual(harness.includedAccessValues, []);
    assert.equal(harness.invalidations, 0);
    assert.deepEqual(harness.retries, []);
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
      upstreamCreditDepleted: true,
      viaRelay: true,
    });

    assert.deepEqual(result, {
      proceeded: true,
      retried: true,
      disabledIncludedModelAccess: true,
      disabledChatGptSubscription: false,
    });
    assert.deepEqual(harness.prompts, [undefined]);
    assert.deepEqual(harness.includedAccessValues, [false]);
    assert.equal(harness.invalidations, 1);
    assert.deepEqual(harness.retries, ['stream-b']);
  });

  it('uses any existing usable key for relay-limit consent', async () => {
    const harness = createHarness({
      keys: { openai: 'stored-key' },
    });

    const result = await harness.controller.useOwnApiKey({
      stream: 'stream-b',
      viaRelay: true,
    });

    assert.deepEqual(result, {
      proceeded: true,
      retried: true,
      disabledIncludedModelAccess: true,
      disabledChatGptSubscription: false,
    });
    assert.deepEqual(harness.prompts, [undefined]);
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
      provider: 'anthropic',
      viaRelay: false,
    });

    assert.deepEqual(result, {
      proceeded: true,
      retried: false,
      disabledIncludedModelAccess: false,
      disabledChatGptSubscription: false,
    });
    assert.deepEqual(harness.includedAccessValues, []);
    assert.equal(harness.invalidations, 0);
    assert.deepEqual(harness.retries, ['stream-c']);
  });

  it('disables the ChatGPT subscription and retries with a usable OpenAI key', async () => {
    const harness = createHarness({
      keys: { openai: 'stored-openai' },
    });

    const result = await harness.controller.useOwnApiKey({
      stream: 'stream-d',
      provider: 'openai',
      chatgptSubscription: true,
    });

    // The subscription switch also drops relay so the retry reaches the stored
    // OpenAI key rather than the relay JWT.
    assert.deepEqual(result, {
      proceeded: true,
      retried: true,
      disabledIncludedModelAccess: true,
      disabledChatGptSubscription: true,
    });
    assert.deepEqual(harness.prompts, ['openai']);
    assert.deepEqual(harness.includedAccessValues, [false]);
    assert.equal(harness.codexDisableCount, 1);
    assert.equal(harness.invalidations, 2);
    assert.deepEqual(harness.retries, ['stream-d']);
  });

  it('does not disable the subscription when no usable OpenAI key is available', async () => {
    const harness = createHarness({ keys: {} });

    const result = await harness.controller.useOwnApiKey({
      stream: 'stream-e',
      provider: 'openai',
      chatgptSubscription: true,
    });

    assert.deepEqual(result, {
      proceeded: false,
      retried: false,
      disabledIncludedModelAccess: false,
      disabledChatGptSubscription: false,
    });
    assert.equal(harness.codexDisableCount, 0);
    assert.deepEqual(harness.retries, []);
  });
});
