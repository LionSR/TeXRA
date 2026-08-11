// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';
import { ModelProvider } from 'llm-zoo';

// Local imports
import { noopTrace, type AgentTrace } from '@agent/trace';
import {
  AgentSettingSchema,
  type AgentSetting,
} from '@agent/core/definition/AgentDataclass';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { ModelHandlerAnthropic } from '@agent/modelHandlers/anthropic/modelHandlerAnthropic';
import { ModelHandlerGoogleInteractions } from '@agent/modelHandlers/google/modelHandlerGoogleInteractions';
import { ModelHandlerOpenAI } from '@agent/modelHandlers/openai/modelHandlerOpenAI';
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/openai/modelHandlerOpenAIResponse';
import { ModelHandlerOpenRouterNative } from '@agent/modelHandlers/openrouter/modelHandlerOpenRouterNative';
import { ModelHandlerVscodeLm } from '@agent/modelHandlers/vscodelm/modelHandlerVscodeLm';
import type { LanguageModelMessage } from '@platform/languageModel';
import { AgentCategory } from '@shared/schemas';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';

// Provider SDK message types
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { ChatMessages } from '@openrouter/sdk/models';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ResponseInputItem } from 'openai/resources/responses/responses';
import type { Interactions } from '@google/genai';

type ContinuationCase = {
  name: string;
  run: () => void;
};

/** The continuation-flow surface of ModelHandler exercised by this contract. */
interface ContinuationHandler<M> {
  setLogger(logger: AgentTrace): void;
  createAssistantMessage(text: string): M;
  addContinueMessage(
    messages: M[],
    workspaceState: AgentWorkspaceState,
    agentSetting: AgentSetting,
  ): void;
  updateMessageContent(
    messages: M[],
    bestConnector: string,
    newResponse: string,
    workspaceState: AgentWorkspaceState,
  ): void;
}

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

/**
 * Runs the shared continuation flow: seed one assistant turn, append the
 * continuation prompt, land the resumed delta, then assert the prompt is gone
 * and the last turn carries the merged text.
 */
function exerciseContinuation<M>(options: {
  handler: ContinuationHandler<M>;
  extractText: (message: M) => string;
  expectedFinalText?: string;
  assertLastTurn?: (message: M) => void;
  afterAddContinue?: (messages: M[]) => void;
}): void {
  const {
    handler,
    extractText,
    expectedFinalText = 'partial resumed',
    assertLastTurn,
    afterAddContinue,
  } = options;
  handler.setLogger({ ...noopTrace });
  const messages: M[] = [handler.createAssistantMessage('partial')];
  const workspaceState = createWorkspaceState();

  handler.addContinueMessage(messages, workspaceState, agentSetting);
  afterAddContinue?.(messages);
  handler.updateMessageContent(messages, '', ' resumed', workspaceState);

  assertSingleAssistantTurn(messages);
  assertLastTurn?.(messages.at(-1)!);
  assert.equal(extractText(messages.at(-1)!), expectedFinalText);
}

const cases: ContinuationCase[] = [
  {
    name: 'OpenAI chat',
    run: () =>
      exerciseContinuation<ChatCompletionMessageParam>({
        handler: new ModelHandlerOpenAI(
          buildTestModelConfig({
            provider: ModelProvider.OPENAI,
            capabilities: CONTINUATION_CAPABILITIES,
          }),
        ),
        extractText: (message) => textFromOpenAiContent(message.content),
        assertLastTurn: (message) => assert.equal(message.role, 'assistant'),
      }),
  },
  {
    name: 'OpenAI Responses',
    run: () =>
      exerciseContinuation<ResponseInputItem>({
        handler: new ModelHandlerOpenAIResponse(
          buildTestModelConfig({
            provider: ModelProvider.OPENAI,
            capabilities: CONTINUATION_CAPABILITIES,
          }),
        ),
        extractText: textFromResponseContent,
      }),
  },
  {
    name: 'Anthropic',
    run: () =>
      exerciseContinuation<MessageParam>({
        handler: new ModelHandlerAnthropic(
          buildTestModelConfig({
            provider: ModelProvider.ANTHROPIC,
            capabilities: CONTINUATION_CAPABILITIES,
          }),
        ),
        extractText: textFromAnthropicContent,
        assertLastTurn: (message) => assert.equal(message.role, 'assistant'),
      }),
  },
  {
    name: 'Google Interactions',
    run: () =>
      exerciseContinuation<Interactions.Step>({
        handler: new ModelHandlerGoogleInteractions(
          buildTestModelConfig({
            provider: ModelProvider.GOOGLE,
            capabilities: CONTINUATION_CAPABILITIES,
          }),
        ),
        extractText: textFromInteractionStep,
        assertLastTurn: (step) => assert.equal(step.type, 'model_output'),
      }),
  },
  {
    name: 'OpenRouter native',
    run: () =>
      exerciseContinuation<ChatMessages>({
        handler: new ModelHandlerOpenRouterNative(
          buildTestModelConfig({
            provider: ModelProvider.OPENAI,
            capabilities: CONTINUATION_CAPABILITIES,
            openrouterFullName: 'openai/test-model',
          }),
        ),
        extractText: (message) =>
          textFromOpenAiContent(
            message.content as ChatCompletionMessageParam['content'],
          ),
        assertLastTurn: (message) => assert.equal(message.role, 'assistant'),
      }),
  },
  {
    name: 'VS Code LM',
    run: () =>
      exerciseContinuation<LanguageModelMessage>({
        handler: new ModelHandlerVscodeLm(
          buildTestModelConfig({
            provider: ModelProvider.COPILOT,
            capabilities: CONTINUATION_CAPABILITIES,
          }),
        ),
        extractText: textFromVscodeLmMessage,
        expectedFinalText: 'partial\n\n resumed',
        afterAddContinue: (messages) => {
          assert.equal(messages.length, 2);
          assert.equal(messages.at(-1)?.role, 'user');
          assert.match(
            textFromVscodeLmMessage(messages.at(-1)!),
            /continue responding exactly from where you left/i,
          );
        },
        assertLastTurn: (message) => assert.equal(message.role, 'assistant'),
      }),
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

    // For handlers with intermediate system messages, the continuation prompt
    // is a separate system turn that must survive the resumed response: the
    // assistant turn absorbs the new text and the continuation message object
    // is left untouched.
    function assertSystemContinuationPreserved<M>(options: {
      handler: ContinuationHandler<M>;
      extractText: (message: M) => string;
      continuationShape: (text: string) => unknown;
    }): void {
      const { handler, extractText, continuationShape } = options;
      handler.setLogger({ ...noopTrace });
      const messages: M[] = [handler.createAssistantMessage('partial')];
      const workspaceState = createWorkspaceState();

      handler.addContinueMessage(messages, workspaceState, agentSetting);

      const continuation = messages.at(-1)!;
      assert.equal(messages.length, 2);
      const continuationText = extractText(continuation);
      assert.match(
        continuationText,
        /continue responding exactly from where you left/i,
      );
      assert.deepEqual(continuation, continuationShape(continuationText));

      handler.updateMessageContent(messages, '', ' resumed', workspaceState);

      assert.equal(messages.length, 2);
      assert.equal(extractText(messages[0]!), 'partial resumed');
      assert.equal(messages.at(-1), continuation);
    }

    assertSystemContinuationPreserved<ChatCompletionMessageParam>({
      handler: new ModelHandlerOpenAI(
        buildTestModelConfig({
          provider: ModelProvider.OPENAI,
          capabilities,
        }),
      ),
      extractText: (message) => textFromOpenAiContent(message.content),
      continuationShape: (text) => ({
        role: 'system',
        content: [{ type: 'text', text }],
      }),
    });

    assertSystemContinuationPreserved<ResponseInputItem>({
      handler: new ModelHandlerOpenAIResponse(
        buildTestModelConfig({
          provider: ModelProvider.OPENAI,
          capabilities,
        }),
      ),
      extractText: textFromResponseContent,
      continuationShape: (text) => ({
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text }],
      }),
    });

    assertSystemContinuationPreserved<ChatMessages>({
      handler: new ModelHandlerOpenRouterNative(
        buildTestModelConfig({
          provider: ModelProvider.OPENAI,
          capabilities,
          openrouterFullName: 'openai/test-model',
        }),
      ),
      extractText: (message) =>
        textFromOpenAiContent(
          message.content as ChatCompletionMessageParam['content'],
        ),
      continuationShape: (text) => ({
        role: 'system',
        content: [{ type: 'text', text }],
      }),
    });
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
