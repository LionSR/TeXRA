// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';
import { ModelProvider } from 'llm-zoo';

// Local imports
import { noopTrace } from '@agent/trace';
import { ModelHandlerDashScope } from '@agent/modelHandlers/openai/modelHandlerDashScope';
import { ModelHandlerDeepSeek } from '@agent/modelHandlers/openai/modelHandlerDeepSeek';
import { ModelHandlerKimi } from '@agent/modelHandlers/openai/modelHandlerKimi';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';

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

type NormalizingHandler =
  ModelHandlerDeepSeek | ModelHandlerKimi | ModelHandlerDashScope;

async function runNormalize(handler: NormalizingHandler) {
  const debugLogs: Array<{ message: string; options: unknown }> = [];
  const infoMessages: string[] = [];
  const loggerStub = {
    ...noopTrace,
    debugLogs,
    infoMessages,
    debug: (message: string, options?: unknown) => {
      debugLogs.push({ message, options });
    },
    info: (message: string) => {
      infoMessages.push(message);
    },
  };
  handler.setLogger(loggerStub);
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
    const config = buildTestModelConfig({
      name: 'deepseek-chat',
      fullName: 'deepseek-chat',
      provider: ModelProvider.DEEPSEEK,
      capabilities: { supportsVision: false },
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
    const preprocessLog = loggerStub.debugLogs.find(
      ({ message }) =>
        message === 'Preprocessed message array for model compatibility',
    );
    const data = (
      preprocessLog?.options as { data?: Record<string, unknown> } | undefined
    )?.data;
    assert.equal(data?.beforeCount, 3);
    assert.equal(data?.afterCount, 2);
    assert.equal(data?.providerLabel, 'deepseek');
    assert.deepEqual(loggerStub.infoMessages, []);
  });

  it.each([
    {
      name: 'Kimi',
      makeHandler: () =>
        new ModelHandlerKimi(
          buildTestModelConfig({
            name: 'kimi128k',
            fullName: 'moonshot-v1-128k',
            provider: ModelProvider.MOONSHOT,
            capabilities: { supportsVision: false },
          }),
        ),
    },
    {
      name: 'DashScope',
      makeHandler: () =>
        new ModelHandlerDashScope(
          buildTestModelConfig({
            name: 'qwen',
            fullName: 'qwen-plus',
            provider: ModelProvider.DASHSCOPE,
            capabilities: { supportsVision: false },
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
        loggerStub.debugLogs.some(({ message }) =>
          message.startsWith('Preprocessed message array'),
        ),
        false,
        'message count is unchanged, so no preprocessing log expected',
      );
      assert.deepEqual(loggerStub.infoMessages, []);
    },
  );
});
