// Standard library imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { createPartFromText, type Content } from '@google/genai';
import { describe, it } from 'vitest';
import {
  DEFAULT_MODEL_CAPABILITIES,
  type ModelConfig,
  ModelProvider,
} from 'llm-zoo';

// Local imports - agent
import type { AgentTrace } from '@agent/trace';
import {
  AgentCategory,
  AgentSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { ModelHandlerAnthropic } from '@agent/modelHandlers/anthropic/modelHandlerAnthropic';
import { ModelHandlerGoogleGenAI } from '@agent/modelHandlers/google/modelHandlerGoogleGenAI';
import { ModelHandlerGoogleInteractions } from '@agent/modelHandlers/google/modelHandlerGoogleInteractions';
import { ModelHandlerOpenAI } from '@agent/modelHandlers/openai/modelHandlerOpenAI';
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/openai/modelHandlerOpenAIResponse';
import { ModelHandlerOpenRouterNative } from '@agent/modelHandlers/openrouter/modelHandlerOpenRouterNative';

// Type imports
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { ChatMessages } from '@openrouter/sdk/models';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ResponseInputItem } from 'openai/resources/responses/responses';
import type { Interactions } from '@google/genai';

type ContinuationCase = {
  name: string;
  run: () => void;
};

function createLoggerStub(): AgentTrace {
  return {
    streamId: 'test-channel',
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as unknown as AgentTrace;
}

function buildConfig(
  provider: ModelProvider,
  overrides: Partial<ModelConfig> = {},
): ModelConfig {
  return {
    name: 'test-model',
    label: 'Test Model',
    fullName: 'test-model',
    shortName: 'test-model',
    provider,
    maxOutputTokens: 1024,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 200000,
    capabilities: {
      ...DEFAULT_MODEL_CAPABILITIES,
      supportsAssistantPrefill: false,
      supportsIntermDevMsgs: false,
      supportsReasoning: false,
      supportsVision: false,
      ...(overrides.capabilities ?? {}),
    },
    openRouterOnly: false,
    ...overrides,
  };
}

const agentSetting = AgentSettingSchema.parse({
  agentCategory: AgentCategory.Workflow,
});

function createWorkspaceState(): AgentWorkspaceState {
  const workspaceState = AgentWorkspaceState.create();
  workspaceState.assembly.lastResponse = 'partial';
  workspaceState.assembly.accumulatedOutput = 'partial resumed';
  return workspaceState;
}

function textFromOpenAiContent(
  content: ChatCompletionMessageParam['content'],
): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => ('text' in part ? part.text : '')).join('');
}

function textFromResponseContent(message: ResponseInputItem): string {
  const content = 'content' in message ? message.content : undefined;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => ('text' in part ? part.text : '')).join('');
}

function textFromAnthropicContent(message: MessageParam): string {
  const { content } = message;
  if (typeof content === 'string') return content;
  return content.map((part) => ('text' in part ? part.text : '')).join('');
}

function textFromGoogleContent(message: Content): string {
  return (message.parts ?? []).map((part) => part.text ?? '').join('');
}

function textFromInteractionStep(step: Interactions.Step): string {
  if (!('content' in step) || !Array.isArray(step.content)) return '';
  return step.content.map((part) => ('text' in part ? part.text : '')).join('');
}

function assertSingleAssistantTurn(messages: readonly unknown[]): void {
  assert.equal(
    messages.length,
    1,
    'continuation prompt should be removed after the resumed response lands',
  );
}

const cases: ContinuationCase[] = [
  {
    name: 'OpenAI chat',
    run: () => {
      const handler = new ModelHandlerOpenAI(buildConfig(ModelProvider.OPENAI));
      handler.setLogger(createLoggerStub());
      const messages: ChatCompletionMessageParam[] = [
        handler.createAssistantMessage('partial'),
      ];
      const workspaceState = createWorkspaceState();

      handler.addContinueMessage(messages, workspaceState, agentSetting);
      handler.updateMessageContent(messages, '', ' resumed', workspaceState);

      assertSingleAssistantTurn(messages);
      assert.equal(messages.at(-1)?.role, 'assistant');
      assert.equal(
        textFromOpenAiContent(messages.at(-1)?.content),
        'partial resumed',
      );
    },
  },
  {
    name: 'OpenAI Responses',
    run: () => {
      const handler = new ModelHandlerOpenAIResponse(
        buildConfig(ModelProvider.OPENAI),
      );
      handler.setLogger(createLoggerStub());
      const messages: ResponseInputItem[] = [
        handler.createAssistantMessage('partial'),
      ];
      const workspaceState = createWorkspaceState();

      handler.addContinueMessage(messages, workspaceState, agentSetting);
      handler.updateMessageContent(messages, '', ' resumed', workspaceState);

      assertSingleAssistantTurn(messages);
      assert.equal(
        textFromResponseContent(messages.at(-1)!),
        'partial resumed',
      );
    },
  },
  {
    name: 'Anthropic',
    run: () => {
      const handler = new ModelHandlerAnthropic(
        buildConfig(ModelProvider.ANTHROPIC),
      );
      handler.setLogger(createLoggerStub());
      const messages: MessageParam[] = [
        handler.createAssistantMessage('partial'),
      ];
      const workspaceState = createWorkspaceState();

      handler.addContinueMessage(messages, workspaceState, agentSetting);
      handler.updateMessageContent(messages, '', ' resumed', workspaceState);

      assertSingleAssistantTurn(messages);
      assert.equal(messages.at(-1)?.role, 'assistant');
      assert.equal(
        textFromAnthropicContent(messages.at(-1)!),
        'partial resumed',
      );
    },
  },
  {
    name: 'Google GenAI',
    run: () => {
      const handler = new ModelHandlerGoogleGenAI(
        buildConfig(ModelProvider.GOOGLE),
      );
      handler.setLogger(createLoggerStub());
      const messages: Content[] = [
        { role: 'model', parts: [createPartFromText('partial')] },
      ];
      const workspaceState = createWorkspaceState();

      handler.addContinueMessage(messages, workspaceState, agentSetting);
      handler.updateMessageContent(messages, '', ' resumed', workspaceState);

      assertSingleAssistantTurn(messages);
      assert.equal(messages.at(-1)?.role, 'model');
      assert.equal(textFromGoogleContent(messages.at(-1)!), 'partial resumed');
    },
  },
  {
    name: 'Google Interactions',
    run: () => {
      const handler = new ModelHandlerGoogleInteractions(
        buildConfig(ModelProvider.GOOGLE),
      );
      handler.setLogger(createLoggerStub());
      const messages: Interactions.Step[] = [
        handler.createAssistantMessage('partial'),
      ];
      const workspaceState = createWorkspaceState();

      handler.addContinueMessage(messages, workspaceState, agentSetting);
      handler.updateMessageContent(messages, '', ' resumed', workspaceState);

      assertSingleAssistantTurn(messages);
      assert.equal(messages.at(-1)?.type, 'model_output');
      assert.equal(
        textFromInteractionStep(messages.at(-1)!),
        'partial resumed',
      );
    },
  },
  {
    name: 'OpenRouter native',
    run: () => {
      const handler = new ModelHandlerOpenRouterNative(
        buildConfig(ModelProvider.OPENAI, {
          openrouterFullName: 'openai/test-model',
        }),
      );
      handler.setLogger(createLoggerStub());
      const messages: ChatMessages[] = [
        handler.createAssistantMessage('partial'),
      ];
      const workspaceState = createWorkspaceState();

      handler.addContinueMessage(messages, workspaceState, agentSetting);
      handler.updateMessageContent(messages, '', ' resumed', workspaceState);

      assertSingleAssistantTurn(messages);
      assert.equal(messages.at(-1)?.role, 'assistant');
      assert.equal(
        textFromOpenAiContent(
          messages.at(-1)?.content as ChatCompletionMessageParam['content'],
        ),
        'partial resumed',
      );
    },
  },
];

describe('model handler continuation contract', () => {
  for (const testCase of cases) {
    it(`appends resumed text to the previous assistant turn for ${testCase.name}`, () => {
      testCase.run();
    });
  }

  it('keeps Google GenAI continuation prompts separate from trailing user turns', () => {
    const handler = new ModelHandlerGoogleGenAI(
      buildConfig(ModelProvider.GOOGLE),
    );
    handler.setLogger(createLoggerStub());
    const messages: Content[] = [
      { role: 'model', parts: [createPartFromText('partial')] },
      { role: 'user', parts: [createPartFromText('follow-up')] },
    ];
    const workspaceState = createWorkspaceState();

    handler.addContinueMessage(messages, workspaceState, agentSetting);

    assert.equal(messages.length, 3);
    assert.equal(textFromGoogleContent(messages[1]!), 'follow-up');
    assert.match(
      textFromGoogleContent(messages[2]!),
      /continue responding exactly from where you left/i,
    );

    handler.updateMessageContent(messages, '', ' resumed', workspaceState);

    assert.equal(messages.length, 3);
    assert.equal(textFromGoogleContent(messages[1]!), 'follow-up');
    assert.equal(messages.at(-1)?.role, 'model');
    assert.equal(textFromGoogleContent(messages.at(-1)!), 'partial resumed');
  });

  it('falls back to accumulated output when OpenAI Responses continuation follows a user turn', () => {
    const handler = new ModelHandlerOpenAIResponse(
      buildConfig(ModelProvider.OPENAI),
    );
    handler.setLogger(createLoggerStub());
    const messages: ResponseInputItem[] = [
      handler.createAssistantMessage('partial'),
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'follow-up' }],
      },
    ];
    const workspaceState = createWorkspaceState();

    handler.addContinueMessage(messages, workspaceState, agentSetting);

    assert.equal(messages.length, 3);
    assert.equal(textFromResponseContent(messages[1]!), 'follow-up');
    assert.match(
      textFromResponseContent(messages[2]!),
      /continue responding exactly from where you left/i,
    );

    handler.updateMessageContent(messages, '', ' resumed', workspaceState);

    assert.equal(messages.length, 3);
    assert.equal(textFromResponseContent(messages[1]!), 'follow-up');
    assert.equal(textFromResponseContent(messages.at(-1)!), 'partial resumed');
  });

  it('keeps Google Interactions continuation prompts separate from trailing user turns', () => {
    const handler = new ModelHandlerGoogleInteractions(
      buildConfig(ModelProvider.GOOGLE),
    );
    handler.setLogger(createLoggerStub());
    const messages: Interactions.Step[] = [
      handler.createAssistantMessage('partial'),
      { type: 'user_input', content: [{ type: 'text', text: 'follow-up' }] },
    ];
    const workspaceState = createWorkspaceState();

    handler.addContinueMessage(messages, workspaceState, agentSetting);

    assert.equal(messages.length, 3);
    assert.equal(textFromInteractionStep(messages[1]!), 'follow-up');
    assert.match(
      textFromInteractionStep(messages[2]!),
      /continue responding exactly from where you left/i,
    );

    handler.updateMessageContent(messages, '', ' resumed', workspaceState);

    assert.equal(messages.length, 3);
    assert.equal(textFromInteractionStep(messages[1]!), 'follow-up');
    assert.equal(messages.at(-1)?.type, 'model_output');
    assert.equal(textFromInteractionStep(messages.at(-1)!), 'partial resumed');
  });
});

describe('model handler system message refresh contract (tool-use resume)', () => {
  it('rewrites the persisted system message for OpenAI chat, preserving block type and any later dev message', async () => {
    const config = buildConfig(ModelProvider.OPENAI);
    config.capabilities.supportsIntermDevMsgs = true;
    const handler = new ModelHandlerOpenAI(config);
    handler.setLogger(createLoggerStub());
    const messages = await handler.initializeMessages(
      'prefix',
      'the task request',
      undefined,
      'stale system text',
    );

    // system(0), user(1, prefix), system(2, request) — supportsIntermDevMsgs
    // routes the request itself through a second role='system' message that
    // must not be mistaken for the persisted system prompt.
    assert.equal(messages.length, 3);
    assert.equal(messages[0]?.role, 'system');
    assert.equal(messages[2]?.role, 'system');

    const refreshed = handler.refreshSystemMessage(messages, 'fresh system text');

    assert.equal(
      textFromOpenAiContent(refreshed[0]?.content),
      'fresh system text',
    );
    assert.equal(
      (refreshed[0]?.content as { type?: string }[] | undefined)?.[0]?.type,
      'text',
    );
    assert.equal(
      textFromOpenAiContent(refreshed[2]?.content),
      'the task request',
    );
  });

  it('rewrites the persisted system message for OpenAI Responses, preserving the input_text block type', async () => {
    const handler = new ModelHandlerOpenAIResponse(
      buildConfig(ModelProvider.OPENAI),
    );
    handler.setLogger(createLoggerStub());
    const messages = await handler.initializeMessages(
      'prefix',
      'the task request',
      undefined,
      'stale system text',
    );

    const refreshed = handler.refreshSystemMessage(messages, 'fresh system text');

    assert.equal(
      textFromResponseContent(refreshed[0]!),
      'fresh system text',
    );
    const firstContent = (refreshed[0] as { content: { type?: string }[] })
      .content;
    assert.equal(firstContent[0]?.type, 'input_text');
  });

  it('rewrites only the first content block for o1-style user-role system prompts (supportsSystemPrompt: false)', async () => {
    const config = buildConfig(ModelProvider.OPENAI);
    config.capabilities.supportsSystemPrompt = false;
    const handler = new ModelHandlerOpenAI(config);
    handler.setLogger(createLoggerStub());
    const messages = await handler.initializeMessages(
      'prefix text',
      'request text',
      undefined,
      'stale system text',
    );

    // No real 'system' role available: the prompt and prefix share a single
    // role='user' message, system text as the first content block.
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.role, 'user');

    const refreshed = handler.refreshSystemMessage(messages, 'fresh system text');

    const content = (
      refreshed[0] as { content: { text?: string }[] }
    ).content;
    assert.equal(content[0]?.text, 'fresh system text');
    assert.equal(content[1]?.text, 'prefix text');
  });

  it('rewrites the persisted system message for OpenRouter native even when config.provider is Anthropic (still embeds in messages, per requiresPerCallSystemPrompt)', async () => {
    const handler = new ModelHandlerOpenRouterNative(
      buildConfig(ModelProvider.ANTHROPIC, {
        openrouterFullName: 'anthropic/test-model',
      }),
    );
    handler.setLogger(createLoggerStub());
    const messages = await handler.initializeMessages(
      'prefix',
      'the task request',
      undefined,
      'stale system text',
    );

    const refreshed = handler.refreshSystemMessage(messages, 'fresh system text');

    assert.equal(
      textFromOpenAiContent(
        refreshed[0]?.content as ChatCompletionMessageParam['content'],
      ),
      'fresh system text',
    );
  });

  const perCallSystemPromptCases = [
    {
      name: 'Anthropic',
      handler: new ModelHandlerAnthropic(buildConfig(ModelProvider.ANTHROPIC)),
    },
    {
      name: 'Google GenAI',
      handler: new ModelHandlerGoogleGenAI(buildConfig(ModelProvider.GOOGLE)),
    },
    {
      name: 'Google Interactions',
      handler: new ModelHandlerGoogleInteractions(
        buildConfig(ModelProvider.GOOGLE),
      ),
    },
  ];

  for (const { name, handler } of perCallSystemPromptCases) {
    it(`is a no-op for ${name}, which resupplies the system prompt per call instead of storing it in messages`, async () => {
      handler.setLogger(createLoggerStub());
      const messages = await handler.initializeMessages(
        'prefix',
        'request',
        undefined,
        'stale system text',
      );

      const refreshed = handler.refreshSystemMessage(
        messages as never,
        'fresh system text',
      );

      assert.equal(refreshed, messages);
    });
  }
});
