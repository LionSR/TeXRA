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
import { classifyAgentError } from '@common/errors';
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

  it('uses the OpenRouter key for an OpenRouter-only model', async () => {
    await initFakePlatform({
      [apiKeySecretName('openRouter')]: 'openrouter-key',
      [apiKeySecretName('openai')]: 'personal-key',
    });

    const handler = newHandler({ openRouterOnly: true });

    assert.equal(await handler.exposeGetApiKey(), 'openrouter-key');
  });

  it('uses a managed direct key even while OpenRouter is on', async () => {
    await initFakePlatform({
      [apiKeySecretName('kimiCode')]: 'kimi-code-key',
    });
    vi.spyOn(providerConfigModule, 'getUseOpenRouter').mockReturnValue(true);
    const handler = newHandler({
      provider: ModelProvider.MOONSHOT,
      kimiSubscription: true,
      baseUrl: 'https://api.kimi.com/coding/v1',
      openrouterFullName: undefined,
    });

    assert.equal(handler.getBaseUrl(), 'https://api.kimi.com/coding/v1');
    assert.equal(await handler.exposeGetApiKey(), 'kimi-code-key');
  });

  it('uses the personal provider key', async () => {
    await initFakePlatform({
      [apiKeySecretName('openai')]: 'personal-key',
    });

    const handler = newHandler();

    assert.equal(await handler.exposeGetApiKey(), 'personal-key');
  });

  it('tags its missing-key throw so the run classifies it without reading the message', async () => {
    // fetchApiKeyOrThrow is the one producer of the missing-credential fact.
    // `classifyAgentError` reads the marker it attaches, so the per-provider
    // wording above is free to change without silently reclassifying the run
    // as `unexpected` (which is what the deleted substring predicates did to
    // the OpenRouter variant, whose wording they never matched).
    vi.spyOn(providerConfigModule, 'getUseOpenRouter').mockReturnValue(true);
    const handler = newHandler();

    const error = await handler.exposeResolveClientCredential().then(
      () => undefined,
      (caught: unknown) => caught,
    );

    assert.match(String(error), /Missing OpenRouter API key/);
    assert.equal(classifyAgentError(error), 'missing-api-key');
  });
});
