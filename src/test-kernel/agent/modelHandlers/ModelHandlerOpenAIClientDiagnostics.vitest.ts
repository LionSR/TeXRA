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
import * as serverKeysModule from '@auth/serverKeys';
import { installTexraModelAccess } from '@controllers/modelAccess/installTexraModelAccess';
import { KIMI_CODE_BASE_URL } from '@shared/constants/providers';
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

function diagnosticCredential(
  config: ModelConfig,
  baseUrl: string | null,
  useRelay: boolean,
): ResolvedClientCredential {
  return {
    apiKey: TEST_API_KEY,
    baseUrl,
    route: diagnosticRoute(config, useRelay),
  };
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
    return diagnosticCredential(this.config, this.getBaseUrl(), this.useRelay);
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
    return diagnosticCredential(this.config, this.getBaseUrl(), this.useRelay);
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

interface ExpectedDiagnostics {
  /** Credential owner label, e.g. "moonshot API key". */
  owner: string;
  model: string;
  baseUrl: string;
}

function expectBothHandlers(
  messages: string[],
  expected: ExpectedDiagnostics,
): void {
  const clientConfigMessages = messages.filter((message) =>
    message.includes('Base URL:'),
  );
  // One client-config diagnostic per handler (chat + responses), each
  // reporting the credential owner, the wire model, and the endpoint.
  expect(clientConfigMessages).toHaveLength(2);
  for (const message of clientConfigMessages) {
    expect(message).toContain(expected.owner);
    expect(message).toContain(`Model: ${expected.model}`);
    expect(message).toContain(`Base URL: ${expected.baseUrl}`);
  }
  expect(messages.join('\n')).not.toContain(TEST_API_KEY);
}

describe('OpenAI-compatible client diagnostics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('leaves automatic retries to the session retry gate', async () => {
    const config = buildTestModelConfig(KIMI_DIAGNOSTICS_CONFIG);
    const transports: unknown[] = [];

    for (const handler of createHandlers(config, false)) {
      const client = await handler.getClient();
      expect(client.maxRetries).toBe(0);
      transports.push((client as unknown as { fetch: unknown }).fetch);
      handler.dispose();
    }
    expect(transports[0]).toBe(transports[1]);
  });

  it('reports the Moonshot credential owner and request model', async () => {
    const messages = await clientDiagnostics(
      buildTestModelConfig(KIMI_DIAGNOSTICS_CONFIG),
    );

    expectBothHandlers(messages, {
      owner: 'moonshot API key',
      model: 'kimi-k2.5',
      baseUrl: MOONSHOT_BASE_URL,
    });
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

    expectBothHandlers(messages, {
      owner: 'kimiCode API key',
      model: 'k3',
      baseUrl: KIMI_CODE_BASE_URL,
    });
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

    expectBothHandlers(messages, {
      owner: 'kimiCode API key',
      model: 'kimi-for-coding',
      baseUrl: KIMI_CODE_BASE_URL,
    });
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

    expectBothHandlers(messages, {
      owner: 'OpenRouter API key',
      model: 'moonshotai/kimi-k2.5',
      baseUrl: OPENROUTER_BASE_URL,
    });
  });

  it('reports the relay access token and relay endpoint', async () => {
    vi.spyOn(serverKeysModule, 'getServerSideKeyService').mockReturnValue({
      getRelayBaseUrl: () => RELAY_BASE_URL,
    } as unknown as ReturnType<
      typeof serverKeysModule.getServerSideKeyService
    >);
    installTexraModelAccess();
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

    expectBothHandlers(messages, {
      owner: 'TeXRA relay access token',
      model: 'gpt-test',
      baseUrl: RELAY_BASE_URL,
    });
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

    expectBothHandlers(messages, {
      owner: 'openai API key',
      model: 'gpt-test',
      baseUrl: OPENAI_DEFAULT_BASE_URL,
    });
    expect(messages.join('\n')).not.toContain('Base URL: null');
  });
});
