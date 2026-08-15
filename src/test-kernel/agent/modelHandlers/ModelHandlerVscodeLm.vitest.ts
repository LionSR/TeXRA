// Node imports
import { Buffer } from 'node:buffer';

// Third-party imports
import { MODEL_CONFIGS, ModelProvider, type ModelConfig } from 'llm-zoo';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import {
  foldSystemPromptIntoVscodeLmMessages,
  ModelHandlerVscodeLm,
} from '@agent/modelHandlers/vscodelm/modelHandlerVscodeLm';
import { OPENAI_CHAT_FINISH } from '@agent/types/StopReasonTypes';
import type { MediaEntry } from '@agent/types/mediaTypes';
import { detectPartialText } from '@common/errors/sdkError/errorMetadata';
import { isUserAbort } from '@common/errors/sdkError/errorPatterns';
import { normalizeProviderError } from '@common/errors/sdkError/providerErrorFormat';
import {
  invalidateRuntimeModelRegistry,
  refreshRuntimeModelRegistry,
} from '@model/runtimeModelRegistry';
import {
  LANGUAGE_MODEL_PORT_ERROR_CODE,
  LanguageModelPortError,
  type LanguageModelMessage,
  type LanguageModelPort,
  type LanguageModelPortErrorCode,
  type LanguageModelResponsePart,
} from '@platform/languageModel';
import { isCredentialExhausted, type FileLocation } from '@shared/schemas';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import { installPlatform } from '@test/support/setupPlatform';

function modelConfig(
  supportsFunctionCalling = true,
  supportsVision = true,
): ModelConfig {
  return buildTestModelConfig({
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
      supportsFunctionCalling,
      supportsVision,
      supportsNativeAudio: true,
    },
    openRouterOnly: false,
  });
}

const IMAGE_LOCATION: FileLocation = {
  kind: 'external',
  absolutePath: '/tmp/figure.png',
};
const AUDIO_LOCATION: FileLocation = {
  kind: 'external',
  absolutePath: '/tmp/recording.wav',
};

function mockMediaEntries(
  handler: ModelHandlerVscodeLm,
  entries: MediaEntry[],
) {
  const processor = (
    handler as unknown as {
      mediaProcessor: {
        loadEntries(
          mediaFiles: FileLocation[],
        ): Promise<{ entries: MediaEntry[]; results: [] }>;
      };
    }
  ).mediaProcessor;
  return vi
    .spyOn(processor, 'loadEntries')
    .mockResolvedValue({ entries, results: [] });
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

function portThrowing(
  code: LanguageModelPortErrorCode,
  message: string,
): ReturnType<typeof fakePort> {
  const port = fakePort();
  port.sendRequest.mockImplementation(() =>
    // The mock stream fails on first pull and never yields.
    // eslint-disable-next-line require-yield
    (async function* () {
      throw new LanguageModelPortError(code, message);
    })(),
  );
  return port;
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

  it('preserves image bytes across initial, round, and insertion paths', async () => {
    const handler = new ModelHandlerVscodeLm(modelConfig());
    const data = Buffer.from([1, 2, 3, 4]);
    const loadEntries = mockMediaEntries(handler, [
      {
        file_name: 'figure.png',
        data: data.toString('base64'),
        media_type: 'image/png',
        media_category: 'image',
      },
    ]);

    expect(handler.capabilities.supportsVision).toBe(true);
    expect(handler.capabilities.supportsNativeAudio).toBe(false);
    expect(handler.capabilities.supportsNativePdf).toBe(false);

    const initial = await handler.initializeMessages(
      'prefix',
      'request',
      [IMAGE_LOCATION],
      'system',
    );
    expect(initial).toEqual([
      {
        role: 'user',
        content: [
          { kind: 'text', text: 'system\n\nprefix\n\nrequest' },
          { kind: 'data', data, mimeType: 'image/png' },
        ],
      },
    ]);

    const rounds = await handler.createRoundMessages(initial, 'next question', [
      IMAGE_LOCATION,
    ]);
    expect(rounds.at(-1)).toEqual({
      role: 'user',
      content: [
        { kind: 'text', text: 'next question' },
        { kind: 'data', data, mimeType: 'image/png' },
      ],
    });

    const withTrailingAssistant: LanguageModelMessage[] = [
      ...rounds,
      { role: 'assistant', content: [{ kind: 'text', text: 'working' }] },
    ];
    await expect(
      handler.addMediaToUserMessage(withTrailingAssistant, [IMAGE_LOCATION]),
    ).resolves.toEqual(['image']);
    expect(withTrailingAssistant.at(-2)?.content.at(-1)).toEqual({
      kind: 'data',
      data,
      mimeType: 'image/png',
    });
    expect(loadEntries).toHaveBeenCalledTimes(3);
  });

  it('rejects media for non-vision models and rejects audio for vision models', async () => {
    const textOnlyHandler = new ModelHandlerVscodeLm(modelConfig(true, false));
    expect(textOnlyHandler.capabilities.supportsVision).toBe(false);

    await expect(
      textOnlyHandler.createRoundMessages([], 'question', [IMAGE_LOCATION]),
    ).rejects.toThrow('does not support image input');

    const visionHandler = new ModelHandlerVscodeLm(modelConfig());
    await expect(
      visionHandler.initializeMessages('', 'question', [AUDIO_LOCATION]),
    ).rejects.toThrow('audio and other native file inputs are not supported');
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
      finalTool: { name: 'search' },
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
    expect(handler.supportsForcedToolChoice).toBe(false);
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
    await expect(response).rejects.toSatisfy(isUserAbort);
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

    await expect(response).rejects.toSatisfy(
      (error) => detectPartialText(error) === 'partial answer',
    );
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
    const port = portThrowing(
      LANGUAGE_MODEL_PORT_ERROR_CODE.CANCELLED,
      'cancelled',
    );
    const handler = new ModelHandlerVscodeLm(modelConfig());

    const response = handler.createResponse({
      client: port,
      messages: [],
      temperature: 0,
    });

    await expect(response).rejects.toSatisfy(isUserAbort);
  });

  it('classifies Copilot quota exhaustion without automatic retry', async () => {
    const port = portThrowing(
      LANGUAGE_MODEL_PORT_ERROR_CODE.QUOTA_EXCEEDED,
      'Copilot quota exceeded',
    );
    const handler = new ModelHandlerVscodeLm(modelConfig());

    const response = handler.createResponse({
      client: port,
      messages: [],
      temperature: 0,
    });

    await expect(response).rejects.toSatisfy((error: unknown) => {
      const formatted = normalizeProviderError(error);
      expect(formatted).toMatchObject({
        provider: ModelProvider.COPILOT,
        statusCode: 429,
        exhaustionReason: 'copilot-subscription',
        userRetryable: true,
      });
      expect(isCredentialExhausted(formatted)).toBe(true);
      return true;
    });
  });
});

describe('ModelHandlerVscodeLm canonical route reference', () => {
  afterEach(() => {
    invalidateRuntimeModelRegistry();
  });

  it('sends requests to the exact discovered editor model reference', async () => {
    invalidateRuntimeModelRegistry();
    // The discovered editor model must track an active, Copilot-documented
    // llm-zoo base model (carries `copilotFullName`, neither deprecated nor
    // retired) — route resolution filters everything else. gemini31p
    // satisfies both in llm-zoo 1.28.0 (gemini36f, the previous pick, is deprecated there).
    await installPlatform(
      {},
      {
        languageModel: {
          ...fakePort(),
          selectModels: async () => [
            {
              id: 'gemini-3.1-pro-preview',
              name: 'Gemini 3.1 Pro',
              family: 'gemini-3.1-pro-preview',
              vendor: 'copilot',
              version: '2026-07',
              maxInputTokens: 160_000,
              access: 'allowed' as const,
            },
          ],
        },
      },
    );
    await refreshRuntimeModelRegistry();

    // #9635: the handler receives the canonical base model config; the exact
    // editor reference comes from the discovered Copilot route, not from an
    // overloaded config.fullName.
    const handler = new ModelHandlerVscodeLm(MODEL_CONFIGS.gemini31p);
    const port = fakePort([{ kind: 'text', text: 'answer' }]);

    await handler.createResponse({
      client: port,
      messages: [],
      temperature: 0,
    });

    expect(port.sendRequest).toHaveBeenCalledWith(
      { vendor: 'copilot', id: 'gemini-3.1-pro-preview' },
      expect.any(Array),
      expect.any(Object),
      expect.any(AbortSignal),
    );
  });
});
