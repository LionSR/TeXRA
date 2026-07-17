import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MODEL_CAPABILITIES,
  type ModelConfig,
  ModelProvider,
} from 'llm-zoo';

import type { AgentTrace } from '@agent/trace';
import { ModelHandlerOpenAI } from '@agent/modelHandlers/openai/modelHandlerOpenAI';
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/openai/modelHandlerOpenAIResponse';
import * as serverKeysModule from '@auth/serverKeys';
import { KIMI_CODE_BASE_URL } from '@model/kimiCodeSubscriptionRouting';

const MOONSHOT_BASE_URL = 'https://api.moonshot.ai/v1';
const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const RELAY_BASE_URL = 'https://relay.example.test/openai';
const TEST_API_KEY = 'test-secret-key';

function createConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    name: 'kimi-test',
    fullName: 'kimi-k2.5',
    shortName: 'kimi-k2.5',
    label: 'Kimi Test',
    provider: ModelProvider.MOONSHOT,
    maxOutputTokens: 1024,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 262_144,
    openRouterOnly: false,
    baseUrl: MOONSHOT_BASE_URL,
    capabilities: DEFAULT_MODEL_CAPABILITIES,
    ...overrides,
  };
}

class TestModelHandlerOpenAI extends ModelHandlerOpenAI {
  constructor(
    config: ModelConfig,
    private readonly useRelay: boolean,
  ) {
    super(config);
  }

  protected override async getApiKey(): Promise<string> {
    return TEST_API_KEY;
  }

  protected override shouldUseServerSideKeys(): boolean {
    return this.useRelay;
  }
}

class TestModelHandlerOpenAIResponse extends ModelHandlerOpenAIResponse {
  constructor(
    config: ModelConfig,
    private readonly useRelay: boolean,
  ) {
    super(config);
  }

  protected override async getApiKey(): Promise<string> {
    return TEST_API_KEY;
  }

  protected override shouldUseServerSideKeys(): boolean {
    return this.useRelay;
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

  it('reports the Moonshot credential owner and request model', async () => {
    const messages = await clientDiagnostics(createConfig());

    expectBothHandlers(
      messages,
      `Using moonshot API key. Model: kimi-k2.5. Base URL: ${MOONSHOT_BASE_URL}`,
    );
  });

  it('reports the Kimi Code credential owner and final k3 wire model', async () => {
    const messages = await clientDiagnostics(
      createConfig({
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
      createConfig({
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
      createConfig({
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
      createConfig({
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
      createConfig({
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
