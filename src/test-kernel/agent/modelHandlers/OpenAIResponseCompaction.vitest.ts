// Third-party imports
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MODEL_CAPABILITIES,
  type ModelConfig,
  ModelProvider,
} from 'llm-zoo';

// Local imports - agent model handlers
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/modelHandlerOpenAIResponse';

// Type imports
import type { AgentLogger } from '@logger/AgentLogger';
import type { ResponseInputItem } from 'openai/resources/responses/responses';

function createLoggerStub(): Partial<AgentLogger> & { streamId: string } {
  return {
    streamId: 'test-channel',
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    logProgress: vi.fn(),
    logContextManagement: vi.fn(),
    withCurrentGroup: vi.fn(),
    runWithinCurrentGroup: async <T>(fn: () => T | Promise<T>) => fn(),
    runWithGroup: async <T>(
      _groupId: string | undefined,
      fn: () => T | Promise<T>,
    ) => fn(),
  };
}

function createConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    name: 'gpt-4.1',
    fullName: 'gpt-4.1',
    shortName: 'gpt-4.1',
    label: 'GPT 4.1',
    provider: ModelProvider.OPENAI,
    maxOutputTokens: overrides.maxOutputTokens ?? 100,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: overrides.contextWindow ?? 1000,
    capabilities: {
      ...DEFAULT_MODEL_CAPABILITIES,
      supportsReasoning: false,
      supportsVision: false,
      ...(overrides.capabilities ?? {}),
    },
    openRouterOnly: overrides.openRouterOnly ?? false,
  };
}

function createHandler(): ModelHandlerOpenAIResponse {
  const handler = new ModelHandlerOpenAIResponse(createConfig());
  handler.setLogger(createLoggerStub() as unknown as AgentLogger);
  (handler as { getStreamingConfig: () => boolean }).getStreamingConfig = () =>
    false;
  return handler;
}

function createResponse(id: string, inputTokens: number) {
  return {
    id,
    status: 'completed',
    output: [],
    output_text: 'ok',
    usage: { input_tokens: inputTokens },
  };
}

function createMessages(count: number): ResponseInputItem[] {
  return Array.from({ length: count }, (_, index) => ({
    role: 'user',
    content: `message ${index + 1}`,
  })) as ResponseInputItem[];
}

describe('ModelHandlerOpenAIResponse automatic compaction', () => {
  it('compacts before the next response when prior usage crosses the threshold', async () => {
    const handler = createHandler();
    const requests: any[] = [];
    const compactRequests: any[] = [];
    const compactedMessages = [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'compacted state' }],
      },
    ] as unknown as ResponseInputItem[];
    const client = {
      responses: {
        inputTokens: {
          count: async () => ({ input_tokens: 100 }),
        },
        compact: async (params: any) => {
          compactRequests.push(params);
          return {
            output: compactedMessages,
            usage: { output_tokens: 100 },
          };
        },
        create: async (params: any) => {
          requests.push(params);
          return requests.length === 1
            ? createResponse('resp-before-threshold', 800)
            : createResponse('resp-after-compaction', 150);
        },
      },
    };
    const firstTurnMessages = createMessages(2);
    const secondTurnMessages = createMessages(3);

    await handler.createResponse({
      client: client as any,
      messages: firstTurnMessages,
      temperature: 0,
    });
    const result = await handler.createResponse({
      client: client as any,
      messages: secondTurnMessages,
      temperature: 0,
    });

    expect(compactRequests).toHaveLength(1);
    expect(compactRequests[0].input).toEqual(secondTurnMessages);
    expect(requests).toHaveLength(2);
    expect(requests[1].previous_response_id).toBeUndefined();
    expect(requests[1].input).toEqual(compactedMessages);
    expect(result.updatedMessages).toEqual(compactedMessages);
  });
});
