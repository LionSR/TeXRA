// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it, vi } from 'vitest';
import { ModelProvider, ReasoningEffort } from 'llm-zoo';

// Local imports
import { noopTrace } from '@agent/trace';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { ModelHandlerGLM } from '@agent/modelHandlers/openai/modelHandlerGLM';
import { ModelHandlerKimi } from '@agent/modelHandlers/openai/modelHandlerKimi';
import { ModelHandlerXAI } from '@agent/modelHandlers/openai/modelHandlerXAI';
import { KIMI_CODE_BASE_URL } from '@model/kimiCodeSubscriptionRouting';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';

const NO_VISION_CAPABILITIES = Object.freeze({ supportsVision: false });
const MOONSHOT_TEST_CONFIG = Object.freeze({
  provider: ModelProvider.MOONSHOT,
  capabilities: NO_VISION_CAPABILITIES,
});
const GLM_TEST_CONFIG = Object.freeze({
  provider: ModelProvider.GLM,
  capabilities: NO_VISION_CAPABILITIES,
});
const XAI_TEST_CONFIG = Object.freeze({
  provider: ModelProvider.XAI,
  capabilities: NO_VISION_CAPABILITIES,
});

function createClientStub() {
  const createCalls: any[] = [];
  const createOptions: any[] = [];
  const client = {
    chat: {
      completions: {
        create: async (params: any, options?: any) => {
          createCalls.push(params);
          createOptions.push(options);
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
  };
  const withOptions = vi.fn(() => client);
  return {
    createCalls,
    createOptions,
    client: Object.assign(client, { withOptions }),
    withOptions,
  };
}

class KimiUsageRouteProbe extends ModelHandlerKimi {
  tagApiKeyClient<Candidate extends object>(client: Candidate): Candidate {
    return this.rememberClientCredentialRoute(
      client,
      'api-key',
      'test-kimi-code-key',
    );
  }
}

describe('OpenAI-compatible provider request params', () => {
  it('records coding-endpoint Kimi requests as subscription usage', async () => {
    const handler = new KimiUsageRouteProbe(
      buildTestModelConfig(MOONSHOT_TEST_CONFIG, {
        name: 'kimi27codeT',
        fullName: 'kimi-for-coding',
        kimiSubscription: true,
        baseUrl: KIMI_CODE_BASE_URL,
      }),
    );
    handler.setLogger({ ...noopTrace });
    (handler as any).getStreamingConfig = () => false;
    (handler as any).estimateTokenCount = async () => 100;

    const { client } = createClientStub();
    await handler.createResponse({
      client: handler.tagApiKeyClient(client) as any,
      messages: [{ role: 'user', content: 'think' }],
      temperature: 0,
    });

    assert.equal(
      handler.getLastCredentialUsageRoute(),
      'kimi-code-subscription',
    );
  });

  it.each(['kimi-k2.7-code', 'kimi-for-coding', 'kimi-for-coding-highspeed'])(
    'keeps Kimi K2.7 Code alias %s on required defaults',
    async (fullName) => {
      const handler = new ModelHandlerKimi(
        buildTestModelConfig(MOONSHOT_TEST_CONFIG, {
          name: 'kimi27codeT',
          fullName,
          capabilities: {
            supportsReasoning: true,
            supportsVision: true,
          },
        }),
      );
      handler.setLogger({ ...noopTrace });
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
    },
  );

  it.each(['kimi-k2.7-code', 'kimi-for-coding', 'kimi-for-coding-highspeed'])(
    'does not disable Kimi K2.7 alias %s during compaction',
    async (fullName) => {
      const handler = new ModelHandlerKimi(
        buildTestModelConfig(MOONSHOT_TEST_CONFIG, {
          name: 'kimi27codeT',
          fullName,
          capabilities: {
            supportsReasoning: true,
            supportsVision: true,
          },
        }),
      );
      handler.setLogger({ ...noopTrace });
      handler.setAgentCategory(AgentCategory.ToolUse);
      handler.requestCompaction();
      (handler as any).getStreamingConfig = () => false;
      (handler as any).estimateTokenCount = async () => 100;

      const { client, createCalls, createOptions, withOptions } =
        createClientStub();
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
      // Compaction retries ride per-request options, not a client clone.
      assert.deepEqual(withOptions.mock.calls, []);
      assert.equal(createOptions[0]?.maxRetries, 2);
      assert.equal(createCalls[0].temperature, 1);
      assert.equal(createCalls[0].thinking, undefined);
    },
  );

  it('uses the fixed Kimi K2.5 temperature during client-side compaction', async () => {
    const handler = new ModelHandlerKimi(
      buildTestModelConfig(MOONSHOT_TEST_CONFIG, {
        name: 'kimi25T',
        fullName: 'kimi-k2.5',
        capabilities: {
          supportsReasoning: true,
        },
      }),
    );
    handler.setLogger({ ...noopTrace });
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
  });

  it('pins Kimi K2.5 non-reasoning chat requests to temperature 0.6 and disables thinking (#7081)', async () => {
    const handler = new ModelHandlerKimi(
      buildTestModelConfig(MOONSHOT_TEST_CONFIG, {
        name: 'kimi25',
        fullName: 'kimi-k2.5',
        capabilities: {
          supportsReasoning: false,
        },
      }),
    );
    handler.setLogger({ ...noopTrace });
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
      buildTestModelConfig(MOONSHOT_TEST_CONFIG, {
        name: 'kimi25T',
        fullName: 'kimi-k2.5',
        capabilities: {
          supportsReasoning: true,
        },
      }),
    );
    handler.setLogger({ ...noopTrace });
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

  it.each(['kimi-k3', 'k3'])(
    'omits temperature and sends reasoning_effort max for Kimi K3 alias %s',
    async (fullName) => {
      // Moonshot fixes K3 sampling server-side (docs say omit temperature), and
      // its reasoning_effort field accepts only 'max' — the shared OpenAI clamp
      // would otherwise lower our MAX tier to 'xhigh', which Moonshot rejects.
      const handler = new ModelHandlerKimi(
        buildTestModelConfig(MOONSHOT_TEST_CONFIG, {
          name: 'kimi3',
          fullName,
          capabilities: {
            supportsReasoning: true,
            supportsReasoningEffort: true,
            reasoningEffort: ReasoningEffort.MAX,
            supportsVision: true,
          },
        }),
      );
      handler.setLogger({ ...noopTrace });
      (handler as any).getStreamingConfig = () => false;
      (handler as any).estimateTokenCount = async () => 100;

      const { client, createCalls } = createClientStub();
      await handler.createResponse({
        client: client as any,
        messages: [{ role: 'user', content: 'think' }],
        temperature: 0,
      });

      assert.equal('temperature' in createCalls[0], false);
      assert.equal(createCalls[0].reasoning_effort, 'max');
      assert.equal(createCalls[0].thinking, undefined);
    },
  );

  it.each(['kimi-k3', 'k3'])(
    'preserves thinking in Kimi K3 alias %s compaction summaries',
    async (fullName) => {
      const handler = new ModelHandlerKimi(
        buildTestModelConfig(MOONSHOT_TEST_CONFIG, {
          name: 'kimi3',
          fullName,
          capabilities: {
            supportsReasoning: true,
            supportsReasoningEffort: true,
            reasoningEffort: ReasoningEffort.MAX,
            supportsVision: true,
          },
        }),
      );
      handler.setLogger({ ...noopTrace });
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
      assert.equal('temperature' in createCalls[0], false);
      assert.equal(createCalls[0].thinking, undefined);
    },
  );

  it('disables thinking for the Kimi K2.6 non-reasoning entry sharing a fullName with its thinking sibling (#7081)', async () => {
    // kimi26 and kimi26T both resolve to fullName 'kimi-k2.6' in the live
    // registry — the same shared-fullName ambiguity as K2.5 — but before
    // this fix only 'kimi-k2.5' was hardcoded here, so this non-reasoning
    // entry silently kept thinking on at the Moonshot API default.
    const handler = new ModelHandlerKimi(
      buildTestModelConfig(MOONSHOT_TEST_CONFIG, {
        name: 'kimi26',
        fullName: 'kimi-k2.6',
        capabilities: {
          supportsReasoning: false,
        },
      }),
    );
    handler.setLogger({ ...noopTrace });
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
      buildTestModelConfig(MOONSHOT_TEST_CONFIG, {
        name: 'kimi26T',
        fullName: 'kimi-k2.6',
        capabilities: {
          supportsReasoning: true,
        },
      }),
    );
    handler.setLogger({ ...noopTrace });
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
      buildTestModelConfig(GLM_TEST_CONFIG, {
        name: 'glm52',
        fullName: 'glm-5.2',
        capabilities: {
          supportsReasoning: true,
          supportsReasoningEffort: true,
          reasoningEffort: ReasoningEffort.LOW,
        },
      }),
    );
    handler.setLogger({ ...noopTrace });
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
      buildTestModelConfig(GLM_TEST_CONFIG, {
        name: 'glm52',
        fullName: 'glm-5.2',
        capabilities: {
          supportsReasoning: true,
          supportsReasoningEffort: true,
          reasoningEffort: ReasoningEffort.MAX,
        },
      }),
    );
    handler.setLogger({ ...noopTrace });
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
      buildTestModelConfig(XAI_TEST_CONFIG, {
        name: 'grok45',
        fullName: 'grok-4.5',
        capabilities: {
          supportsReasoning: true,
          supportsReasoningEffort: true,
          reasoningEffort: ReasoningEffort.MEDIUM,
        },
      }),
    );
    handler.setLogger({ ...noopTrace });
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
      buildTestModelConfig(XAI_TEST_CONFIG, {
        name: 'grok45',
        fullName: 'grok-4.5',
        capabilities: {
          supportsReasoning: true,
          supportsReasoningEffort: true,
          reasoningEffort: ReasoningEffort.XHIGH,
        },
      }),
    );
    handler.setLogger({ ...noopTrace });
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
