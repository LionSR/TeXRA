// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it, vi } from 'vitest';
import { ModelProvider, ReasoningEffort } from 'llm-zoo';

// Local imports
import { noopTrace } from '@agent/trace';
import { ModelHandlerGLM } from '@agent/modelHandlers/openai/modelHandlerGLM';
import { ModelHandlerKimi } from '@agent/modelHandlers/openai/modelHandlerKimi';
import { ModelHandlerXAI } from '@agent/modelHandlers/openai/modelHandlerXAI';
import { AgentCategory } from '@shared/schemas';
import { KIMI_CODE_BASE_URL } from '@shared/constants/providers';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

const SINGLE_TURN: ChatCompletionMessageParam[] = [
  { role: 'user', content: 'think' },
];
const KIMI_K27_CODE_ALIASES = [
  'kimi-k2.7-code',
  'kimi-for-coding',
  'kimi-for-coding-highspeed',
];
const KIMI_K3_ALIASES = ['kimi-k3', 'k3'];
const COMPACTION_TURN = [
  { role: 'user', content: 'first' },
  { role: 'assistant', content: 'second' },
  { role: 'user', content: 'third' },
];

type CompatibleHandler = ModelHandlerGLM | ModelHandlerKimi | ModelHandlerXAI;
type ConfigOverrides = Parameters<typeof buildTestModelConfig>[1];

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

function configureHandler<Handler extends CompatibleHandler>(
  handler: Handler,
): Handler {
  handler.setLogger({ ...noopTrace });
  // Both members are public, so the stubs stay compile-checked: a rename or
  // signature change fails typecheck instead of silently breaking the suite.
  handler.getStreamingConfig = () => false;
  return handler;
}

/** Kimi additionally bypasses the pre-flight token count, which hits the API. */
function configureKimiHandler<Handler extends ModelHandlerKimi>(
  handler: Handler,
): Handler {
  handler.estimateTokenCount = async () => 100;
  return configureHandler(handler);
}

function createKimiHandler(overrides: ConfigOverrides): ModelHandlerKimi {
  return configureKimiHandler(
    new ModelHandlerKimi(
      buildTestModelConfig({ provider: ModelProvider.MOONSHOT }, overrides),
    ),
  );
}

function createGlmHandler(overrides: ConfigOverrides): ModelHandlerGLM {
  return configureHandler(
    new ModelHandlerGLM(
      buildTestModelConfig({ provider: ModelProvider.GLM }, overrides),
    ),
  );
}

function createXaiHandler(overrides: ConfigOverrides): ModelHandlerXAI {
  return configureHandler(
    new ModelHandlerXAI(
      buildTestModelConfig({ provider: ModelProvider.XAI }, overrides),
    ),
  );
}

function createK27CodeHandler(fullName: string): ModelHandlerKimi {
  return createKimiHandler({
    name: 'kimi27codeT',
    fullName,
    capabilities: {
      supportsReasoning: true,
      supportsVision: true,
    },
  });
}

function createK3Handler(fullName: string): ModelHandlerKimi {
  return createKimiHandler({
    name: 'kimi3',
    fullName,
    capabilities: {
      supportsReasoning: true,
      supportsReasoningEffort: true,
      reasoningEffort: ReasoningEffort.MAX,
      supportsVision: true,
    },
  });
}

function createKimi25Handler(supportsReasoning: boolean): ModelHandlerKimi {
  return createKimiHandler({
    name: supportsReasoning ? 'kimi25T' : 'kimi25',
    fullName: 'kimi-k2.5',
    capabilities: { supportsReasoning },
  });
}

function createKimi26Handler(supportsReasoning: boolean): ModelHandlerKimi {
  return createKimiHandler({
    name: supportsReasoning ? 'kimi26T' : 'kimi26',
    fullName: 'kimi-k2.6',
    capabilities: { supportsReasoning },
  });
}

async function sendRequest(
  handler: CompatibleHandler,
  messages: any[] = SINGLE_TURN,
) {
  const stub = createClientStub();
  await handler.createResponse({
    client: stub.client as any,
    messages,
    temperature: 0,
  });
  return stub;
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
    const handler = configureKimiHandler(
      new KimiUsageRouteProbe(
        buildTestModelConfig(
          { provider: ModelProvider.MOONSHOT },
          {
            name: 'kimi27codeT',
            fullName: 'kimi-for-coding',
            kimiSubscription: true,
            baseUrl: KIMI_CODE_BASE_URL,
          },
        ),
      ),
    );

    const { client } = createClientStub();
    await handler.createResponse({
      client: handler.tagApiKeyClient(client) as any,
      messages: SINGLE_TURN,
      temperature: 0,
    });

    assert.equal(
      handler.getLastCredentialUsageRoute(),
      'kimi-code-subscription',
    );
  });

  it.each(KIMI_K27_CODE_ALIASES)(
    'keeps Kimi K2.7 Code alias %s on required defaults',
    async (fullName) => {
      const handler = createK27CodeHandler(fullName);

      const { createCalls } = await sendRequest(handler);

      assert.equal(createCalls[0].temperature, 1);
      assert.equal(createCalls[0].thinking, undefined);
    },
  );

  it.each(KIMI_K27_CODE_ALIASES)(
    'does not disable Kimi K2.7 alias %s during compaction',
    async (fullName) => {
      const handler = createK27CodeHandler(fullName);
      handler.setAgentCategory(AgentCategory.ToolUse);
      handler.requestCompaction();

      const { createCalls, createOptions, withOptions } = await sendRequest(
        handler,
        COMPACTION_TURN,
      );

      assert.equal(createCalls.length, 2);
      // Compaction retries ride per-request options, not a client clone.
      assert.deepEqual(withOptions.mock.calls, []);
      assert.equal(createOptions[0]?.maxRetries, 2);
      assert.equal(createCalls[0].temperature, 1);
      assert.equal(createCalls[0].thinking, undefined);
    },
  );

  it('uses the fixed Kimi K2.5 temperature during client-side compaction', async () => {
    const handler = createKimi25Handler(true);
    handler.setAgentCategory(AgentCategory.ToolUse);
    handler.requestCompaction();

    const { createCalls } = await sendRequest(handler, COMPACTION_TURN);

    assert.equal(createCalls.length, 2);
    assert.equal(createCalls[0].temperature, 1);
  });

  it('pins Kimi K2.5 non-reasoning chat requests to temperature 0.6 and disables thinking (#7081)', async () => {
    const handler = createKimi25Handler(false);

    const { createCalls } = await sendRequest(handler, [
      { role: 'user', content: 'hi' },
    ]);

    assert.equal(createCalls[0].temperature, 0.6);
    assert.deepEqual(createCalls[0].thinking, { type: 'disabled' });
  });

  it('pins Kimi K2.5 thinking chat requests to temperature 1 and leaves the API default (#7081)', async () => {
    const handler = createKimi25Handler(true);

    const { createCalls } = await sendRequest(handler);

    assert.equal(createCalls[0].temperature, 1);
    assert.equal(createCalls[0].thinking, undefined);
  });

  it.each(KIMI_K3_ALIASES)(
    'omits temperature and sends reasoning_effort max for Kimi K3 alias %s',
    async (fullName) => {
      // Moonshot fixes K3 sampling server-side (docs say omit temperature), and
      // its reasoning_effort field accepts only 'max' — the shared OpenAI clamp
      // would otherwise lower our MAX tier to 'xhigh', which Moonshot rejects.
      const handler = createK3Handler(fullName);

      const { createCalls } = await sendRequest(handler);

      assert.equal('temperature' in createCalls[0], false);
      assert.equal(createCalls[0].reasoning_effort, 'max');
      assert.equal(createCalls[0].thinking, undefined);
    },
  );

  it.each(KIMI_K3_ALIASES)(
    'preserves thinking in Kimi K3 alias %s compaction summaries',
    async (fullName) => {
      const handler = createK3Handler(fullName);
      handler.setAgentCategory(AgentCategory.ToolUse);
      handler.requestCompaction();

      const { createCalls } = await sendRequest(handler, COMPACTION_TURN);

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
    const handler = createKimi26Handler(false);

    const { createCalls } = await sendRequest(handler, [
      { role: 'user', content: 'hi' },
    ]);

    assert.deepEqual(createCalls[0].thinking, { type: 'disabled' });
    // K2.6 has no fixed-temperature requirement, so the caller's temperature
    // passes through unchanged.
    assert.equal(createCalls[0].temperature, 0);
  });

  it('leaves Kimi K2.6 thinking requests on the API default (#7081)', async () => {
    const handler = createKimi26Handler(true);

    const { createCalls } = await sendRequest(handler);

    assert.equal(createCalls[0].thinking, undefined);
  });

  it('maps GLM low reasoning effort to the provider minimum', async () => {
    const handler = createGlmHandler({
      name: 'glm52',
      fullName: 'glm-5.2',
      capabilities: {
        supportsReasoning: true,
        supportsReasoningEffort: true,
        reasoningEffort: ReasoningEffort.LOW,
      },
    });

    const { createCalls } = await sendRequest(handler);

    assert.deepEqual(createCalls[0].thinking, { type: 'enabled' });
    assert.equal(createCalls[0].reasoning_effort, 'high');
  });

  it('maps GLM max reasoning effort to the provider maximum', async () => {
    const handler = createGlmHandler({
      name: 'glm52',
      fullName: 'glm-5.2',
      capabilities: {
        supportsReasoning: true,
        supportsReasoningEffort: true,
        reasoningEffort: ReasoningEffort.MAX,
      },
    });

    const { createCalls } = await sendRequest(handler, [
      { role: 'user', content: 'think harder' },
    ]);

    assert.equal(createCalls[0].reasoning_effort, 'max');
  });

  it('passes medium reasoning effort through for current Grok models', async () => {
    const handler = createXaiHandler({
      name: 'grok45',
      fullName: 'grok-4.5',
      capabilities: {
        supportsReasoning: true,
        supportsReasoningEffort: true,
        reasoningEffort: ReasoningEffort.MEDIUM,
      },
    });

    const { createCalls } = await sendRequest(handler);

    assert.equal(createCalls[0].reasoning_effort, 'medium');
  });

  it('clamps above-high reasoning effort to high for Grok models', async () => {
    const handler = createXaiHandler({
      name: 'grok45',
      fullName: 'grok-4.5',
      capabilities: {
        supportsReasoning: true,
        supportsReasoningEffort: true,
        reasoningEffort: ReasoningEffort.XHIGH,
      },
    });

    const { createCalls } = await sendRequest(handler, [
      { role: 'user', content: 'think harder' },
    ]);

    assert.equal(createCalls[0].reasoning_effort, 'high');
  });
});
