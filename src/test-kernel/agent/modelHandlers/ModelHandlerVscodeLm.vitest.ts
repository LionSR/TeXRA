// Third-party imports
import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelProvider,
  type ModelConfig,
} from 'llm-zoo';
import { describe, expect, it, vi } from 'vitest';

// Local imports - platform and agent
import {
  LANGUAGE_MODEL_PORT_ERROR_CODE,
  LanguageModelPortError,
  type LanguageModelMessage,
  type LanguageModelPort,
  type LanguageModelResponsePart,
} from '@platform/languageModel';
import {
  foldSystemPromptIntoVscodeLmMessages,
  ModelHandlerVscodeLm,
} from '@agent/modelHandlers/vscodelm/modelHandlerVscodeLm';
import { OPENAI_CHAT_FINISH } from '@agent/types/StopReasonTypes';
import {
  detectPartialText,
  isUserAbort,
  normalizeProviderError,
  requiresFlowAutoRetry,
} from '@common/errors/sdkErrorUtils';
import { isCredentialExhausted, type FileLocation } from '@shared/schemas';

function modelConfig(supportsFunctionCalling = true): ModelConfig {
  return {
    name: 'copilot-test',
    label: 'Copilot Test',
    fullName: 'copilot-model-id',
    shortName: 'copilot-model-id',
    provider: ModelProvider.COPILOT,
    maxOutputTokens: 4096,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 128_000,
    capabilities: {
      ...DEFAULT_MODEL_CAPABILITIES,
      supportsFunctionCalling,
      supportsVision: true,
      supportsNativeAudio: true,
    },
    openRouterOnly: false,
  };
}

function fakePort(
  parts: readonly LanguageModelResponsePart[] = [],
): LanguageModelPort & {
  sendRequest: ReturnType<typeof vi.fn>;
  countTokens: ReturnType<typeof vi.fn>;
} {
  const sendRequest = vi.fn(() =>
    (async function* () {
      for (const part of parts) yield part;
    })(),
  );
  const countTokens = vi.fn(async () => 7);
  return {
    isAvailable: () => true,
    selectModels: async () => [],
    onDidChangeModels: () => ({ dispose() {} }),
    sendRequest,
    countTokens,
    onDidChangeAccess: () => ({ dispose() {} }),
  };
}

describe('ModelHandlerVscodeLm messages', () => {
  it('folds the system prompt into the first user turn', async () => {
    const handler = new ModelHandlerVscodeLm(modelConfig());

    await expect(
      handler.initializeMessages('prefix', 'request', undefined, 'system'),
    ).resolves.toEqual([
      {
        role: 'user',
        content: [{ kind: 'text', text: 'system\n\nprefix\n\nrequest' }],
      },
    ]);
    expect(handler.requiresPerCallSystemPrompt).toBe(false);

    expect(
      foldSystemPromptIntoVscodeLmMessages(
        [
          { role: 'assistant', content: [{ kind: 'text', text: 'prior' }] },
          { role: 'user', content: [{ kind: 'text', text: 'question' }] },
        ],
        'rules',
      ),
    ).toEqual([
      { role: 'assistant', content: [{ kind: 'text', text: 'prior' }] },
      {
        role: 'user',
        content: [{ kind: 'text', text: 'rules\n\nquestion' }],
      },
    ]);
  });

  it('rejects image, PDF, and audio attachment input', async () => {
    const handler = new ModelHandlerVscodeLm(modelConfig());
    expect(handler.capabilities.supportsVision).toBe(false);
    expect(handler.capabilities.supportsNativeAudio).toBe(false);

    await expect(
      handler.createRoundMessages([], 'question', [
        'figure.png' as unknown as FileLocation,
      ]),
    ).rejects.toThrow('text input only');
  });

  it('does not insert empty text before a tool result', () => {
    const handler = new ModelHandlerVscodeLm(modelConfig());
    const messages: LanguageModelMessage[] = [
      {
        role: 'user',
        content: [{ kind: 'toolResult', callId: 'call-1', text: 'done' }],
      },
    ];

    handler.prependTextToUserMessage(messages, '  ');

    expect(messages).toEqual([
      {
        role: 'user',
        content: [{ kind: 'toolResult', callId: 'call-1', text: 'done' }],
      },
    ]);
  });
});

describe('ModelHandlerVscodeLm streaming and tools', () => {
  it('preserves streamed text and complete parallel tool calls', async () => {
    const port = fakePort([
      { kind: 'text', text: 'I will ' },
      { kind: 'text', text: 'check.' },
      {
        kind: 'toolCall',
        callId: 'call-1',
        name: 'search',
        input: { query: 'alpha' },
      },
      {
        kind: 'toolCall',
        callId: 'call-2',
        name: 'fetch',
        input: { url: 'https://example.com' },
      },
    ]);
    const handler = new ModelHandlerVscodeLm(modelConfig());
    const messages = await handler.initializeMessages(
      '',
      'question',
      undefined,
      'rules',
    );

    const { response } = await handler.createResponse({
      client: port,
      messages,
      temperature: 0,
      // Reflection supplies this on every call. Embedded-prompt handlers must
      // ignore it because initializeMessages already persisted the prompt.
      systemPrompt: 'rules',
      tools: [
        {
          name: 'search',
          description: 'Search sources',
          parameters: { type: 'object', properties: {} },
        },
      ],
    });

    expect(response).toMatchObject({
      text: 'I will check.',
      usage: undefined,
      stopReason: OPENAI_CHAT_FINISH.TOOL_CALLS,
      toolCalls: [
        { callId: 'call-1', name: 'search', input: { query: 'alpha' } },
        {
          callId: 'call-2',
          name: 'fetch',
          input: { url: 'https://example.com' },
        },
      ],
    });
    expect(handler.extractToolUse(response)).toMatchObject([
      {
        provider: 'vscode-lm',
        callId: 'call-1',
        input: { query: 'alpha' },
      },
      {
        provider: 'vscode-lm',
        callId: 'call-2',
        input: { url: 'https://example.com' },
      },
    ]);
    expect(port.sendRequest).toHaveBeenCalledWith(
      { vendor: ModelProvider.COPILOT, id: 'copilot-model-id' },
      [
        {
          role: 'user',
          content: [{ kind: 'text', text: 'rules\n\nquestion' }],
        },
      ],
      {
        justification: 'Run the selected TeXRA agent.',
        tools: [
          {
            name: 'search',
            description: 'Search sources',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
        toolMode: 'auto',
      },
      expect.any(AbortSignal),
    );
  });

  it('does not advertise tools when function calling is unsupported', async () => {
    const port = fakePort([{ kind: 'text', text: 'answer' }]);
    const handler = new ModelHandlerVscodeLm(modelConfig(false));

    const { response } = await handler.createResponse({
      client: port,
      messages: [],
      temperature: 0,
      tools: [{ name: 'search', description: 'Search' }],
    });

    expect(response.stopReason).toBe(OPENAI_CHAT_FINISH.STOP);
    expect(port.sendRequest.mock.calls[0]?.[2]).toEqual({
      justification: 'Run the selected TeXRA agent.',
    });
  });

  it('round-trips parallel tool calls and results in one message pair', async () => {
    const handler = new ModelHandlerVscodeLm(modelConfig());
    const calls = handler.extractToolUse({
      text: '',
      usage: undefined,
      stopReason: OPENAI_CHAT_FINISH.TOOL_CALLS,
      toolCalls: [
        {
          kind: 'toolCall',
          callId: 'call-1',
          name: 'search',
          input: { q: 'x' },
        },
        {
          kind: 'toolCall',
          callId: 'call-2',
          name: 'fetch',
          input: { u: 'y' },
        },
      ],
    });

    const followUp = await handler.createBatchedToolUseFollowUpMessages!(
      [
        {
          call: calls[0],
          result: { status: 'executed', output: 'first' },
          attachments: [],
        },
        {
          call: calls[1],
          result: { status: 'executed', output: 'second' },
          attachments: [],
        },
      ],
      undefined,
      'checking',
    );

    expect(handler.requiresBatchedParallelToolResults).toBe(true);
    expect(followUp).toEqual([
      {
        role: 'assistant',
        content: [
          { kind: 'text', text: 'checking' },
          {
            kind: 'toolCall',
            callId: 'call-1',
            name: 'search',
            input: { q: 'x' },
          },
          {
            kind: 'toolCall',
            callId: 'call-2',
            name: 'fetch',
            input: { u: 'y' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          { kind: 'toolResult', callId: 'call-1', text: 'first' },
          { kind: 'toolResult', callId: 'call-2', text: 'second' },
        ],
      },
    ]);
  });

  it('reports cancellation even when the stream closes normally', async () => {
    const controller = new AbortController();
    const port = fakePort();
    port.sendRequest.mockImplementation(() =>
      (async function* () {
        yield { kind: 'text' as const, text: 'partial' };
        controller.abort();
      })(),
    );
    const handler = new ModelHandlerVscodeLm(modelConfig());

    const response = handler.createResponse({
      client: port,
      messages: [],
      temperature: 0,
      signal: controller.signal,
    });

    await expect(response).rejects.toMatchObject({
      code: LANGUAGE_MODEL_PORT_ERROR_CODE.CANCELLED,
    });
    await response.catch((error: unknown) =>
      expect(isUserAbort(error)).toBe(true),
    );
  });

  it('preserves partial text when the provider stream fails', async () => {
    const port = fakePort();
    port.sendRequest.mockImplementation(() =>
      (async function* () {
        yield { kind: 'text' as const, text: 'partial answer' };
        throw new LanguageModelPortError(
          LANGUAGE_MODEL_PORT_ERROR_CODE.UNKNOWN,
          'stream failed',
        );
      })(),
    );
    const handler = new ModelHandlerVscodeLm(modelConfig());

    const response = handler.createResponse({
      client: port,
      messages: [],
      temperature: 0,
    });

    await response.catch((error: unknown) => {
      expect(detectPartialText(error)).toBe('partial answer');
      expect(requiresFlowAutoRetry(error)).toBe(true);
    });
  });

  it('counts messages through the host port without treating text as usage', async () => {
    const port = fakePort();
    port.countTokens.mockResolvedValueOnce(3).mockResolvedValueOnce(5);
    const handler = new ModelHandlerVscodeLm(modelConfig());

    await expect(
      handler.estimateTokenCount(
        [{ role: 'user', content: [{ kind: 'text', text: 'question' }] }],
        { client: port, systemPrompt: 'rules', tools: [{ name: 'search' }] },
      ),
    ).resolves.toBe(8);
    expect(port.countTokens).toHaveBeenCalledTimes(2);
    expect(handler.normalizeUsage(undefined, 100)).toBeUndefined();
  });
});

describe('ModelHandlerVscodeLm port errors', () => {
  it('tags coded cancellation errors as user aborts', async () => {
    const port = fakePort();
    port.sendRequest.mockImplementation(() => ({
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            throw new LanguageModelPortError(
              LANGUAGE_MODEL_PORT_ERROR_CODE.CANCELLED,
              'cancelled',
            );
          },
        };
      },
    }));
    const handler = new ModelHandlerVscodeLm(modelConfig());

    const response = handler.createResponse({
      client: port,
      messages: [],
      temperature: 0,
    });

    await response.catch((error: unknown) =>
      expect(isUserAbort(error)).toBe(true),
    );
  });

  it('classifies Copilot quota exhaustion without automatic retry', async () => {
    const port = fakePort();
    port.sendRequest.mockImplementation(() => ({
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            throw new LanguageModelPortError(
              LANGUAGE_MODEL_PORT_ERROR_CODE.QUOTA_EXCEEDED,
              'Copilot quota exceeded',
            );
          },
        };
      },
    }));
    const handler = new ModelHandlerVscodeLm(modelConfig());

    const response = handler.createResponse({
      client: port,
      messages: [],
      temperature: 0,
    });

    await response.catch((error: unknown) => {
      const formatted = normalizeProviderError(error);
      expect(formatted).toMatchObject({
        provider: ModelProvider.COPILOT,
        statusCode: 429,
        exhaustionReason: 'copilot-subscription',
        userRetryable: true,
      });
      expect(isCredentialExhausted(formatted)).toBe(true);
    });
  });
});
