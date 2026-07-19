// Standard library imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { createPartFromText, type Content } from '@google/genai';
import { describe, it } from 'vitest';
import { ModelProvider } from 'llm-zoo';

// Local imports - agent
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
import { noopTrace } from '@agent/trace/noopTrace';

// Local imports - test fixtures
import { buildTestModelConfig } from './testFixtures';

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

const CONTINUATION_CAPABILITIES = {
  supportsAssistantPrefill: false,
  supportsIntermDevMsgs: false,
  supportsReasoning: false,
  supportsVision: false,
};

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
    name: 'Google GenAI',
    run: () => {
      const handler = new ModelHandlerGoogleGenAI(
        buildTestModelConfig({
          provider: ModelProvider.GOOGLE,
          capabilities: CONTINUATION_CAPABILITIES,
        }),
      );
      handler.setLogger({ ...noopTrace });
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
];

describe('model handler continuation contract', () => {
  for (const testCase of cases) {
    it(`appends resumed text to the previous assistant turn for ${testCase.name}`, () => {
      testCase.run();
    });
  }

  it('keeps Google GenAI continuation prompts separate from trailing user turns', () => {
    const handler = new ModelHandlerGoogleGenAI(
      buildTestModelConfig({
        provider: ModelProvider.GOOGLE,
        capabilities: CONTINUATION_CAPABILITIES,
      }),
    );
    handler.setLogger({ ...noopTrace });
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
