// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';
import { ModelProvider, ReasoningEffort } from 'llm-zoo';

// Local imports
import { noopTrace } from '@agent/trace';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { ModelHandlerDeepSeek } from '@agent/modelHandlers/openai/modelHandlerDeepSeek';
import type { ToolDefinition } from '@model/ToolDefinition';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';

type ConfigOverrides = Parameters<typeof buildTestModelConfig>[1];

const DEEPSEEK_TEST_CONFIG = Object.freeze({
  name: 'deepseek-chat',
  fullName: 'deepseek-chat',
  shortName: 'deepseek-chat',
  provider: ModelProvider.DEEPSEEK,
  label: 'DeepSeek Chat',
  capabilities: Object.freeze({
    supportsReasoning: false,
    supportsVision: false,
  }),
});

function createHandler(overrides: ConfigOverrides = {}): ModelHandlerDeepSeek {
  return new ModelHandlerDeepSeek(
    buildTestModelConfig(DEEPSEEK_TEST_CONFIG, overrides),
  );
}

function thinkingFor(
  fullName: string,
  supportsReasoning: boolean,
): { type: 'enabled' | 'disabled' } | undefined {
  const handler = createHandler({
    fullName,
    capabilities: { supportsReasoning },
  });
  return (handler as any).getThinkingParameter();
}

function supportsForcedToolChoice(supportsReasoning: boolean): boolean {
  return createHandler({
    fullName: supportsReasoning ? 'deepseek-v4-pro' : 'deepseek-chat',
    capabilities: { supportsReasoning },
  }).supportsForcedToolChoice;
}

/**
 * Send one non-streaming completion through a stubbed Chat Completions client
 * and return the request params it received.
 */
async function captureRequestParams(
  handler: ModelHandlerDeepSeek,
  content: string,
  tools?: ToolDefinition[],
): Promise<any> {
  handler.setLogger({ ...noopTrace });
  (handler as any).getStreamingConfig = () => false;

  let capturedParams: any;
  // Structural stub standing in for the OpenAI client (same shape the handler
  // touches); typed loosely because it implements only the used surface.
  const client: any = {
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

  await handler.createResponse({
    client,
    messages: [{ role: 'user', content }],
    temperature: 0,
    tools,
  });

  return capturedParams;
}

// Any fullName not listed as non-thinking defaults ON, so 'deepseek-future'
// stands in for unlisted models. Update getThinkingParameter if a new
// non-thinking model is added.
const DEFAULT_ON_MODELS = [
  'deepseek-reasoner',
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'deepseek-future',
];

describe('ModelHandlerDeepSeek.getThinkingParameter', () => {
  it('deepseek-chat defaults OFF: omits param when reasoning disabled', () => {
    assert.equal(thinkingFor('deepseek-chat', false), undefined);
  });

  it('deepseek-chat defaults OFF: enables explicitly when reasoning requested', () => {
    assert.deepEqual(thinkingFor('deepseek-chat', true), { type: 'enabled' });
  });

  it.each(DEFAULT_ON_MODELS)(
    '%s defaults ON: omits param when reasoning requested',
    (fullName) => {
      assert.equal(thinkingFor(fullName, true), undefined);
    },
  );

  it.each(DEFAULT_ON_MODELS)(
    '%s defaults ON: disables explicitly when reasoning off',
    (fullName) => {
      assert.deepEqual(thinkingFor(fullName, false), { type: 'disabled' });
    },
  );
});

describe('ModelHandlerDeepSeek.supportsForcedToolChoice', () => {
  it('does not force tools in thinking mode', () => {
    assert.equal(supportsForcedToolChoice(true), false);
  });

  it('allows forced tools outside thinking mode', () => {
    assert.equal(supportsForcedToolChoice(false), true);
  });
});

describe('ModelHandlerDeepSeek tool conversion', () => {
  it('normalizes DeepSeek cache hit and miss tokens', () => {
    const usage = createHandler().normalizeUsage(
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
    const usage = createHandler().normalizeUsage(
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
    const usage = createHandler().normalizeUsage(
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
    const usage = createHandler().normalizeUsage(
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
    const capturedParams = await captureRequestParams(
      createHandler({
        capabilities: {
          supportsReasoning: true,
          supportsVision: false,
          reasoningEffort: ReasoningEffort.LOW,
        },
      }),
      'think',
    );

    assert.deepEqual(capturedParams.thinking, { type: 'enabled' });
    assert.equal(capturedParams.extra_body, undefined);
    assert.equal(capturedParams.reasoning_effort, 'high');
  });

  it('maps xhigh reasoning effort to DeepSeek max effort', async () => {
    const capturedParams = await captureRequestParams(
      createHandler({
        fullName: 'deepseek-v4-pro',
        capabilities: {
          supportsReasoning: true,
          supportsVision: false,
          reasoningEffort: ReasoningEffort.XHIGH,
        },
      }),
      'think harder',
    );

    assert.equal(capturedParams.thinking, undefined);
    assert.equal(capturedParams.reasoning_effort, 'max');
  });

  it('maps max reasoning effort to DeepSeek max effort', async () => {
    const capturedParams = await captureRequestParams(
      createHandler({
        fullName: 'deepseek-v4-pro',
        capabilities: {
          supportsReasoning: true,
          supportsVision: false,
          reasoningEffort: ReasoningEffort.MAX,
        },
      }),
      'think hardest',
    );

    // The internal 'max' tier survives the shared OpenAI clamp (max -> xhigh)
    // and DeepSeek's own validateReasoningEffort (xhigh -> max), landing on the
    // 'max' effort its API accepts rather than leaking an invalid value.
    assert.equal(capturedParams.reasoning_effort, 'max');
  });

  it('passes back content and reasoning_content in tool-call messages', async () => {
    const handler = createHandler({
      capabilities: {
        supportsReasoning: true,
        supportsVision: false,
      },
    });
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
    const handler = createHandler({
      capabilities: {
        supportsReasoning: true,
        supportsVision: false,
      },
    });
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
    const handler = createHandler({
      capabilities: {
        supportsReasoning: true,
        supportsVision: false,
      },
    });
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
    const handler = createHandler({
      capabilities: {
        supportsReasoning: true,
        supportsVision: false,
      },
    });
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

    const capturedParams = await captureRequestParams(
      createHandler(),
      'delegate this',
      tools,
    );

    assert.equal(capturedParams.tools[0].function.name, 'delegate_workflow');
    assert.equal(capturedParams.tools[0].function.strict, undefined);
  });
});

describe('ModelHandlerOpenAI DeepSeek official max_tokens ceiling (#7081)', () => {
  // Tool-use mode reduces max_tokens to 70% of the registry budget
  // (getEffectiveMaxOutputTokens); running these in tool-use mode makes
  // "override applied" vs. "override skipped" produce different numbers
  // instead of a coincidental match.
  // The low-budget non-reasoning case is registry-derived: gated on provider +
  // capability + the config's own maxOutputTokens, not on the literal fullName
  // 'deepseek-chat' — so a differently named low-budget entry is still capped
  // correctly.
  it.each([
    {
      name: 'bypasses the tool-use reduction for a low-budget non-reasoning DeepSeek entry, regardless of fullName',
      fullName: 'deepseek-legacy-chat',
      maxOutputTokens: 8192,
      supportsReasoning: false,
      expected: 8192,
    },
    {
      name: 'keeps the tool-use reduction for a current large-output non-reasoning DeepSeek entry',
      fullName: 'deepseek-v4-flash',
      maxOutputTokens: 393216,
      supportsReasoning: false,
      expected: Math.floor(393216 * 0.7),
    },
    {
      name: 'keeps the tool-use reduction for a reasoning DeepSeek entry even at a low registry budget',
      fullName: 'deepseek-legacy-reasoner',
      maxOutputTokens: 8192,
      supportsReasoning: true,
      expected: Math.floor(8192 * 0.7),
    },
  ])(
    '$name',
    async ({ fullName, maxOutputTokens, supportsReasoning, expected }) => {
      const handler = createHandler({
        fullName,
        maxOutputTokens,
        capabilities: { supportsReasoning },
      });
      handler.setAgentCategory(AgentCategory.ToolUse);

      const capturedParams = await captureRequestParams(handler, 'hi');

      assert.equal(capturedParams.max_tokens, expected);
    },
  );
});
