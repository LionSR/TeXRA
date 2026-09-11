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
import { KIMI_CODE_BASE_URL } from '@shared/constants/providers';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';

const MOONSHOT_BASE_URL = 'https://api.moonshot.ai/v1';
const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const TEST_API_KEY = 'test-secret-key';

function diagnosticCredential(
  config: ModelConfig,
  baseUrl: string | null,
): ResolvedClientCredential {
  return {
    apiKey: TEST_API_KEY,
    baseUrl,
    route: config.openRouterOnly ? 'openrouter' : 'api-key',
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
  protected override async resolveClientCredential(
    _selection: ModelCredentialSelection = 'configured',
  ): Promise<ResolvedClientCredential> {
    return diagnosticCredential(this.config, this.getBaseUrl());
  }
}

class TestModelHandlerOpenAIResponse extends ModelHandlerOpenAIResponse {
  protected override async resolveClientCredential(
    _selection: ModelCredentialSelection = 'configured',
  ): Promise<ResolvedClientCredential> {
    return diagnosticCredential(this.config, this.getBaseUrl());
  }
}

type OpenAICompatibleHandler =
  TestModelHandlerOpenAI | TestModelHandlerOpenAIResponse;

function createHandlers(config: ModelConfig): OpenAICompatibleHandler[] {
  return [
    new TestModelHandlerOpenAI(config),
    new TestModelHandlerOpenAIResponse(config),
  ];
}

async function clientDiagnostics(config: ModelConfig): Promise<string[]> {
  const messages: string[] = [];
  const logger = {
    debug: vi.fn((message: string) => messages.push(message)),
  } as unknown as AgentTrace;

  for (const handler of createHandlers(config)) {
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

    for (const handler of createHandlers(config)) {
      const client = await handler.getClient();
      expect(client.maxRetries).toBe(0);
      transports.push((client as unknown as { fetch: unknown }).fetch);
      handler.dispose();
    }
    expect(transports[0]).toBe(transports[1]);
  });
});
