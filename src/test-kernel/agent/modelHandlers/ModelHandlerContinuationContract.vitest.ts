// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';
import { ModelProvider } from 'llm-zoo';

// Local imports
import { noopTrace } from '@agent/trace';
import {
  AgentCategory,
  AgentSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { ModelHandlerAnthropic } from '@agent/modelHandlers/anthropic/modelHandlerAnthropic';
import { ModelHandlerGoogleInteractions } from '@agent/modelHandlers/google/modelHandlerGoogleInteractions';
import { ModelHandlerOpenAI } from '@agent/modelHandlers/openai/modelHandlerOpenAI';
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/openai/modelHandlerOpenAIResponse';
import { ModelHandlerOpenRouterNative } from '@agent/modelHandlers/openrouter/modelHandlerOpenRouterNative';
import { ModelHandlerVscodeLm } from '@agent/modelHandlers/vscodelm/modelHandlerVscodeLm';
import type { LanguageModelMessage } from '@platform/languageModel';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';

// Third-party imports
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { ChatMessages } from '@openrouter/sdk/models';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ResponseInputItem } from 'openai/resources/responses/responses';
import type { Interactions } from '@google/genai';

type ContinuationCase = {
  name: string;
  run: () => void;
};

const CONTINUATION_CAPABILITIES = Object.freeze({
  supportsAssistantPrefill: false,
  supportsIntermDevMsgs: false,
  supportsReasoning: false,
  supportsVision: false,
});

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

function textFromInteractionStep(step: Interactions.Step): string {
  if (!('content' in step) || !Array.isArray(step.content)) return '';
  return step.content.map((part) => ('text' in part ? part.text : '')).join('');
}

function textFromVscodeLmMessage(message: LanguageModelMessage): string {
  return message.content
    .map((part) => (part.kind === 'text' ? part.text : ''))
    .join('');
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
      const handler = new ModelHandlerOpenAI(
        buildTestModelConfig({
          provider: ModelProvider.OPENAI,
          capabilities: CONTINUATION_CAPABILITIES,
        }),
      );
      handler.setLogger({ ...noopTrace });
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
        buildTestModelConfig({
          provider: ModelProvider.OPENAI,
          capabilities: CONTINUATION_CAPABILITIES,
        }),
      );
      handler.setLogger({ ...noopTrace });
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
        buildTestModelConfig({
          provider: ModelProvider.ANTHROPIC,
          capabilities: CONTINUATION_CAPABILITIES,
        }),
      );
      handler.setLogger({ ...noopTrace });
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
    name: 'Google Interactions',
    run: () => {
      const handler = new ModelHandlerGoogleInteractions(
        buildTestModelConfig({
          provider: ModelProvider.GOOGLE,
          capabilities: CONTINUATION_CAPABILITIES,
        }),
      );
      handler.setLogger({ ...noopTrace });
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
        buildTestModelConfig({
          provider: ModelProvider.OPENAI,
          capabilities: CONTINUATION_CAPABILITIES,
          openrouterFullName: 'openai/test-model',
        }),
      );
      handler.setLogger({ ...noopTrace });
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
  {
    name: 'VS Code LM',
    run: () => {
      const handler = new ModelHandlerVscodeLm(
        buildTestModelConfig({
          provider: ModelProvider.COPILOT,
          capabilities: CONTINUATION_CAPABILITIES,
        }),
      );
      handler.setLogger({ ...noopTrace });
      const messages: LanguageModelMessage[] = [
        handler.createAssistantMessage('partial'),
      ];
      const workspaceState = createWorkspaceState();

      handler.addContinueMessage(messages, workspaceState, agentSetting);
      assert.equal(messages.length, 2);
      assert.equal(messages.at(-1)?.role, 'user');
      assert.match(
        textFromVscodeLmMessage(messages.at(-1)!),
        /continue responding exactly from where you left/i,
      );

      handler.updateMessageContent(messages, '', ' resumed', workspaceState);

      assertSingleAssistantTurn(messages);
      assert.equal(messages.at(-1)?.role, 'assistant');
      assert.equal(
        textFromVscodeLmMessage(messages.at(-1)!),
        'partial\n\n resumed',
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

  it('preserves OpenAI-family system continuation messages after resumed output', () => {
    const capabilities = {
      ...CONTINUATION_CAPABILITIES,
      supportsIntermDevMsgs: true,
    };

    const chatHandler = new ModelHandlerOpenAI(
      buildTestModelConfig({
        provider: ModelProvider.OPENAI,
        capabilities,
      }),
    );
    chatHandler.setLogger({ ...noopTrace });
    const chatMessages: ChatCompletionMessageParam[] = [
      chatHandler.createAssistantMessage('partial'),
    ];
    const chatWorkspaceState = createWorkspaceState();
    chatHandler.addContinueMessage(
      chatMessages,
      chatWorkspaceState,
      agentSetting,
    );
    const chatContinuation = chatMessages.at(-1)!;
    assert.equal(chatMessages.length, 2);
    const chatContinuationText = textFromOpenAiContent(
      chatContinuation.content,
    );
    assert.match(
      chatContinuationText,
      /continue responding exactly from where you left/i,
    );
    assert.deepEqual(chatContinuation, {
      role: 'system',
      content: [{ type: 'text', text: chatContinuationText }],
    });
    chatHandler.updateMessageContent(
      chatMessages,
      '',
      ' resumed',
      chatWorkspaceState,
    );
    assert.equal(chatMessages.length, 2);
    assert.equal(
      textFromOpenAiContent(chatMessages[0]?.content),
      'partial resumed',
    );
    assert.equal(chatMessages.at(-1), chatContinuation);

    const responseHandler = new ModelHandlerOpenAIResponse(
      buildTestModelConfig({
        provider: ModelProvider.OPENAI,
        capabilities,
      }),
    );
    responseHandler.setLogger({ ...noopTrace });
    const responseMessages: ResponseInputItem[] = [
      responseHandler.createAssistantMessage('partial'),
    ];
    const responseWorkspaceState = createWorkspaceState();
    responseHandler.addContinueMessage(
      responseMessages,
      responseWorkspaceState,
      agentSetting,
    );
    const responseContinuation = responseMessages.at(-1)!;
    assert.equal(responseMessages.length, 2);
    const responseContinuationText =
      textFromResponseContent(responseContinuation);
    assert.match(
      responseContinuationText,
      /continue responding exactly from where you left/i,
    );
    assert.deepEqual(responseContinuation, {
      type: 'message',
      role: 'system',
      content: [{ type: 'input_text', text: responseContinuationText }],
    });
    responseHandler.updateMessageContent(
      responseMessages,
      '',
      ' resumed',
      responseWorkspaceState,
    );
    assert.equal(responseMessages.length, 2);
    assert.equal(
      textFromResponseContent(responseMessages[0]!),
      'partial resumed',
    );
    assert.equal(responseMessages.at(-1), responseContinuation);

    const openRouterHandler = new ModelHandlerOpenRouterNative(
      buildTestModelConfig({
        provider: ModelProvider.OPENAI,
        capabilities,
        openrouterFullName: 'openai/test-model',
      }),
    );
    openRouterHandler.setLogger({ ...noopTrace });
    const openRouterMessages: ChatMessages[] = [
      openRouterHandler.createAssistantMessage('partial'),
    ];
    const openRouterWorkspaceState = createWorkspaceState();
    openRouterHandler.addContinueMessage(
      openRouterMessages,
      openRouterWorkspaceState,
      agentSetting,
    );
    const openRouterContinuation = openRouterMessages.at(-1)!;
    assert.equal(openRouterMessages.length, 2);
    const openRouterContinuationText = textFromOpenAiContent(
      openRouterContinuation.content as ChatCompletionMessageParam['content'],
    );
    assert.match(
      openRouterContinuationText,
      /continue responding exactly from where you left/i,
    );
    assert.deepEqual(openRouterContinuation, {
      role: 'system',
      content: [{ type: 'text', text: openRouterContinuationText }],
    });
    openRouterHandler.updateMessageContent(
      openRouterMessages,
      '',
      ' resumed',
      openRouterWorkspaceState,
    );
    assert.equal(openRouterMessages.length, 2);
    assert.equal(
      textFromOpenAiContent(
        openRouterMessages[0]?.content as ChatCompletionMessageParam['content'],
      ),
      'partial resumed',
    );
    assert.equal(openRouterMessages.at(-1), openRouterContinuation);
  });

  it('falls back to accumulated output when OpenAI Responses continuation follows a user turn', () => {
    const handler = new ModelHandlerOpenAIResponse(
      buildTestModelConfig({
        provider: ModelProvider.OPENAI,
        capabilities: CONTINUATION_CAPABILITIES,
      }),
    );
    handler.setLogger({ ...noopTrace });
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
      buildTestModelConfig({
        provider: ModelProvider.GOOGLE,
        capabilities: CONTINUATION_CAPABILITIES,
      }),
    );
    handler.setLogger({ ...noopTrace });
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
