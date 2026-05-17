// Third-party imports
import { DEFAULT_MODEL_CAPABILITIES, ModelProvider } from 'llm-zoo';
import { describe, expect, it, vi } from 'vitest';

// Local imports - agent model handlers
import { ModelHandlerAnthropic } from '@agent/modelHandlers/modelHandlerAnthropic';

// Type imports
import type { AgentLogger } from '@logger/AgentLogger';
import type { ToolDefinition } from '@model';
import type Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';

const EXTENDED_CACHE_TTL_BETA = 'extended-cache-ttl-2025-04-11';

function createHandler(): ModelHandlerAnthropic {
  const handler = new ModelHandlerAnthropic({
    name: 'test-anthropic',
    label: 'Test Anthropic',
    fullName: 'claude-test',
    shortName: 'claude-test',
    provider: ModelProvider.ANTHROPIC,
    maxOutputTokens: 1024,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 200000,
    capabilities: {
      ...DEFAULT_MODEL_CAPABILITIES,
      supportsPromptCaching: true,
      supportsTokenCounting: true,
      supportsReasoning: false,
    },
    openRouterOnly: false,
  });

  handler.setLogger({
    streamId: 'test',
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fileList: vi.fn(),
    withCurrentGroup: vi.fn(() => undefined),
    runWithinCurrentGroup: vi.fn(async (fn: () => unknown) => fn()),
    runWithGroup: vi.fn(
      async (_groupId: string | undefined, fn: () => unknown) => fn(),
    ),
  } as unknown as AgentLogger);
  (handler as { getStreamingConfig: () => boolean }).getStreamingConfig = () =>
    false;
  return handler;
}

function createClient() {
  const createCalls: unknown[] = [];
  const countCalls: unknown[] = [];
  const client = {
    beta: {
      messages: {
        countTokens: vi.fn(async (params: unknown) => {
          countCalls.push(params);
          return { input_tokens: 10 };
        }),
        create: vi.fn(async (params: unknown) => {
          createCalls.push(params);
          return {
            id: 'msg',
            type: 'message',
            role: 'assistant',
            model: 'claude-test',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          };
        }),
      },
    },
  };

  return {
    client: client as unknown as Anthropic,
    createCalls,
    countCalls,
  };
}

const USER_MESSAGES: MessageParam[] = [
  {
    role: 'user',
    content: [{ type: 'text', text: 'hello', citations: null }],
  },
];

const TOOL: ToolDefinition = {
  name: 'lookup',
  description: 'Look up a value',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
};

function betasFrom(call: unknown): string[] {
  return ((call as { betas?: string[] }).betas ?? []) as string[];
}

describe('Anthropic extended cache TTL beta', () => {
  it('adds the beta to create and token-count requests when tool-use uses a 1h cache TTL', async () => {
    const { client, createCalls, countCalls } = createClient();

    await createHandler().createResponse({
      client,
      messages: structuredClone(USER_MESSAGES),
      temperature: 0,
      tools: [TOOL],
    });

    expect(betasFrom(createCalls[0])).toContain(EXTENDED_CACHE_TTL_BETA);
    expect(betasFrom(countCalls[0])).toContain(EXTENDED_CACHE_TTL_BETA);
  });

  it('does not add the beta to simple 5-minute cache requests', async () => {
    const { client, createCalls, countCalls } = createClient();

    await createHandler().createResponse({
      client,
      messages: structuredClone(USER_MESSAGES),
      temperature: 0,
    });

    expect(betasFrom(createCalls[0])).not.toContain(EXTENDED_CACHE_TTL_BETA);
    expect(betasFrom(countCalls[0])).not.toContain(EXTENDED_CACHE_TTL_BETA);
  });

  it('adds the beta when a retained compaction block carries a 1h cache marker', async () => {
    const { client, createCalls, countCalls } = createClient();
    const messages: MessageParam[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'compaction',
            content: '<summary>state</summary>',
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ] as any,
      },
      ...structuredClone(USER_MESSAGES),
    ];

    await createHandler().createResponse({
      client,
      messages,
      temperature: 0,
    });

    expect(betasFrom(createCalls[0])).toContain(EXTENDED_CACHE_TTL_BETA);
    expect(betasFrom(countCalls[0])).toContain(EXTENDED_CACHE_TTL_BETA);
  });
});
