// Standard library imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';
import {
  DEFAULT_MODEL_CAPABILITIES,
  type ModelConfig,
  ModelProvider,
  ReasoningEffort,
} from 'llm-zoo';

// Local imports - agent
import type { AgentTrace } from '@agent/trace';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { ModelHandlerGLM } from '@agent/modelHandlers/openai/modelHandlerGLM';
import { ModelHandlerKimi } from '@agent/modelHandlers/openai/modelHandlerKimi';
import { ModelHandlerXAI } from '@agent/modelHandlers/openai/modelHandlerXAI';

function buildConfig(
  provider: ModelProvider,
  overrides: Partial<ModelConfig> = {},
): ModelConfig {
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
      ...DEFAULT_MODEL_CAPABILITIES,
      supportsVision: false,
      ...(overrides.capabilities ?? {}),
    },
    openRouterOnly: false,
    label: 'Test Model',
    ...overrides,
  };
}

function createLoggerStub(): Partial<AgentTrace> {
  return {
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
              id: `completion-${createCalls.length}`,
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: createCalls.length === 1 ? 'summary' : 'ok',
                  },
                  finish_reason: 'stop',
                },
              ],
              usage: {
                prompt_tokens: 100,
                completion_tokens: 10,
                total_tokens: 110,
              },
            };
          },
        },
      },
    },
  };
}

describe('OpenAI-compatible provider request params', () => {
  it('keeps Kimi K2.7 Code chat requests on Moonshot-required defaults', async () => {
    const handler = new ModelHandlerKimi(
      buildConfig(ModelProvider.MOONSHOT, {
        name: 'kimi27codeT',
        fullName: 'kimi-k2.7-code',
        capabilities: {
          ...DEFAULT_MODEL_CAPABILITIES,
          supportsReasoning: true,
          supportsVision: true,
        },
      }),
    );
    handler.setLogger(createLoggerStub() as AgentTrace);
    (handler as any).getStreamingConfig = () => false;
    (handler as any).estimateTokenCount = async () => 100;

    const { client, createCalls } = createClientStub();
    await handler.createResponse({
      client: client as any,
      messages: [{ role: 'user', content: 'think' }],
      temperature: 0,
    });

    assert.equal(createCalls[0].temperature, 1);
    assert.equal(createCalls[0].thinking, undefined);
  });

  it('does not disable Kimi K2.7 thinking during client-side compaction', async () => {
    const handler = new ModelHandlerKimi(
      buildConfig(ModelProvider.MOONSHOT, {
        name: 'kimi27codeT',
        fullName: 'kimi-k2.7-code',
        capabilities: {
          ...DEFAULT_MODEL_CAPABILITIES,
          supportsReasoning: true,
          supportsVision: true,
        },
      }),
    );
    handler.setLogger(createLoggerStub() as AgentTrace);
    handler.setAgentCategory(AgentCategory.ToolUse);
    handler.requestCompaction();
    (handler as any).getStreamingConfig = () => false;
    (handler as any).estimateTokenCount = async () => 100;

    const { client, createCalls } = createClientStub();
    await handler.createResponse({
      client: client as any,
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'second' },
        { role: 'user', content: 'third' },
      ],
      temperature: 0,
    });

    assert.equal(createCalls.length, 2);
    assert.equal(createCalls[0].temperature, 1);
    assert.equal(createCalls[0].thinking, undefined);
  });

  it('pins Kimi K2.5 non-reasoning chat requests to temperature 0.6 and disables thinking (#7081)', async () => {
    const handler = new ModelHandlerKimi(
      buildConfig(ModelProvider.MOONSHOT, {
        name: 'kimi25',
        fullName: 'kimi-k2.5',
        capabilities: {
          ...DEFAULT_MODEL_CAPABILITIES,
          supportsReasoning: false,
        },
      }),
    );
    handler.setLogger(createLoggerStub() as AgentTrace);
    (handler as any).getStreamingConfig = () => false;
    (handler as any).estimateTokenCount = async () => 100;

    const { client, createCalls } = createClientStub();
    await handler.createResponse({
      client: client as any,
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0,
    });

    assert.equal(createCalls[0].temperature, 0.6);
    assert.deepEqual(createCalls[0].thinking, { type: 'disabled' });
  });

  it('pins Kimi K2.5 thinking chat requests to temperature 1 and leaves the API default (#7081)', async () => {
    const handler = new ModelHandlerKimi(
      buildConfig(ModelProvider.MOONSHOT, {
        name: 'kimi25T',
        fullName: 'kimi-k2.5',
        capabilities: {
          ...DEFAULT_MODEL_CAPABILITIES,
          supportsReasoning: true,
        },
      }),
    );
    handler.setLogger(createLoggerStub() as AgentTrace);
    (handler as any).getStreamingConfig = () => false;
    (handler as any).estimateTokenCount = async () => 100;

    const { client, createCalls } = createClientStub();
    await handler.createResponse({
      client: client as any,
      messages: [{ role: 'user', content: 'think' }],
      temperature: 0,
    });

    assert.equal(createCalls[0].temperature, 1);
    assert.equal(createCalls[0].thinking, undefined);
  });

  it('disables thinking for the Kimi K2.6 non-reasoning entry sharing a fullName with its thinking sibling (#7081)', async () => {
    // kimi26 and kimi26T both resolve to fullName 'kimi-k2.6' in the live
    // registry — the same shared-fullName ambiguity as K2.5 — but before
    // this fix only 'kimi-k2.5' was hardcoded here, so this non-reasoning
    // entry silently kept thinking on at the Moonshot API default.
    const handler = new ModelHandlerKimi(
      buildConfig(ModelProvider.MOONSHOT, {
        name: 'kimi26',
        fullName: 'kimi-k2.6',
        capabilities: {
          ...DEFAULT_MODEL_CAPABILITIES,
          supportsReasoning: false,
        },
      }),
    );
    handler.setLogger(createLoggerStub() as AgentTrace);
    (handler as any).getStreamingConfig = () => false;
    (handler as any).estimateTokenCount = async () => 100;

    const { client, createCalls } = createClientStub();
    await handler.createResponse({
      client: client as any,
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0,
    });

    assert.deepEqual(createCalls[0].thinking, { type: 'disabled' });
    // K2.6 has no fixed-temperature requirement, so the caller's temperature
    // passes through unchanged.
    assert.equal(createCalls[0].temperature, 0);
  });

  it('leaves Kimi K2.6 thinking requests on the API default (#7081)', async () => {
    const handler = new ModelHandlerKimi(
      buildConfig(ModelProvider.MOONSHOT, {
        name: 'kimi26T',
        fullName: 'kimi-k2.6',
        capabilities: {
          ...DEFAULT_MODEL_CAPABILITIES,
          supportsReasoning: true,
        },
      }),
    );
    handler.setLogger(createLoggerStub() as AgentTrace);
    (handler as any).getStreamingConfig = () => false;
    (handler as any).estimateTokenCount = async () => 100;

    const { client, createCalls } = createClientStub();
    await handler.createResponse({
      client: client as any,
      messages: [{ role: 'user', content: 'think' }],
      temperature: 0,
    });

    assert.equal(createCalls[0].thinking, undefined);
  });

  it('maps GLM low reasoning effort to the provider minimum', async () => {
    const handler = new ModelHandlerGLM(
      buildConfig(ModelProvider.GLM, {
        name: 'glm52',
        fullName: 'glm-5.2',
        capabilities: {
          ...DEFAULT_MODEL_CAPABILITIES,
          supportsReasoning: true,
          supportsReasoningEffort: true,
          reasoningEffort: ReasoningEffort.LOW,
        },
      }),
    );
    handler.setLogger(createLoggerStub() as AgentTrace);
    (handler as any).getStreamingConfig = () => false;

    const { client, createCalls } = createClientStub();
    await handler.createResponse({
      client: client as any,
      messages: [{ role: 'user', content: 'think' }],
      temperature: 0,
    });

    assert.deepEqual(createCalls[0].thinking, { type: 'enabled' });
    assert.equal(createCalls[0].reasoning_effort, 'high');
  });

  it('maps GLM max reasoning effort to the provider maximum', async () => {
    const handler = new ModelHandlerGLM(
      buildConfig(ModelProvider.GLM, {
        name: 'glm52',
        fullName: 'glm-5.2',
        capabilities: {
          ...DEFAULT_MODEL_CAPABILITIES,
          supportsReasoning: true,
          supportsReasoningEffort: true,
          reasoningEffort: ReasoningEffort.MAX,
        },
      }),
    );
    handler.setLogger(createLoggerStub() as AgentTrace);
    (handler as any).getStreamingConfig = () => false;

    const { client, createCalls } = createClientStub();
    await handler.createResponse({
      client: client as any,
      messages: [{ role: 'user', content: 'think harder' }],
      temperature: 0,
    });

    assert.equal(createCalls[0].reasoning_effort, 'max');
  });

  it('passes medium reasoning effort through for current Grok models', async () => {
    const handler = new ModelHandlerXAI(
      buildConfig(ModelProvider.XAI, {
        name: 'grok45',
        fullName: 'grok-4.5',
        capabilities: {
          ...DEFAULT_MODEL_CAPABILITIES,
          supportsReasoning: true,
          supportsReasoningEffort: true,
          reasoningEffort: ReasoningEffort.MEDIUM,
        },
      }),
    );
    handler.setLogger(createLoggerStub() as AgentTrace);
    (handler as any).getStreamingConfig = () => false;

    const { client, createCalls } = createClientStub();
    await handler.createResponse({
      client: client as any,
      messages: [{ role: 'user', content: 'think' }],
      temperature: 0,
    });

    assert.equal(createCalls[0].reasoning_effort, 'medium');
  });

  it('clamps above-high reasoning effort to high for Grok models', async () => {
    const handler = new ModelHandlerXAI(
      buildConfig(ModelProvider.XAI, {
        name: 'grok45',
        fullName: 'grok-4.5',
        capabilities: {
          ...DEFAULT_MODEL_CAPABILITIES,
          supportsReasoning: true,
          supportsReasoningEffort: true,
          reasoningEffort: ReasoningEffort.XHIGH,
        },
      }),
    );
    handler.setLogger(createLoggerStub() as AgentTrace);
    (handler as any).getStreamingConfig = () => false;

    const { client, createCalls } = createClientStub();
    await handler.createResponse({
      client: client as any,
      messages: [{ role: 'user', content: 'think harder' }],
      temperature: 0,
    });

    assert.equal(createCalls[0].reasoning_effort, 'high');
  });
});
