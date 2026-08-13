// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { ModelProvider } from 'llm-zoo';

// Local imports
import { ModelHandlerOpenRouterNative } from '@agent/modelHandlers/openrouter/modelHandlerOpenRouterNative';
import type {
  ModelCredentialSelection,
  ResolvedClientCredential,
} from '@agent/types/ModelHandlerContracts';
import { SupabaseClient } from '@auth/SupabaseClient';
import * as serverKeysModule from '@auth/serverKeys';
import { classifyAgentError } from '@common/errors';
import { installTexraModelAccess } from '@controllers/modelAccess/installTexraModelAccess';
import { apiKeySecretName, invalidateApiKeyCache } from '@model/apiProviders';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import { installPlatform } from '@test/support/setupPlatform';
import * as providerConfigModule from '@utils/config/providerConfig';

class ExposedKeyHandler extends ModelHandlerOpenRouterNative {
  exposeGetApiKey(): Promise<string> {
    return this.getApiKey();
  }

  exposeResolveClientCredential(
    selection?: ModelCredentialSelection,
  ): Promise<ResolvedClientCredential> {
    return this.resolveClientCredential(selection);
  }
}

const API_KEY_TEST_CONFIG = Object.freeze({
  name: 'gpt-5.5',
  label: 'GPT-5.5',
  fullName: 'gpt-5.5-2026-04-15',
  shortName: 'gpt-5.5',
  provider: ModelProvider.OPENAI,
  maxOutputTokens: 16_384,
  openrouterFullName: 'openai/gpt-5.5',
});

function stubServerSideKeyService(
  options: {
    readonly useIncludedAccess?: boolean;
    readonly hasServerAccess?: boolean;
    readonly shouldUseServerSideKeys?: boolean;
    readonly quotaAutoSwitched?: boolean;
  } = {},
): { readonly canUseServerSideKeys: ReturnType<typeof vi.fn> } {
  const canUseServerSideKeys = vi.fn(
    async () => options.hasServerAccess ?? false,
  );

  vi.spyOn(serverKeysModule, 'getServerSideKeyService').mockReturnValue({
    getUseIncludedModelAccess: () => options.useIncludedAccess ?? false,
    canUseServerSideKeys,
    wasQuotaAutoSwitched: () => options.quotaAutoSwitched ?? false,
    shouldUseServerSideKeysSync: () => options.shouldUseServerSideKeys ?? false,
    getRelayBaseUrl: () => 'https://relay.example.test/openai',
  } as unknown as ReturnType<typeof serverKeysModule.getServerSideKeyService>);
  installTexraModelAccess();

  return { canUseServerSideKeys };
}

async function initFakePlatform(
  secrets: Record<string, string> = {},
): Promise<void> {
  await installPlatform({ secrets });
  invalidateApiKeyCache();
}

function newHandler(
  overrides?: Parameters<typeof buildTestModelConfig>[1],
): ExposedKeyHandler {
  return new ExposedKeyHandler(
    buildTestModelConfig(API_KEY_TEST_CONFIG, overrides),
  );
}

function stubRelayToken(): ReturnType<typeof vi.spyOn> {
  return vi
    .spyOn(SupabaseClient, 'getRelayAccessToken')
    .mockResolvedValue('relay-token');
}

describe('ModelHandler.getApiKey resolution', () => {
  beforeEach(async () => {
    await initFakePlatform();
    // Most cases exercise the direct-provider route; the OpenRouter-routed
    // cases override this with `true`.
    vi.spyOn(providerConfigModule, 'getUseOpenRouter').mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the relay token after priming included-access state', async () => {
    const { canUseServerSideKeys } = stubServerSideKeyService({
      useIncludedAccess: true,
      hasServerAccess: true,
      shouldUseServerSideKeys: true,
    });
    const relayToken = stubRelayToken();

    const handler = newHandler();

    assert.equal(await handler.exposeGetApiKey(), 'relay-token');
    assert.equal(canUseServerSideKeys.mock.calls.length, 1);
    assert.equal(relayToken.mock.calls.length, 1);
  });

  it('blocks relay quota exhaustion before reading any key', async () => {
    stubServerSideKeyService({
      useIncludedAccess: true,
      hasServerAccess: true,
      shouldUseServerSideKeys: true,
      quotaAutoSwitched: true,
    });
    const relayToken = stubRelayToken();

    const handler = newHandler();

    await assert.rejects(
      handler.exposeGetApiKey(),
      /used all of this month's included access/,
    );
    assert.equal(relayToken.mock.calls.length, 0);
  });

  it('uses the OpenRouter key before included-access tier mismatch handling', async () => {
    await initFakePlatform({
      [apiKeySecretName('openRouter')]: 'openrouter-key',
      [apiKeySecretName('openai')]: 'personal-key',
    });
    stubServerSideKeyService({
      useIncludedAccess: true,
      hasServerAccess: true,
      shouldUseServerSideKeys: false,
    });

    const handler = newHandler({ openRouterOnly: true });

    assert.equal(await handler.exposeGetApiKey(), 'openrouter-key');
  });

  it('uses a managed direct key without consulting relay state', async () => {
    await initFakePlatform({
      [apiKeySecretName('kimiCode')]: 'kimi-code-key',
    });
    vi.spyOn(providerConfigModule, 'getUseOpenRouter').mockReturnValue(true);
    const { canUseServerSideKeys } = stubServerSideKeyService({
      useIncludedAccess: true,
      hasServerAccess: true,
      shouldUseServerSideKeys: true,
      quotaAutoSwitched: true,
    });
    const relayToken = stubRelayToken();
    const handler = newHandler({
      provider: ModelProvider.MOONSHOT,
      kimiSubscription: true,
      baseUrl: 'https://api.kimi.com/coding/v1',
      openrouterFullName: undefined,
    });

    assert.equal(handler.getBaseUrl(), 'https://api.kimi.com/coding/v1');
    assert.equal(await handler.exposeGetApiKey(), 'kimi-code-key');
    assert.equal(canUseServerSideKeys.mock.calls.length, 0);
    assert.equal(relayToken.mock.calls.length, 0);
  });

  it('rejects tier-mismatched included access instead of falling back to personal keys', async () => {
    stubServerSideKeyService({
      useIncludedAccess: true,
      hasServerAccess: true,
      shouldUseServerSideKeys: false,
    });

    const handler = newHandler();

    await assert.rejects(
      handler.exposeGetApiKey(),
      /not available with your current subscription tier/,
    );
  });

  it('uses the personal provider key when included access is not authenticated', async () => {
    await initFakePlatform({
      [apiKeySecretName('openai')]: 'personal-key',
    });
    const { canUseServerSideKeys } = stubServerSideKeyService({
      useIncludedAccess: true,
      hasServerAccess: false,
      shouldUseServerSideKeys: false,
    });

    const handler = newHandler();

    assert.equal(await handler.exposeGetApiKey(), 'personal-key');
    assert.equal(canUseServerSideKeys.mock.calls.length, 1);
  });

  it('can reject a personal candidate without disturbing the configured relay route', async () => {
    const { canUseServerSideKeys } = stubServerSideKeyService({
      useIncludedAccess: true,
      hasServerAccess: true,
      shouldUseServerSideKeys: true,
    });
    stubRelayToken();
    const handler = newHandler();

    await assert.rejects(
      handler.exposeResolveClientCredential('personal'),
      /Missing API key for openai/,
    );
    const configured = await handler.exposeResolveClientCredential();

    assert.equal(configured.route, 'relay');
    assert.equal(configured.apiKey, 'relay-token');
    assert.equal(canUseServerSideKeys.mock.calls.length, 1);
  });

  it('tags its missing-key throw so the run classifies it without reading the message', async () => {
    // fetchApiKeyOrThrow is the one producer of the missing-credential fact.
    // `classifyAgentError` reads the marker it attaches, so the per-provider
    // wording above is free to change without silently reclassifying the run
    // as `unexpected` (which is what the deleted substring predicates did to
    // the OpenRouter variant, whose wording they never matched).
    vi.spyOn(providerConfigModule, 'getUseOpenRouter').mockReturnValue(true);
    stubServerSideKeyService();
    const handler = newHandler();

    const error = await handler.exposeResolveClientCredential().then(
      () => undefined,
      (caught: unknown) => caught,
    );

    assert.match(String(error), /Missing OpenRouter API key/);
    assert.equal(classifyAgentError(error), 'missing-api-key');
  });
});
