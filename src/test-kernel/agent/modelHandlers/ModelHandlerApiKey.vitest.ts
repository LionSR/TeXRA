// Third-party imports
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { ModelProvider } from 'llm-zoo';

// Local imports - test support and handler under test
import { installPlatform } from '@test/support/setupPlatform';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import { ModelHandlerOpenRouterNative } from '@agent/modelHandlers/openrouter/modelHandlerOpenRouterNative';
import { SupabaseClient } from '@auth/SupabaseClient';
import * as serverKeysModule from '@auth/serverKeys';
import { apiKeySecretName, invalidateApiKeyCache } from '@model/apiProviders';

// Local imports - modules stubbed by these tests
import * as configUtilsModule from '@utils/config/configUtils';
import * as providerConfigModule from '@utils/config/providerConfig';

class ExposedKeyHandler extends ModelHandlerOpenRouterNative {
  exposeGetApiKey(): Promise<string> {
    return this.getApiKey();
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
  const canUseServerSideKeys = vi.fn(async () => {
    return options.hasServerAccess ?? false;
  });

  vi.spyOn(serverKeysModule, 'getServerSideKeyService').mockReturnValue({
    getUseIncludedModelAccess: () => options.useIncludedAccess ?? false,
    canUseServerSideKeys,
    wasQuotaAutoSwitched: () => options.quotaAutoSwitched ?? false,
    shouldUseServerSideKeysSync: () => options.shouldUseServerSideKeys ?? false,
  } as unknown as ReturnType<typeof serverKeysModule.getServerSideKeyService>);

  return { canUseServerSideKeys };
}

async function initFakePlatform(
  secrets: Record<string, string> = {},
): Promise<void> {
  await installPlatform({ secrets });
  invalidateApiKeyCache();
}

describe('ModelHandler.getApiKey resolution', () => {
  beforeEach(async () => {
    await initFakePlatform();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the relay token after priming included-access state', async () => {
    vi.spyOn(providerConfigModule, 'getUseOpenRouter').mockReturnValue(false);
    const { canUseServerSideKeys } = stubServerSideKeyService({
      useIncludedAccess: true,
      hasServerAccess: true,
      shouldUseServerSideKeys: true,
    });
    const relayToken = vi
      .spyOn(SupabaseClient, 'getRelayAccessToken')
      .mockResolvedValue('relay-token');

    const handler = new ExposedKeyHandler(
      buildTestModelConfig(API_KEY_TEST_CONFIG),
    );

    assert.equal(await handler.exposeGetApiKey(), 'relay-token');
    assert.equal(canUseServerSideKeys.mock.calls.length, 1);
    assert.equal(relayToken.mock.calls.length, 1);
  });

  it('blocks relay quota exhaustion before reading any key', async () => {
    vi.spyOn(providerConfigModule, 'getUseOpenRouter').mockReturnValue(false);
    stubServerSideKeyService({
      useIncludedAccess: true,
      hasServerAccess: true,
      shouldUseServerSideKeys: true,
      quotaAutoSwitched: true,
    });
    const relayToken = vi
      .spyOn(SupabaseClient, 'getRelayAccessToken')
      .mockResolvedValue('relay-token');

    const handler = new ExposedKeyHandler(
      buildTestModelConfig(API_KEY_TEST_CONFIG),
    );

    await assert.rejects(
      handler.exposeGetApiKey(),
      /monthly relay quota is exhausted/,
    );
    assert.equal(relayToken.mock.calls.length, 0);
  });

  it('uses the OpenRouter key before included-access tier mismatch handling', async () => {
    await initFakePlatform({
      [apiKeySecretName('openRouter')]: 'openrouter-key',
      [apiKeySecretName('openai')]: 'personal-key',
    });
    vi.spyOn(providerConfigModule, 'getUseOpenRouter').mockReturnValue(false);
    stubServerSideKeyService({
      useIncludedAccess: true,
      hasServerAccess: true,
      shouldUseServerSideKeys: false,
    });

    const handler = new ExposedKeyHandler(
      buildTestModelConfig(API_KEY_TEST_CONFIG, { openRouterOnly: true }),
    );

    assert.equal(await handler.exposeGetApiKey(), 'openrouter-key');
  });

  it('uses a managed direct key without consulting relay state', async () => {
    await initFakePlatform({
      [apiKeySecretName('kimiCode')]: 'kimi-code-key',
    });
    vi.spyOn(providerConfigModule, 'getUseOpenRouter').mockReturnValue(true);
    vi.spyOn(configUtilsModule, 'getConfig').mockImplementation(
      <T>(path: string, defaultValue?: T) =>
        (path === 'texra.model.useImprovedConnection'
          ? true
          : defaultValue) as T,
    );
    const { canUseServerSideKeys } = stubServerSideKeyService({
      useIncludedAccess: true,
      hasServerAccess: true,
      shouldUseServerSideKeys: true,
      quotaAutoSwitched: true,
    });
    const relayToken = vi
      .spyOn(SupabaseClient, 'getRelayAccessToken')
      .mockResolvedValue('relay-token');
    const handler = new ExposedKeyHandler(
      buildTestModelConfig(API_KEY_TEST_CONFIG, {
        provider: ModelProvider.MOONSHOT,
        kimiSubscription: true,
        baseUrl: 'https://api.kimi.com/coding/v1',
        openrouterFullName: undefined,
      }),
    );

    assert.equal(handler.getBaseUrl(), 'https://api.kimi.com/coding/v1');
    assert.equal(await handler.exposeGetApiKey(), 'kimi-code-key');
    assert.equal(canUseServerSideKeys.mock.calls.length, 0);
    assert.equal(relayToken.mock.calls.length, 0);
  });

  it('rejects tier-mismatched included access instead of falling back to personal keys', async () => {
    vi.spyOn(providerConfigModule, 'getUseOpenRouter').mockReturnValue(false);
    stubServerSideKeyService({
      useIncludedAccess: true,
      hasServerAccess: true,
      shouldUseServerSideKeys: false,
    });

    const handler = new ExposedKeyHandler(
      buildTestModelConfig(API_KEY_TEST_CONFIG),
    );

    await assert.rejects(
      handler.exposeGetApiKey(),
      /not available with your current subscription tier/,
    );
  });

  it('uses the personal provider key when included access is not authenticated', async () => {
    await initFakePlatform({
      [apiKeySecretName('openai')]: 'personal-key',
    });
    vi.spyOn(providerConfigModule, 'getUseOpenRouter').mockReturnValue(false);
    const { canUseServerSideKeys } = stubServerSideKeyService({
      useIncludedAccess: true,
      hasServerAccess: false,
      shouldUseServerSideKeys: false,
    });

    const handler = new ExposedKeyHandler(
      buildTestModelConfig(API_KEY_TEST_CONFIG),
    );

    assert.equal(await handler.exposeGetApiKey(), 'personal-key');
    assert.equal(canUseServerSideKeys.mock.calls.length, 1);
  });
});
