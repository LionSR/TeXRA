// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import {
  DEFAULT_MODEL_CAPABILITIES,
  type ModelConfig,
  ModelProvider,
} from 'llm-zoo';

// Local imports - agent
import type { AgentTrace } from '@agent/trace';
import { ModelHandlerDashScope } from '@agent/modelHandlers/openai/modelHandlerDashScope';
import { ModelHandlerDeepSeek } from '@agent/modelHandlers/openai/modelHandlerDeepSeek';
import { ModelHandlerKimi } from '@agent/modelHandlers/openai/modelHandlerKimi';

type LoggerStub = Partial<AgentTrace> & {
  streamId: string;
  debugMessages: string[];
  infoMessages: string[];
};

function createLoggerStub(): LoggerStub {
  const debugMessages: string[] = [];
  const infoMessages: string[] = [];
  return {
    streamId: 'test-channel',
    debugMessages,
    infoMessages,
    debug: (message: string) => {
      debugMessages.push(message);
    },
    info: (message: string) => {
      infoMessages.push(message);
    },
    warn: () => {
      /* no-op for tests */
    },
    error: () => {
      /* no-op for tests */
    },
  };
}

function createClientStub() {
  const createCalls: any[] = [];
  return {
    createCalls,
    client: {
      chat: {
        completions: {
          create: async (params: any) => {
            createCalls.push(params);
            return {
              id: 'test-completion',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'ok' },
                  finish_reason: 'stop',
                },
              ],
            };
          },
        },
      },
    },
  };
}

function cloneMessages(messages: any[]) {
  return messages.map((message) => ({
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((part: any) => ({ ...part }))
      : message.content,
  }));
}

const BASE_MESSAGES = [
  {
    role: 'user',
    content: [{ type: 'text', text: 'First part' }],
  },
  {
    role: 'user',
    content: [{ type: 'text', text: 'Second part' }],
  },
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'Assistant reply' }],
  },
];

function buildConfig(
  provider: ModelProvider,
  overrides: Partial<ModelConfig> = {},
): ModelConfig {
  const baseCapabilities = {
    ...DEFAULT_MODEL_CAPABILITIES,
    supportsVision: false,
  };

  return {
    name: 'test-model',
    fullName: 'test-model',
    shortName: 'test-model',
    provider,
    maxOutputTokens: 1024,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 200000,
    capabilities: {
      ...baseCapabilities,
      ...(overrides.capabilities ?? {}),
    },
    openRouterOnly: false,
    ...overrides,
    label: overrides.label ?? 'Test Model',
  };
}

type NormalizingHandler =
  ModelHandlerDeepSeek | ModelHandlerKimi | ModelHandlerDashScope;

async function runNormalize(handler: NormalizingHandler) {
  const loggerStub = createLoggerStub();
  handler.setLogger(loggerStub as unknown as AgentTrace);
  (handler as any).getStreamingConfig = () => false;

  const { client, createCalls } = createClientStub();
  await handler.createResponse({
    client: client as any,
    messages: cloneMessages(BASE_MESSAGES),
    temperature: 0.1,
  });

  return { createCalls, loggerStub };
}

describe('ModelHandlerOpenAI.normalizeMessages hook', () => {
  it('DeepSeek handler merges consecutive user messages into string content', async () => {
    const config = buildConfig(ModelProvider.DEEPSEEK, {
      name: 'deepseek-chat',
      fullName: 'deepseek-chat',
    });
    const { createCalls, loggerStub } = await runNormalize(
      new ModelHandlerDeepSeek(config),
    );

    assert.equal(createCalls.length, 1, 'should issue a single completion');
    const sentMessages = createCalls[0].messages;
    assert.equal(
      sentMessages.length,
      2,
      'DeepSeek should merge two user messages',
    );
    assert.deepEqual(
      sentMessages[0],
      { role: 'user', content: 'First part\nSecond part' },
      'merged user message should be stringified with both segments',
    );
    assert.deepEqual(
      sentMessages[1],
      { role: 'assistant', content: 'Assistant reply' },
      'assistant message should remain intact as string content',
    );
    assert.ok(
      loggerStub.debugMessages.includes(
        'Preprocessed message array from 3 to 2 messages for deepseek model compatibility',
      ),
    );
    assert.deepEqual(loggerStub.infoMessages, []);
  });

  it.each([
    {
      name: 'Kimi',
      makeHandler: () =>
        new ModelHandlerKimi(
          buildConfig(ModelProvider.MOONSHOT, {
            name: 'kimi128k',
            fullName: 'moonshot-v1-128k',
          }),
        ),
    },
    {
      name: 'DashScope',
      makeHandler: () =>
        new ModelHandlerDashScope(
          buildConfig(ModelProvider.DASHSCOPE, {
            name: 'qwen',
            fullName: 'qwen-plus',
          }),
        ),
    },
  ])(
    '$name handler stringifies content without merging messages',
    async ({ makeHandler }) => {
      const { createCalls, loggerStub } = await runNormalize(makeHandler());

      assert.equal(createCalls.length, 1, 'should issue a single completion');
      assert.deepEqual(createCalls[0].messages, [
        { role: 'user', content: 'First part' },
        { role: 'user', content: 'Second part' },
        { role: 'assistant', content: 'Assistant reply' },
      ]);
      assert.equal(
        loggerStub.debugMessages.some((entry) =>
          entry.startsWith('Preprocessed message array'),
        ),
        false,
        'message count is unchanged, so no preprocessing log expected',
      );
      assert.deepEqual(loggerStub.infoMessages, []);
    },
  );
});
