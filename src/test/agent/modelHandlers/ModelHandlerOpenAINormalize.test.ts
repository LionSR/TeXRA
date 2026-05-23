// Standard library imports
import { strict as assert } from 'assert';

// (none needed)

// Local imports - agent
import {
  DEFAULT_MODEL_CAPABILITIES,
  type ModelConfig,
  ModelProvider,
} from 'llm-zoo';
import type { AgentTrace } from '@agent/trace';
import { ModelHandlerDashScope } from '@agent/modelHandlers/modelHandlerDashScope';
import { ModelHandlerDeepSeek } from '@agent/modelHandlers/modelHandlerDeepSeek';
import { ModelHandlerKimi } from '@agent/modelHandlers/modelHandlerKimi';

// Type imports

// Local imports - model config

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
    withCurrentGroup: () => undefined,
    runWithinCurrentGroup: async (fn: () => any) => fn(),
    runWithGroup: async (_groupId: string | undefined, fn: () => any) => fn(),
  };
}

function createClientStub() {
  return {
    chat: {
      completions: {
        create: async () => ({
          id: 'test-completion',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
        }),
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

function extractPreviewLogs(logs: string[]): string[] {
  return logs.filter((entry) => entry.startsWith('Message '));
}

describe('ModelHandlerOpenAI.normalizeMessages hook', () => {
  it('DeepSeek handler logs merged previews', async () => {
    const config = buildConfig(ModelProvider.DEEPSEEK, {
      name: 'deepseek-chat',
      fullName: 'deepseek-chat',
    });
    const handler = new ModelHandlerDeepSeek(config);
    const loggerStub = createLoggerStub();
    handler.setLogger(loggerStub as unknown as AgentTrace);
    (handler as any).getStreamingConfig = () => false;

    const client = createClientStub();
    await handler.createResponse({
      client: client as any,
      messages: cloneMessages(BASE_MESSAGES),
      temperature: 0.1,
    });

    const previews = extractPreviewLogs(loggerStub.debugMessages);
    assert.equal(previews.length, 2, 'DeepSeek should merge two user messages');
    assert.ok(
      previews[0].startsWith('Message 0 (user): First part'),
      'first preview should include merged user content',
    );
    assert.ok(
      previews[0].includes('Second part'),
      'merged preview should include second user segment',
    );
    assert.equal(
      previews[1],
      'Message 1 (assistant): Assistant reply...',
      'assistant preview should remain intact',
    );
    assert.ok(
      loggerStub.debugMessages.includes(
        'Preprocessed message array from 3 to 2 messages for Deepseek model compatibility',
      ),
    );
    assert.deepEqual(loggerStub.infoMessages, []);
  });

  it('Kimi handler logs each message preview', async () => {
    const config = buildConfig(ModelProvider.MOONSHOT, {
      name: 'kimi128k',
      fullName: 'moonshot-v1-128k',
    });
    const handler = new ModelHandlerKimi(config);
    const loggerStub = createLoggerStub();
    handler.setLogger(loggerStub as unknown as AgentTrace);
    (handler as any).getStreamingConfig = () => false;

    const client = createClientStub();
    await handler.createResponse({
      client: client as any,
      messages: cloneMessages(BASE_MESSAGES),
      temperature: 0.1,
    });

    const previews = extractPreviewLogs(loggerStub.debugMessages);
    assert.deepEqual(previews, [
      'Message 0 (user): First part...',
      'Message 1 (user): Second part...',
      'Message 2 (assistant): Assistant reply...',
    ]);
    assert.deepEqual(loggerStub.infoMessages, []);
  });

  it('DashScope handler logs each message preview', async () => {
    const config = buildConfig(ModelProvider.DASHSCOPE, {
      name: 'qwen',
      fullName: 'qwen-plus',
    });
    const handler = new ModelHandlerDashScope(config);
    const loggerStub = createLoggerStub();
    handler.setLogger(loggerStub as unknown as AgentTrace);
    (handler as any).getStreamingConfig = () => false;

    const client = createClientStub();
    await handler.createResponse({
      client: client as any,
      messages: cloneMessages(BASE_MESSAGES),
      temperature: 0.1,
    });

    const previews = extractPreviewLogs(loggerStub.debugMessages);
    assert.deepEqual(previews, [
      'Message 0 (user): First part...',
      'Message 1 (user): Second part...',
      'Message 2 (assistant): Assistant reply...',
    ]);
    assert.deepEqual(loggerStub.infoMessages, []);
  });
});
