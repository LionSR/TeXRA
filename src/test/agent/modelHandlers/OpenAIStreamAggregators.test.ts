// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';

// Local imports - agent components
import { ModelHandlerDeepSeek } from '@agent/modelHandlers/modelHandlerDeepSeek';
import { ModelHandlerDashScope } from '@agent/modelHandlers/modelHandlerDashScope';
import { ModelHandlerKimi } from '@agent/modelHandlers/modelHandlerKimi';
import { ModelHandlerXAI } from '@agent/modelHandlers/modelHandlerXAI';
import type { ModelHandlerOpenAI } from '@agent/modelHandlers/modelHandlerOpenAI';

// Local imports - model config
import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelConfig,
  ModelProvider,
} from '@model/ModelConfig';

interface MockLogStream {
  append: (text: string) => void;
  finalize: (finalText?: string) => string;
  chunks: string[];
  buffer: string;
  finalValue?: string;
}

function createMockLogStream(): MockLogStream {
  const stream: MockLogStream = {
    chunks: [],
    buffer: '',
    append(text: string) {
      if (!text) {
        return;
      }
      stream.chunks.push(text);
      stream.buffer += text;
    },
    finalize(finalText?: string) {
      if (typeof finalText === 'string') {
        stream.buffer = finalText;
      }
      stream.finalValue = stream.buffer;
      return stream.buffer;
    },
  };
  return stream;
}

function createChunk(
  delta: unknown,
  extras: Partial<ChatCompletionChunk> = {},
): ChatCompletionChunk {
  return {
    id: 'chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [
      {
        index: 0,
        delta,
        finish_reason: null,
      },
    ],
    ...extras,
  } as unknown as ChatCompletionChunk;
}

function buildTestConfig(
  provider: ModelProvider,
  name: string,
  fullName: string,
): ModelConfig {
  return {
    name,
    fullName,
    provider,
    maxOutputTokens: 1024,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 200000,
    capabilities: { ...DEFAULT_MODEL_CAPABILITIES },
    openRouterOnly: false,
  };
}

type ExposedHandler = ModelHandlerOpenAI & {
  getStreamAggregator(): any;
  handleStreamChunk(
    chunk: ChatCompletionChunk,
    aggregator: any,
    thinking: MockLogStream,
    output?: MockLogStream,
  ): Promise<void>;
  finalizeStream(
    stream: { finalChatCompletion: () => Promise<any> },
    aggregator: any,
    thinking: MockLogStream,
    output?: MockLogStream,
  ): Promise<any>;
};

async function simulateStream(
  handler: ModelHandlerOpenAI,
  chunks: ChatCompletionChunk[],
) {
  const exposed = handler as ExposedHandler;
  const aggregator = exposed.getStreamAggregator();
  assert.ok(aggregator, 'expected stream aggregator instance');
  const thinking = createMockLogStream();
  const output = createMockLogStream();
  let finalCalled = false;

  for (const chunk of chunks) {
    await exposed.handleStreamChunk(chunk, aggregator, thinking, output);
  }

  const response = await exposed.finalizeStream(
    {
      finalChatCompletion: async () => {
        finalCalled = true;
        throw new Error('finalChatCompletion should not be called');
      },
    },
    aggregator,
    thinking,
    output,
  );

  return { response, aggregator, thinking, output, finalCalled };
}

const baseChunks: ChatCompletionChunk[] = [
  createChunk({
    role: 'assistant',
    reasoning_content: [{ type: 'text', text: 'Reasoning step 1. ' }],
    content: [{ type: 'text', text: 'Hello ' }],
    tool_calls: [
      {
        index: 0,
        id: 'call-',
        type: 'function',
        function: { name: 'tool', arguments: '{"foo":"' },
      },
    ],
  }),
  createChunk({
    reasoning_content: [{ type: 'text', text: 'Reasoning step 2.' }],
    content: [{ type: 'text', text: 'world!' }],
    tool_calls: [
      {
        index: 0,
        id: '001',
        function: { arguments: "bar\"}" },
      },
    ],
    function_call: { name: 'followup', arguments: '{"baz":"' },
  }),
  createChunk(
    {
      function_call: { name: '', arguments: "value\"}" },
    },
    {
      id: 'chunk-final',
      created: 3,
      model: 'test-model',
      system_fingerprint: 'fp',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: 'tool_calls',
        },
      ],
    },
  ),
];

describe('OpenAI stream aggregators', () => {
  const providers = [
    {
      label: 'DeepSeek',
      Handler: ModelHandlerDeepSeek,
      config: buildTestConfig(ModelProvider.DEEPSEEK, 'deepseek', 'deepseek-chat'),
    },
    {
      label: 'Kimi',
      Handler: ModelHandlerKimi,
      config: buildTestConfig(ModelProvider.MOONSHOT, 'kimi', 'moonshot-v1'),
    },
    {
      label: 'DashScope',
      Handler: ModelHandlerDashScope,
      config: buildTestConfig(ModelProvider.DASHSCOPE, 'dashscope', 'qwen-plus'),
    },
    {
      label: 'xAI',
      Handler: ModelHandlerXAI,
      config: buildTestConfig(ModelProvider.XAI, 'xai', 'grok-1'),
    },
  ];

  for (const { label, Handler, config } of providers) {
    it(`aggregates streaming chunks for ${label}`, async () => {
      const handler = new Handler(config);
      const { response, aggregator, thinking, output, finalCalled } =
        await simulateStream(handler, baseChunks);

      assert.equal(finalCalled, false, 'should not call finalChatCompletion');

      const message = response.choices[0]?.message as any;
      assert.ok(message, 'expected final assistant message');
      assert.equal(message.role, 'assistant');
      assert.equal(message.content, 'Hello world!');
      assert.equal(
        message.reasoning_content,
        'Reasoning step 1. Reasoning step 2.',
      );

      assert.ok(Array.isArray(message.tool_calls));
      assert.equal(message.tool_calls.length, 1);
      const toolCall = message.tool_calls[0];
      assert.equal(toolCall.id, 'call-001');
      assert.deepEqual(toolCall.function, {
        name: 'tool',
        arguments: '{"foo":"bar"}',
      });

      assert.deepEqual(message.function_call, {
        name: 'followup',
        arguments: '{"baz":"value"}',
      });

      assert.deepEqual(response.usage, {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      });
      assert.equal(response.choices[0]?.finish_reason, 'tool_calls');

      assert.deepEqual(thinking.chunks, [
        'Reasoning step 1. ',
        'Reasoning step 2.',
      ]);
      assert.equal(thinking.finalValue, 'Reasoning step 1. Reasoning step 2.');

      assert.deepEqual(output.chunks, ['Hello ', 'world!']);
      assert.equal(output.finalValue, 'Hello world!');

      assert.equal(aggregator.getAggregatedContent(), 'Hello world!');
      assert.equal(
        aggregator.getAggregatedReasoning(),
        'Reasoning step 1. Reasoning step 2.',
      );
    });
  }
});
