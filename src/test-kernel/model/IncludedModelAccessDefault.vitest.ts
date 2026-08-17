/**
 * Bring-your-own-key is the model layer's default (issue #9328).
 *
 * Two directions, deliberately separate because a regression in either one is
 * a billing incident: a process that installs no included-access provider must
 * run on a plain API key and must never address TeXRA's relay, and it must stay
 * that way even when a state store is present — the condition under which
 * `ServerSideKeyService` itself defaults the preference on.
 */

import { strict as assert } from 'node:assert';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelProvider } from 'llm-zoo';

import { ModelHandlerOpenAI } from '@agent/modelHandlers/openai/modelHandlerOpenAI';
import type {
  ModelCredentialSelection,
  ResolvedClientCredential,
} from '@agent/types/ModelHandlerContracts';
import { ServerSideKeyService } from '@auth/serverKeys/ServerSideKeyService';
import type { TierService } from '@auth/serverKeys/TierService';
import { apiKeySecretName, invalidateApiKeyCache } from '@model/apiProviders';
import {
  includedModelAccess,
  setIncludedModelAccess,
} from '@model/includedModelAccess';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import { FakeStateStore } from '@test/support/FakePlatform';
import { installPlatform } from '@test/support/setupPlatform';

const OPENAI_CONFIG = Object.freeze({
  name: 'gpt-5.5',
  label: 'GPT-5.5',
  fullName: 'gpt-5.5-2026-04-15',
  shortName: 'gpt-5.5',
  provider: ModelProvider.OPENAI,
  maxOutputTokens: 16_384,
});

class ExposedHandler extends ModelHandlerOpenAI {
  exposeResolveClientCredential(
    selection?: ModelCredentialSelection,
  ): Promise<ResolvedClientCredential> {
    return this.resolveClientCredential(selection);
  }
}

/** Build a handler over the OpenAI test config and always dispose it. */
async function withHandler(
  run: (handler: ExposedHandler) => Promise<void>,
): Promise<void> {
  const handler = new ExposedHandler(buildTestModelConfig(OPENAI_CONFIG));
  try {
    await run(handler);
  } finally {
    handler.dispose();
  }
}

describe('bring-your-own-key is the model layer default', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    // Nothing installed: exactly the state an embedder of the agent core is in.
    setIncludedModelAccess(null);
    invalidateApiKeyCache();
    await installPlatform({
      secrets: { [apiKeySecretName('openai')]: 'sk-openai-byok' },
    });
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('no network in this test'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setIncludedModelAccess(null);
  });

  it('resolves an explicit provider key without a Supabase client or relay call', () =>
    withHandler(async (handler) => {
      const credential = await handler.exposeResolveClientCredential();

      assert.equal(credential.route, 'api-key');
      assert.equal(credential.apiKey, 'sk-openai-byok');
      // `null` is the provider's own default base URL: no relay, no proxy.
      assert.equal(credential.baseUrl, null);
      // The relay is never contacted — not for a token, not for tier config.
      expect(fetchSpy).not.toHaveBeenCalled();
    }));

  it('names both remedies when no key is set and included access is off', async () => {
    await installPlatform({ secrets: {} });
    invalidateApiKeyCache();
    await withHandler(async (handler) => {
      await assert.rejects(handler.exposeResolveClientCredential(), (error) => {
        const message = String(error);
        assert.match(message, /Missing API key for openai/);
        assert.match(message, /Set a provider API key/);
        assert.match(message, /enable included model access/);
        return true;
      });
    });
  });

  it('refuses to fabricate a relay URL when nothing is installed', () => {
    assert.throws(
      () => includedModelAccess().getRelayBaseUrl(ModelProvider.OPENAI),
      /No included model access is installed/,
    );
  });

  it('stays off even though a state store defaults the preference on', async () => {
    // An empty store answers every read with its caller-supplied default.
    const globalState = new FakeStateStore();
    // The app-side service, given a store, defaults included access ON — the
    // behavior this ruling deliberately does not let a library inherit.
    const service = new ServerSideKeyService(
      'https://example.test',
      {} as TierService,
      globalState,
    );
    assert.equal(service.getUseIncludedModelAccess(), true);

    // The model layer nonetheless reports off, because no app installed a
    // provider. Presence of a state store is not consent to route traffic.
    const access = includedModelAccess();
    assert.equal(access.getUseIncludedModelAccess(), false);
    assert.equal(
      access.shouldUseServerSideKeysSync(ModelProvider.OPENAI, 'gpt-5.5'),
      false,
    );
    assert.equal(await access.canUseServerSideKeys(), false);
    assert.equal(await access.getAccessToken(), null);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
