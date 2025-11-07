// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type {
  ChatGenerationTokenUsage,
  ChatStreamingResponseChunkData,
} from '@openrouter/sdk/models';

// Local imports - agent
import {
  convertChatResponseToOpenAI,
  convertToOpenRouterMessages,
  createStreamAccumulator,
  consumeStreamChunk,
  finalizeStreamAccumulator,
  mapOpenRouterUsage,
} from '@agent/modelHandlers/utils/openRouterConversion';
import { toOpenRouterTools } from '@agent/modelHandlers/toolConversion';

// Local imports - model config
import type { ToolDefinition } from '@model';

describe('ModelHandlerOpenRouter conversions', () => {
  it('converts OpenAI-style messages into OpenRouter payloads', () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: 'Be concise.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe the figure.' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,AAA', detail: 'high' },
          },
          {
            type: 'input_audio',
            input_audio: { data: 'base64audio', format: 'mp3' },
          },
        ],
      },
      {
        role: 'assistant',
        content: 'Starting analysis.',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'fetch_data', arguments: '{"id":42}' },
          },
        ],
      } as ChatCompletionMessageParam,
      {
        role: 'tool',
        content: 'result payload',
        tool_call_id: 'call_1',
      },
    ];

    const converted = convertToOpenRouterMessages(messages);

    assert.equal(converted[0].role, 'system');
    assert.equal(converted[0].content, 'Be concise.');

    const userContent = converted[1].content;
    assert.ok(Array.isArray(userContent));
    assert.equal(userContent?.[0]?.type, 'text');
    assert.equal(userContent?.[0]?.text, 'Describe the figure.');
    assert.equal(userContent?.[1]?.type, 'image_url');
    assert.deepEqual(userContent?.[1]?.imageUrl, {
      url: 'data:image/png;base64,AAA',
      detail: 'high',
    });
    assert.equal(userContent?.[2]?.type, 'input_audio');
    assert.deepEqual(userContent?.[2]?.inputAudio, {
      data: 'base64audio',
      format: 'mp3',
    });

    const assistantMessage = converted[2];
    assert.equal(assistantMessage.role, 'assistant');
    assert.equal(assistantMessage.content, 'Starting analysis.');
    assert.deepEqual(assistantMessage.toolCalls, [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'fetch_data', arguments: '{"id":42}' },
      },
    ]);

    const toolMessage = converted[3];
    assert.equal(toolMessage.role, 'tool');
    assert.equal(toolMessage.toolCallId, 'call_1');
    assert.equal(toolMessage.content, 'result payload');
  });

  it('maps OpenRouter usage metrics to ExtendedCompletionUsage', () => {
    const usage: ChatGenerationTokenUsage = {
      promptTokens: 120,
      completionTokens: 80,
      totalTokens: 200,
      promptTokensDetails: { cachedTokens: 25 },
      completionTokensDetails: {
        reasoningTokens: 12,
        acceptedPredictionTokens: 3,
        rejectedPredictionTokens: 1,
      },
    };

    const mapped = mapOpenRouterUsage(usage);
    assert.ok(mapped);
    assert.equal(mapped?.prompt_tokens, 120);
    assert.equal(mapped?.completion_tokens, 80);
    assert.equal(mapped?.total_tokens, 200);
    assert.equal(mapped?.prompt_tokens_details?.cached_tokens, 25);
    assert.equal(mapped?.completion_tokens_details?.reasoning_tokens, 12);
    assert.equal(
      mapped?.completion_tokens_details?.accepted_prediction_tokens,
      3,
    );
    assert.equal(
      mapped?.completion_tokens_details?.rejected_prediction_tokens,
      1,
    );
  });

  it('aggregates streaming chunks into a ChatResponse', () => {
    const accumulator = createStreamAccumulator();

    const chunk1: ChatStreamingResponseChunkData = {
      id: 'stream-1',
      created: 111,
      model: 'openrouter/model',
      object: 'chat.completion.chunk',
      choices: [
        {
          index: 0,
          finishReason: null,
          delta: {
            role: 'assistant',
            content: 'Hello',
            reasoning: 'Thinking',
          },
        },
      ],
    };

    const chunk2: ChatStreamingResponseChunkData = {
      id: 'stream-2',
      created: 112,
      model: 'openrouter/model',
      object: 'chat.completion.chunk',
      choices: [
        {
          index: 0,
          finishReason: null,
          delta: {
            content: ' world!',
            toolCalls: [
              {
                id: 'tool_a',
                index: 0,
                type: 'function',
                function: { name: 'lookup', arguments: '{"q":"docs"}' },
              },
            ],
          },
        },
      ],
    };

    const chunk3: ChatStreamingResponseChunkData = {
      id: 'stream-3',
      created: 113,
      model: 'openrouter/model',
      object: 'chat.completion.chunk',
      systemFingerprint: 'fingerprint',
      usage: {
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
      },
      choices: [
        {
          index: 0,
          finishReason: 'stop',
          delta: {},
        },
      ],
    };

    consumeStreamChunk(accumulator, chunk1);
    consumeStreamChunk(accumulator, chunk2);
    consumeStreamChunk(accumulator, chunk3);

    const chatResponse = finalizeStreamAccumulator(
      accumulator,
      'fallback-model',
    );
    assert.equal(chatResponse.id, 'stream-3');
    assert.equal(chatResponse.choices[0].finishReason, 'stop');
    assert.equal(chatResponse.choices[0].message.content, 'Hello world!');
    assert.equal(chatResponse.choices[0].message.reasoning, 'Thinking');
    assert.deepEqual(chatResponse.choices[0].message.toolCalls, [
      {
        id: 'tool_a',
        type: 'function',
        function: { name: 'lookup', arguments: '{"q":"docs"}' },
      },
    ]);
    assert.deepEqual(chatResponse.usage, {
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
    });

    const openAIResponse = convertChatResponseToOpenAI(chatResponse);
    assert.equal(openAIResponse.choices[0].finish_reason, 'stop');
    assert.equal(openAIResponse.choices[0].message.content, 'Hello world!');
    assert.equal(openAIResponse.usage?.prompt_tokens, 10);
    assert.equal(openAIResponse.usage?.completion_tokens, 20);
  });

  it('converts ToolDefinition objects into OpenRouter tools', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'search',
        description: 'perform a search',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
        },
      },
    ];

    const converted = toOpenRouterTools(tools);
    assert.deepEqual(converted, [
      {
        type: 'function',
        function: {
          name: 'search',
          description: 'perform a search',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string' },
            },
          },
        },
      },
    ]);
  });
});
