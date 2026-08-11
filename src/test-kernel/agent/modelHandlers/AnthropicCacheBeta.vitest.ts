import type Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { ModelProvider } from 'llm-zoo';
import { describe, expect, it, vi } from 'vitest';

import { ModelHandlerAnthropic } from '@agent/modelHandlers/anthropic/modelHandlerAnthropic';
import type { ToolDefinition } from '@model/ToolDefinition';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import { spiedTrace } from '@test/support/spiedTrace';

const EXTENDED_CACHE_TTL_BETA = 'extended-cache-ttl-2025-04-11';

function createHandler(): ModelHandlerAnthropic {
  const handler = new ModelHandlerAnthropic(
    buildTestModelConfig({
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
        supportsPromptCaching: true,
        supportsTokenCounting: true,
        supportsReasoning: false,
      },
      openRouterOnly: false,
    }),
  );

  handler.setLogger(spiedTrace());
  handler.getStreamingConfig = () => false;
  return handler;
}

function createClient() {
  const createCalls: unknown[] = [];
  const countCalls: unknown[] = [];
  const beta = {
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
  };
  const client = {
    beta,
    withOptions: vi.fn(() => ({ beta })),
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
  return (call as { betas?: string[] }).betas ?? [];
}

function firstCompactionCacheControlFrom(call: unknown): unknown {
  const [firstMessage] = (call as { messages: MessageParam[] }).messages;
  if (!Array.isArray(firstMessage.content)) {
    return undefined;
  }
  return (firstMessage.content[0] as { cache_control?: unknown }).cache_control;
}

function compactionMessages(): MessageParam[] {
  return [
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
}

async function runRequest(
  messages: MessageParam[],
  tools?: ToolDefinition[],
): Promise<{ createCalls: unknown[]; countCalls: unknown[] }> {
  const { client, createCalls, countCalls } = createClient();
  await createHandler().createResponse({
    client,
    messages,
    temperature: 0,
    ...(tools ? { tools } : {}),
  });
  return { createCalls, countCalls };
}

describe('Anthropic extended cache TTL beta', () => {
  it('adds the beta to create and token-count requests when tool-use uses a 1h cache TTL', async () => {
    const { createCalls, countCalls } = await runRequest(
      structuredClone(USER_MESSAGES),
      [TOOL],
    );

    expect(betasFrom(createCalls[0])).toContain(EXTENDED_CACHE_TTL_BETA);
    expect(betasFrom(countCalls[0])).toContain(EXTENDED_CACHE_TTL_BETA);
  });

  it('does not add the beta to simple 5-minute cache requests', async () => {
    const { createCalls, countCalls } = await runRequest(
      structuredClone(USER_MESSAGES),
    );

    expect(betasFrom(createCalls[0])).not.toContain(EXTENDED_CACHE_TTL_BETA);
    expect(betasFrom(countCalls[0])).not.toContain(EXTENDED_CACHE_TTL_BETA);
  });

  it('adds the beta when a retained compaction block uses a long-TTL request', async () => {
    const { createCalls, countCalls } = await runRequest(compactionMessages(), [
      TOOL,
    ]);

    expect(betasFrom(createCalls[0])).toContain(EXTENDED_CACHE_TTL_BETA);
    expect(betasFrom(countCalls[0])).toContain(EXTENDED_CACHE_TTL_BETA);
    expect(firstCompactionCacheControlFrom(createCalls[0])).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    });
  });

  it('normalizes retained compaction blocks to a short TTL for non-tool requests', async () => {
    const { createCalls, countCalls } = await runRequest(compactionMessages());

    expect(firstCompactionCacheControlFrom(createCalls[0])).toEqual({
      type: 'ephemeral',
    });
    expect(firstCompactionCacheControlFrom(countCalls[0])).toEqual({
      type: 'ephemeral',
    });
    expect(betasFrom(createCalls[0])).not.toContain(EXTENDED_CACHE_TTL_BETA);
    expect(betasFrom(countCalls[0])).not.toContain(EXTENDED_CACHE_TTL_BETA);
  });
});
