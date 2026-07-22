// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ModelConfig, ModelProvider } from 'llm-zoo';

// Local imports
import type { AgentTrace } from '@agent/trace';
import type {
  ModelCredentialSelection,
  ResolvedClientCredential,
} from '@agent/types/ModelHandlerContracts';
import { ModelHandlerOpenAI } from '@agent/modelHandlers/openai/modelHandlerOpenAI';
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/openai/modelHandlerOpenAIResponse';
import {
  longRunningModelFetch,
  MODEL_STREAM_INACTIVITY_TIMEOUT_MS,
} from '@agent/modelHandlers/support/longRunningModelFetch';
import * as serverKeysModule from '@auth/serverKeys';
import { KIMI_CODE_BASE_URL } from '@model/kimiCodeSubscriptionRouting';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';

const MOONSHOT_BASE_URL = 'https://api.moonshot.ai/v1';
const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const RELAY_BASE_URL = 'https://relay.example.test/openai';
const TEST_API_KEY = 'test-secret-key';

function diagnosticRoute(
  config: ModelConfig,
  useRelay: boolean,
): ResolvedClientCredential['route'] {
  if (useRelay) return 'relay';
  if (config.openRouterOnly) return 'openrouter';
  return 'api-key';
}

const KIMI_DIAGNOSTICS_CONFIG = Object.freeze({
  name: 'kimi-test',
  fullName: 'kimi-k2.5',
  shortName: 'kimi-k2.5',
  label: 'Kimi Test',
  provider: ModelProvider.MOONSHOT,
  contextWindow: 262_144,
  baseUrl: MOONSHOT_BASE_URL,
});

class TestModelHandlerOpenAI extends ModelHandlerOpenAI {
  constructor(
    config: ModelConfig,
    private readonly useRelay: boolean,
  ) {
    super(config);
  }

  protected override shouldUseServerSideKeys(): boolean {
    return this.useRelay;
  }

  protected override async resolveClientCredential(
    _selection: ModelCredentialSelection = 'configured',
  ): Promise<ResolvedClientCredential> {
    return {
      apiKey: TEST_API_KEY,
      baseUrl: this.getBaseUrl(),
      route: diagnosticRoute(this.config, this.useRelay),
    };
  }
}

class TestModelHandlerOpenAIResponse extends ModelHandlerOpenAIResponse {
  constructor(
    config: ModelConfig,
    private readonly useRelay: boolean,
  ) {
    super(config);
  }

  protected override shouldUseServerSideKeys(): boolean {
    return this.useRelay;
  }

  protected override async resolveClientCredential(
    _selection: ModelCredentialSelection = 'configured',
  ): Promise<ResolvedClientCredential> {
    return {
      apiKey: TEST_API_KEY,
      baseUrl: this.getBaseUrl(),
      route: diagnosticRoute(this.config, this.useRelay),
    };
  }
}

type OpenAICompatibleHandler =
  TestModelHandlerOpenAI | TestModelHandlerOpenAIResponse;

function createHandlers(
  config: ModelConfig,
  useRelay: boolean,
): OpenAICompatibleHandler[] {
  return [
    new TestModelHandlerOpenAI(config, useRelay),
    new TestModelHandlerOpenAIResponse(config, useRelay),
  ];
}

async function clientDiagnostics(
  config: ModelConfig,
  { useRelay = false }: { useRelay?: boolean } = {},
): Promise<string[]> {
  const messages: string[] = [];
  const logger = {
    debug: vi.fn((message: string) => messages.push(message)),
  } as unknown as AgentTrace;

  for (const handler of createHandlers(config, useRelay)) {
    handler.setLogger(logger);
    await handler.getClient();
  }
  return messages;
}

function expectBothHandlers(messages: string[], expected: string): void {
  const clientConfigMessages = messages.filter((message) =>
    message.includes('. Model:'),
  );
  expect(clientConfigMessages).toEqual([expected, expected]);
  expect(messages.join('\n')).not.toContain(TEST_API_KEY);
}

describe('OpenAI-compatible client diagnostics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('leaves automatic retries to the session retry gate', async () => {
    const config = buildTestModelConfig(KIMI_DIAGNOSTICS_CONFIG);

    for (const handler of createHandlers(config, false)) {
      const client = await handler.getClient();
      expect(client.maxRetries).toBe(0);
      expect((client as unknown as { fetch: unknown }).fetch).toBe(
        longRunningModelFetch,
      );
    }
    expect(MODEL_STREAM_INACTIVITY_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });

  it('reports the Moonshot credential owner and request model', async () => {
    const messages = await clientDiagnostics(
      buildTestModelConfig(KIMI_DIAGNOSTICS_CONFIG),
    );

    expectBothHandlers(
      messages,
      `Using moonshot API key. Model: kimi-k2.5. Base URL: ${MOONSHOT_BASE_URL}`,
    );
  });

  it('reports the Kimi Code credential owner and final k3 wire model', async () => {
    const messages = await clientDiagnostics(
      buildTestModelConfig(KIMI_DIAGNOSTICS_CONFIG, {
        fullName: 'k3',
        shortName: 'k3',
        kimiSubscription: true,
        baseUrl: KIMI_CODE_BASE_URL,
      }),
    );

    expectBothHandlers(
      messages,
      `Using kimiCode API key. Model: k3. Base URL: ${KIMI_CODE_BASE_URL}`,
    );
  });

  it('reports the exclusive Kimi Code alias without rewriting its wire model', async () => {
    const messages = await clientDiagnostics(
      buildTestModelConfig(KIMI_DIAGNOSTICS_CONFIG, {
        name: 'kimi-for-coding',
        fullName: 'kimi-for-coding',
        shortName: 'kimi-for-coding',
        kimiSubscription: true,
        baseUrl: KIMI_CODE_BASE_URL,
      }),
    );

    expectBothHandlers(
      messages,
      `Using kimiCode API key. Model: kimi-for-coding. Base URL: ${KIMI_CODE_BASE_URL}`,
    );
  });

  it('reports OpenRouter credentials and endpoint for OpenRouter-only models', async () => {
    const messages = await clientDiagnostics(
      buildTestModelConfig(KIMI_DIAGNOSTICS_CONFIG, {
        fullName: 'moonshotai/kimi-k2.5',
        shortName: 'moonshotai/kimi-k2.5',
        openRouterOnly: true,
        baseUrl: undefined,
      }),
    );

    expectBothHandlers(
      messages,
      `Using OpenRouter API key. Model: moonshotai/kimi-k2.5. Base URL: ${OPENROUTER_BASE_URL}`,
    );
  });

  it('reports the relay access token and relay endpoint', async () => {
    vi.spyOn(serverKeysModule, 'getServerSideKeyService').mockReturnValue({
      getRelayBaseUrl: () => RELAY_BASE_URL,
    } as unknown as ReturnType<
      typeof serverKeysModule.getServerSideKeyService
    >);
    const messages = await clientDiagnostics(
      buildTestModelConfig(KIMI_DIAGNOSTICS_CONFIG, {
        name: 'gpt-test',
        fullName: 'gpt-test',
        shortName: 'gpt-test',
        provider: ModelProvider.OPENAI,
        baseUrl: undefined,
      }),
      { useRelay: true },
    );

    expectBothHandlers(
      messages,
      `Using TeXRA relay access token. Model: gpt-test. Base URL: ${RELAY_BASE_URL}`,
    );
  });

  it('reports the OpenAI client default when no base URL is configured', async () => {
    const messages = await clientDiagnostics(
      buildTestModelConfig(KIMI_DIAGNOSTICS_CONFIG, {
        name: 'gpt-test',
        fullName: 'gpt-test',
        shortName: 'gpt-test',
        provider: ModelProvider.OPENAI,
        baseUrl: undefined,
      }),
    );

    expectBothHandlers(
      messages,
      `Using openai API key. Model: gpt-test. Base URL: ${OPENAI_DEFAULT_BASE_URL}`,
    );
    expect(messages.join('\n')).not.toContain('Base URL: null');
  });
});
