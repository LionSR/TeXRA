import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelProvider,
  type ModelConfig,
} from 'llm-zoo';

import { ModelHandlerCodex } from '@agent/modelHandlers/openai/modelHandlerCodex';
import {
  CODEX_BACKEND_BASE_URL,
  resetCodexCoordinator,
  setPreferCodexSubscription,
} from '@auth/codex';
import { setServerSideKeyService } from '@auth/serverKeys';

import type { ResponseUsage } from 'openai/resources/responses/responses';

// Dynamic import keeps `initPlatform` out of the static import graph (it is
// restricted to composition roots); the routing tests use the same pattern.
async function initFakePlatformWithSubscription(): Promise<void> {
  const [{ initPlatform }, { createFakePlatform }] = await Promise.all([
    import('@platform/platform'),
    import('@test/support/FakePlatform'),
  ]);
  initPlatform(
    createFakePlatform({
      config: { 'texra.chatgptCodex.preferSubscription': true },
    }),
  );
}

const config: ModelConfig = {
  name: 'gpt55-test',
  label: 'GPT-5.5',
  fullName: 'gpt-5.5',
  shortName: 'gpt-5.5',
  provider: ModelProvider.OPENAI,
  maxOutputTokens: 1024,
  inputPrice: 2,
  outputPrice: 8,
  contextWindow: 128_000,
  capabilities: { ...DEFAULT_MODEL_CAPABILITIES },
  openRouterOnly: false,
};

const ONE_MILLION_INPUT_TOKENS = {
  input_tokens: 1_000_000,
  output_tokens: 0,
} as ResponseUsage;

describe('ModelHandlerCodex subscription fallback', () => {
  beforeEach(() => {
    // The fallback path resolves the OpenAI base via the relay service; stub it
    // to "no relay" so getBaseUrl() yields the direct OpenAI base.
    setServerSideKeyService({
      shouldUseServerSideKeysSync: () => false,
    } as never);
  });

  afterEach(() => {
    resetCodexCoordinator();
  });

  it('targets the Codex backend and zero-rates usage while the preference is on', async () => {
    await initFakePlatformWithSubscription();

    const handler = new ModelHandlerCodex(config);
    expect(handler.getBaseUrl()).toBe(CODEX_BACKEND_BASE_URL);
    expect(handler.computePrice(ONE_MILLION_INPUT_TOKENS)).toBe(0);
  });

  it('falls back to the OpenAI API-key path when the preference is turned off mid-run', async () => {
    await initFakePlatformWithSubscription();

    const handler = new ModelHandlerCodex(config);
    expect(handler.getBaseUrl()).toBe(CODEX_BACKEND_BASE_URL);

    // The "Use your own API key" switch flips this preference; the same handler
    // instance must reroute on the next request without being recreated.
    await setPreferCodexSubscription(false);

    expect(handler.getBaseUrl()).not.toBe(CODEX_BACKEND_BASE_URL);
    expect(handler.computePrice(ONE_MILLION_INPUT_TOKENS)).toBeGreaterThan(0);
  });
});
