// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import {
  DEFAULT_MODEL_CAPABILITIES,
  type ModelConfig,
  ModelProvider,
} from 'llm-zoo';

// Local imports - agent
import { ModelHandlerDeepSeek } from '@agent/modelHandlers/modelHandlerDeepSeek';

// Type imports
import type { AgentLogger } from '@logger/AgentLogger';
import type { ToolDefinition } from '@model';

function thinkingFor(
  fullName: string,
  supportsReasoning: boolean,
): { type: 'enabled' | 'disabled' } | undefined {
  const handler = new ModelHandlerDeepSeek({
    fullName,
    provider: ModelProvider.DEEPSEEK,
    capabilities: { ...DEFAULT_MODEL_CAPABILITIES, supportsReasoning },
  } as ModelConfig);
  return (handler as any).getThinkingParameter();
}

function buildConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    name: 'deepseek-chat',
    fullName: 'deepseek-chat',
    shortName: 'deepseek-chat',
    provider: ModelProvider.DEEPSEEK,
    maxOutputTokens: 1024,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 200000,
    capabilities: {
      ...DEFAULT_MODEL_CAPABILITIES,
      supportsReasoning: false,
      supportsVision: false,
      ...(overrides.capabilities ?? {}),
    },
    openRouterOnly: false,
    label: 'DeepSeek Chat',
    ...overrides,
  };
}

function createLoggerStub(): Partial<AgentLogger> {
  return {
    streamId: 'test-channel',
    debug: () => {
      /* no-op */
    },
    info: () => {
      /* no-op */
    },
    warn: () => {
      /* no-op */
    },
    error: () => {
      /* no-op */
    },
    withCurrentGroup: () => undefined,
    runWithinCurrentGroup: async <T>(fn: () => T | Promise<T>) => fn(),
    runWithGroup: async <T>(
      _groupId: string | undefined,
      fn: () => T | Promise<T>,
    ) => fn(),
  };
}

describe('ModelHandlerDeepSeek.getThinkingParameter', () => {
  it('deepseek-chat defaults OFF: omits param when reasoning disabled', () => {
    assert.equal(thinkingFor('deepseek-chat', false), undefined);
  });

  it('deepseek-chat defaults OFF: enables explicitly when reasoning requested', () => {
    assert.deepEqual(thinkingFor('deepseek-chat', true), { type: 'enabled' });
  });

  it('deepseek-reasoner defaults ON: omits param when reasoning requested', () => {
    assert.equal(thinkingFor('deepseek-reasoner', true), undefined);
  });

  it('deepseek-reasoner defaults ON: disables explicitly when reasoning off', () => {
    assert.deepEqual(thinkingFor('deepseek-reasoner', false), {
      type: 'disabled',
    });
  });

  it('deepseek-v4-flash defaults ON: omits param when reasoning requested', () => {
    assert.equal(thinkingFor('deepseek-v4-flash', true), undefined);
  });

  it('deepseek-v4-flash defaults ON: disables explicitly when reasoning off', () => {
    assert.deepEqual(thinkingFor('deepseek-v4-flash', false), {
      type: 'disabled',
    });
  });

  it('deepseek-v4-pro defaults ON: omits param when reasoning requested', () => {
    assert.equal(thinkingFor('deepseek-v4-pro', true), undefined);
  });

  it('deepseek-v4-pro defaults ON: disables explicitly when reasoning off', () => {
    assert.deepEqual(thinkingFor('deepseek-v4-pro', false), {
      type: 'disabled',
    });
  });

  it('unlisted fullName is treated as default-ON (matches V4+ convention)', () => {
    // Update getThinkingParameter if a new non-thinking model is added.
    assert.equal(thinkingFor('deepseek-future', true), undefined);
    assert.deepEqual(thinkingFor('deepseek-future', false), {
      type: 'disabled',
    });
  });
});

describe('ModelHandlerDeepSeek tool conversion', () => {
  it('sends nullable Chat Completions tools without SDK strict auto-parse validation', async () => {
    const handler = new ModelHandlerDeepSeek(buildConfig());
    handler.setLogger(createLoggerStub() as AgentLogger);
    (handler as any).getStreamingConfig = () => false;

    let capturedParams: any;
    const client = {
      chat: {
        completions: {
          create: async (params: any) => {
            capturedParams = params;
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
    };
    const tools: ToolDefinition[] = [
      {
        name: 'delegate_workflow',
        description: 'Delegate workflow',
        parameters: {
          type: 'object',
          properties: {
            instruction: { type: 'string' },
            model: { type: 'string' },
          },
          required: ['instruction'],
          additionalProperties: false,
        },
      },
    ];

    await handler.createResponse({
      client: client as any,
      messages: [{ role: 'user', content: 'delegate this' }],
      temperature: 0,
      tools,
    });

    assert.equal(capturedParams.tools[0].function.name, 'delegate_workflow');
    assert.equal(capturedParams.tools[0].function.strict, undefined);
  });
});
