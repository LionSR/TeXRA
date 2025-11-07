// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

// Local imports - agent
import {
  accumulateStreamChunk,
  convertChatResponseToOpenAI,
  convertMessagesToOpenRouter,
  createStreamState,
  finalizeStream,
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

    const converted = convertMessagesToOpenRouter(messages);

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

  it('aggregates streaming chunks into a ChatResponse', () => {
    const state = createStreamState();

    const chunk1 = {
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
    } as any;

    const chunk2 = {
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
    } as any;

    const chunk3 = {
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
    } as any;

    accumulateStreamChunk(state, chunk1);
    accumulateStreamChunk(state, chunk2);
    accumulateStreamChunk(state, chunk3);

    const chatResponse = finalizeStream(state, 'fallback-model');
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

    const openAIResponse = convertChatResponseToOpenAI(chatResponse);
    assert.equal(openAIResponse.choices[0].finish_reason, 'stop');
    assert.equal(openAIResponse.choices[0].message.content, 'Hello world!');
    assert.equal(openAIResponse.usage?.prompt_tokens, 10);
    assert.equal(openAIResponse.usage?.completion_tokens, 20);
  });

  it('converts ChatResponse into OpenAI-style payload with usage details', () => {
    const routerResponse = {
      id: 'resp-1',
      object: 'chat.completion',
      created: 123,
      model: 'openrouter/model',
      systemFingerprint: 'abc',
      usage: {
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
        promptTokensDetails: { cachedTokens: 3 },
        completionTokensDetails: {
          reasoningTokens: 4,
          acceptedPredictionTokens: 2,
          rejectedPredictionTokens: 1,
        },
      },
      choices: [
        {
          index: 0,
          finishReason: 'stop',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Hello' },
              { type: 'text', text: ' world!' },
            ],
            toolCalls: [
              {
                id: 'tool_a',
                type: 'function',
                function: { name: 'lookup', arguments: '{"q":"docs"}' },
              },
            ],
            reasoning: 'reasoning text',
          },
        },
      ],
    } as any;

    const converted = convertChatResponseToOpenAI(routerResponse);

    assert.equal(converted.id, 'resp-1');
    assert.equal(converted.model, 'openrouter/model');
    assert.equal(converted.system_fingerprint, 'abc');
    assert.equal(converted.choices[0].message.content[0].text, 'Hello');
    assert.equal(
      converted.choices[0].message.tool_calls?.[0].function?.name,
      'lookup',
    );
    assert.equal(converted.choices[0].message.reasoning, 'reasoning text');
    assert.deepEqual(converted.usage, {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
      prompt_tokens_details: { cached_tokens: 3 },
      prompt_cache_hit_tokens: 3,
      completion_tokens_details: {
        reasoning_tokens: 4,
        accepted_prediction_tokens: 2,
        rejected_prediction_tokens: 1,
      },
    });
  });

  it('converts ToolDefinition into OpenRouter tool payloads', () => {
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
