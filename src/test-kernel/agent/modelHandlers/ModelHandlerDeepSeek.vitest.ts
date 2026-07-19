// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Standard library imports

// Third-party imports
import {
  DEFAULT_MODEL_CAPABILITIES,
  type ModelConfig,
  ModelProvider,
  ReasoningEffort,
} from 'llm-zoo';

// Local imports - agent
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { ModelHandlerDeepSeek } from '@agent/modelHandlers/openai/modelHandlerDeepSeek';
import { noopTrace } from '@agent/trace/noopTrace';

// Type imports
import type { ToolDefinition } from '@model';

import { buildTestModelConfig } from './testFixtures';

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

const DEEPSEEK_TEST_CONFIG = {
  name: 'deepseek-chat',
  fullName: 'deepseek-chat',
  shortName: 'deepseek-chat',
  provider: ModelProvider.DEEPSEEK,
  label: 'DeepSeek Chat',
  capabilities: { supportsReasoning: false, supportsVision: false },
};

function stubHandlerForTest(handler: ModelHandlerDeepSeek): void {
  handler.setLogger({ ...noopTrace });
  (handler as any).getStreamingConfig = () => false;
}

/**
 * Build a Chat Completions client whose `create` records the request params and
 * returns a minimal completion, exposing the captured params for assertions.
 */
function createCapturingClient(): { client: any; getParams: () => any } {
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
  return { client, getParams: () => capturedParams };
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
  it('normalizes DeepSeek cache hit and miss tokens', () => {
    const handler = new ModelHandlerDeepSeek(
      buildTestModelConfig(DEEPSEEK_TEST_CONFIG),
    );

    const usage = handler.normalizeUsage(
      {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_cache_hit_tokens: 70,
        prompt_cache_miss_tokens: 30,
      },
      2500,
    );

    assert.equal(usage.inputTokens, 100);
    assert.equal(usage.outputTokens, 20);
    assert.equal(usage.cachedInputTokens, 70);
    assert.equal(usage.cacheMissInputTokens, 30);
    assert.equal(usage.percentageCached, 70);
  });

  it('falls back to DeepSeek cache hit plus miss when prompt_tokens is absent', () => {
    const handler = new ModelHandlerDeepSeek(
      buildTestModelConfig(DEEPSEEK_TEST_CONFIG),
    );

    const usage = handler.normalizeUsage(
      {
        completion_tokens: 20,
        total_tokens: 120,
        prompt_cache_hit_tokens: 70,
        prompt_cache_miss_tokens: 30,
      } as any,
      2500,
    );

    assert.equal(usage.inputTokens, 100);
    assert.equal(usage.cachedInputTokens, 70);
    assert.equal(usage.cacheMissInputTokens, 30);
  });

  it('maps prompt_tokens_details.cache_write_tokens to cacheCreationTokens', () => {
    const handler = new ModelHandlerDeepSeek(
      buildTestModelConfig(DEEPSEEK_TEST_CONFIG),
    );

    const usage = handler.normalizeUsage(
      {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 15 },
      } as any,
      2500,
    );

    assert.equal(usage.cacheCreationTokens, 15);
    assert.equal(usage.cachedInputTokens, 10);
  });

  it('defaults cacheCreationTokens to undefined when cache_write_tokens is absent', () => {
    const handler = new ModelHandlerDeepSeek(
      buildTestModelConfig(DEEPSEEK_TEST_CONFIG),
    );

    const usage = handler.normalizeUsage(
      {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 0 },
      } as any,
      2500,
    );

    assert.equal(usage.cacheCreationTokens, undefined);
  });

  it('passes thinking toggle and low effort in OpenAI wire format', async () => {
    const handler = new ModelHandlerDeepSeek(
      buildTestModelConfig(DEEPSEEK_TEST_CONFIG, {
        capabilities: {
          ...DEFAULT_MODEL_CAPABILITIES,
          supportsReasoning: true,
          supportsVision: false,
          reasoningEffort: ReasoningEffort.LOW,
        },
      }),
    );
    stubHandlerForTest(handler);

    const { client, getParams } = createCapturingClient();

    await handler.createResponse({
      client,
      messages: [{ role: 'user', content: 'think' }],
      temperature: 0,
    });

    const capturedParams = getParams();
    assert.deepEqual(capturedParams.thinking, { type: 'enabled' });
    assert.equal(capturedParams.extra_body, undefined);
    assert.equal(capturedParams.reasoning_effort, 'high');
  });

  it('maps xhigh reasoning effort to DeepSeek max effort', async () => {
    const handler = new ModelHandlerDeepSeek(
      buildTestModelConfig(DEEPSEEK_TEST_CONFIG, {
        fullName: 'deepseek-v4-pro',
        capabilities: {
          ...DEFAULT_MODEL_CAPABILITIES,
          supportsReasoning: true,
          supportsVision: false,
          reasoningEffort: ReasoningEffort.XHIGH,
        },
      }),
    );
    stubHandlerForTest(handler);

    const { client, getParams } = createCapturingClient();

    await handler.createResponse({
      client,
      messages: [{ role: 'user', content: 'think harder' }],
      temperature: 0,
    });

    const capturedParams = getParams();
    assert.equal(capturedParams.thinking, undefined);
    assert.equal(capturedParams.reasoning_effort, 'max');
  });

  it('maps max reasoning effort to DeepSeek max effort', async () => {
    const handler = new ModelHandlerDeepSeek(
      buildTestModelConfig(DEEPSEEK_TEST_CONFIG, {
        fullName: 'deepseek-v4-pro',
        capabilities: {
          ...DEFAULT_MODEL_CAPABILITIES,
          supportsReasoning: true,
          supportsVision: false,
          reasoningEffort: ReasoningEffort.MAX,
        },
      }),
    );
    stubHandlerForTest(handler);

    const { client, getParams } = createCapturingClient();

    await handler.createResponse({
      client,
      messages: [{ role: 'user', content: 'think hardest' }],
      temperature: 0,
    });

    const capturedParams = getParams();
    // The internal 'max' tier survives the shared OpenAI clamp (max -> xhigh)
    // and DeepSeek's own validateReasoningEffort (xhigh -> max), landing on the
    // 'max' effort its API accepts rather than leaking an invalid value.
    assert.equal(capturedParams.reasoning_effort, 'max');
  });

  it('passes back content and reasoning_content in tool-call messages', async () => {
    const handler = new ModelHandlerDeepSeek(
      buildTestModelConfig(DEEPSEEK_TEST_CONFIG, {
        capabilities: {
          ...DEFAULT_MODEL_CAPABILITIES,
          supportsReasoning: true,
          supportsVision: false,
        },
      }),
    );
    const workspace = {
      reasoning: {
        thinkingBlocks: [
          { type: 'thinking', thinking: 'Need to call both tools.' },
        ],
      },
      resetReasoning() {
        this.reasoning.thinkingBlocks = [];
      },
    };

    const messages = await handler.createBatchedToolUseFollowUpMessages(
      [
        {
          call: {
            raw: {
              id: 'call_1',
              type: 'function',
              function: { name: 'first_tool', arguments: '{}' },
            },
          },
          result: { status: 'executed', output: 'first result' },
          attachments: [],
        },
        {
          call: {
            raw: {
              id: 'call_2',
              type: 'function',
              function: { name: 'second_tool', arguments: '{}' },
            },
          },
          result: { status: 'executed', output: 'second result' },
          attachments: [],
        },
      ] as any,
      workspace as any,
      '',
    );

    assert.equal(messages.length, 3);
    assert.equal(messages[0].role, 'assistant');
    assert.equal((messages[0] as any).content, '');
    assert.equal(
      (messages[0] as any).reasoning_content,
      'Need to call both tools.',
    );
    assert.equal(messages[1].role, 'tool');
    assert.equal((messages[1] as any).tool_call_id, 'call_1');
    assert.equal(messages[2].role, 'tool');
    assert.equal((messages[2] as any).tool_call_id, 'call_2');
  });

  it('includes empty reasoning_content in tool-call messages when model generated none', async () => {
    const handler = new ModelHandlerDeepSeek(
      buildTestModelConfig(DEEPSEEK_TEST_CONFIG, {
        capabilities: {
          ...DEFAULT_MODEL_CAPABILITIES,
          supportsReasoning: true,
          supportsVision: false,
        },
      }),
    );
    const workspace = {
      reasoning: {
        thinkingBlocks: [] as Array<{ type: string; thinking: string }>,
      },
      resetReasoning() {
        this.reasoning.thinkingBlocks = [];
      },
    };

    const messages = await handler.createBatchedToolUseFollowUpMessages(
      [
        {
          call: {
            raw: {
              id: 'call_1',
              type: 'function',
              function: { name: 'some_tool', arguments: '{}' },
            },
          },
          result: { status: 'executed', output: 'result' },
          attachments: [],
        },
      ] as any,
      workspace as any,
      '',
    );

    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'assistant');
    // reasoning_content must always be present in thinking mode, even as empty string
    assert.equal((messages[0] as any).reasoning_content, '');
  });

  it('passes back response reasoning_content on final assistant messages', () => {
    const handler = new ModelHandlerDeepSeek(
      buildTestModelConfig(DEEPSEEK_TEST_CONFIG, {
        capabilities: {
          ...DEFAULT_MODEL_CAPABILITIES,
          supportsReasoning: true,
          supportsVision: false,
        },
      }),
    );
    const response = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'final answer',
            reasoning_content: 'Tool result is sufficient.',
          },
        },
      ],
    };

    const message = handler.createAssistantMessageFromResponse(
      response as any,
      'final answer',
    );

    assert.equal(message.role, 'assistant');
    assert.equal((message as any).content, 'final answer');
    assert.equal(
      (message as any).reasoning_content,
      'Tool result is sufficient.',
    );
  });

  it('includes empty reasoning_content on final assistant messages when model generated none', () => {
    const handler = new ModelHandlerDeepSeek(
      buildTestModelConfig(DEEPSEEK_TEST_CONFIG, {
        capabilities: {
          ...DEFAULT_MODEL_CAPABILITIES,
          supportsReasoning: true,
          supportsVision: false,
        },
      }),
    );
    const response = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'final answer',
            // no reasoning_content
          },
        },
      ],
    };

    const message = handler.createAssistantMessageFromResponse(
      response as any,
      'final answer',
    );

    assert.equal(message.role, 'assistant');
    // reasoning_content must always be present in thinking mode, even as empty string
    assert.equal((message as any).reasoning_content, '');
  });

  it('sends nullable Chat Completions tools without SDK strict auto-parse validation', async () => {
    const handler = new ModelHandlerDeepSeek(
      buildTestModelConfig(DEEPSEEK_TEST_CONFIG),
    );
    stubHandlerForTest(handler);

    const { client, getParams } = createCapturingClient();
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
      client,
      messages: [{ role: 'user', content: 'delegate this' }],
      temperature: 0,
      tools,
    });

    const capturedParams = getParams();
    assert.equal(capturedParams.tools[0].function.name, 'delegate_workflow');
    assert.equal(capturedParams.tools[0].function.strict, undefined);
  });
});

describe('ModelHandlerOpenAI DeepSeek official max_tokens ceiling (#7081)', () => {
  // Tool-use mode reduces max_tokens to 70% of the registry budget
  // (getEffectiveMaxOutputTokens); running these in tool-use mode makes
  // "override applied" vs. "override skipped" produce different numbers
  // instead of a coincidental match.
  it('bypasses the tool-use reduction for a low-budget non-reasoning DeepSeek entry, regardless of fullName', async () => {
    // Registry-derived: gated on provider + capability + the config's own
    // maxOutputTokens, not on the literal fullName 'deepseek-chat' — so a
    // differently named low-budget entry is still capped correctly.
    const handler = new ModelHandlerDeepSeek(
      buildTestModelConfig(DEEPSEEK_TEST_CONFIG, {
        fullName: 'deepseek-legacy-chat',
        maxOutputTokens: 8192,
        capabilities: {
          ...DEFAULT_MODEL_CAPABILITIES,
          supportsReasoning: false,
        },
      }),
    );
    handler.setAgentCategory(AgentCategory.ToolUse);
    stubHandlerForTest(handler);
    const { client, getParams } = createCapturingClient();

    await handler.createResponse({
      client,
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0,
    });

    assert.equal(getParams().max_tokens, 8192);
  });

  it('keeps the tool-use reduction for a current large-output non-reasoning DeepSeek entry', async () => {
    const handler = new ModelHandlerDeepSeek(
      buildTestModelConfig(DEEPSEEK_TEST_CONFIG, {
        fullName: 'deepseek-v4-flash',
        maxOutputTokens: 393216,
        capabilities: {
          ...DEFAULT_MODEL_CAPABILITIES,
          supportsReasoning: false,
        },
      }),
    );
    handler.setAgentCategory(AgentCategory.ToolUse);
    stubHandlerForTest(handler);
    const { client, getParams } = createCapturingClient();

    await handler.createResponse({
      client,
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0,
    });

    assert.equal(getParams().max_tokens, Math.floor(393216 * 0.7));
  });

  it('keeps the tool-use reduction for a reasoning DeepSeek entry even at a low registry budget', async () => {
    const handler = new ModelHandlerDeepSeek(
      buildTestModelConfig(DEEPSEEK_TEST_CONFIG, {
        fullName: 'deepseek-legacy-reasoner',
        maxOutputTokens: 8192,
        capabilities: {
          ...DEFAULT_MODEL_CAPABILITIES,
          supportsReasoning: true,
        },
      }),
    );
    handler.setAgentCategory(AgentCategory.ToolUse);
    stubHandlerForTest(handler);
    const { client, getParams } = createCapturingClient();

    await handler.createResponse({
      client,
      messages: [{ role: 'user', content: 'think' }],
      temperature: 0,
    });

    assert.equal(getParams().max_tokens, Math.floor(8192 * 0.7));
  });
});
