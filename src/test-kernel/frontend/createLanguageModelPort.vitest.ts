// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LANGUAGE_MODEL_PORT_ERROR_CODE } from '@platform/languageModel';

class LanguageModelTextPart {
  constructor(public readonly value: string) {}
}

class LanguageModelToolCallPart {
  constructor(
    public readonly callId: string,
    public readonly name: string,
    public readonly input: object,
  ) {}
}

class LanguageModelToolResultPart {
  constructor(
    public readonly callId: string,
    public readonly content: unknown[],
  ) {}
}

class LanguageModelDataPart {
  static image(data: Uint8Array, mimeType: string) {
    return new LanguageModelDataPart(data, mimeType);
  }

  constructor(
    public readonly data: Uint8Array,
    public readonly mimeType: string,
  ) {}
}

class LanguageModelChatMessage {
  private constructor(
    public readonly role: 'user' | 'assistant',
    public readonly content: unknown[],
  ) {}

  static User(content: unknown[]) {
    return new LanguageModelChatMessage('user', content);
  }

  static Assistant(content: unknown[]) {
    return new LanguageModelChatMessage('assistant', content);
  }
}

const cancellationSources: CancellationTokenSource[] = [];

class CancellationTokenSource {
  readonly token = {};
  readonly cancel = vi.fn();
  readonly dispose = vi.fn();

  constructor() {
    cancellationSources.push(this);
  }
}

class CancellationError extends Error {}

function fakeModel(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'copilot-gpt-4o',
    name: 'GPT-4o',
    family: 'gpt-4o',
    vendor: 'copilot',
    version: '2026-07',
    maxInputTokens: 128_000,
    sendRequest: vi.fn(),
    countTokens: vi.fn(async () => 42),
    ...overrides,
  };
}

const mocks = vi.hoisted(() => ({
  selectChatModels: vi.fn(),
  onDidChangeChatModels: vi.fn(() => ({ dispose: vi.fn() })),
  canSendRequest: vi.fn(),
  onDidChangeAccess: vi.fn(() => ({ dispose: vi.fn() })),
  warn: vi.fn(),
}));

vi.mock('@logger/logUtils', () => ({ warn: mocks.warn }));

vi.mock('vscode', () => ({
  lm: {
    selectChatModels: mocks.selectChatModels,
    onDidChangeChatModels: mocks.onDidChangeChatModels,
  },
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
  LanguageModelDataPart,
  LanguageModelChatMessage,
  LanguageModelChatToolMode: { Auto: 1, Required: 2 },
  CancellationTokenSource,
  CancellationError,
}));

const { createLanguageModelPort } =
  await import('@frontend/lm/createLanguageModelPort');

function createPort(
  accessInformation: object = {
    canSendRequest: mocks.canSendRequest,
    onDidChange: mocks.onDidChangeAccess,
  },
) {
  return createLanguageModelPort({
    languageModelAccessInformation: accessInformation,
  } as unknown as Parameters<typeof createLanguageModelPort>[0]);
}

describe('createLanguageModelPort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cancellationSources.length = 0;
    mocks.canSendRequest.mockReturnValue(undefined);
  });

  it.each([
    [true, 'allowed'],
    [undefined, 'consent-required'],
    [false, 'unavailable'],
  ] as const)(
    'maps native access %s to %s on the discovered model',
    async (nativeAccess, access) => {
      mocks.canSendRequest.mockReturnValue(nativeAccess);
      mocks.selectChatModels.mockResolvedValue([fakeModel()]);
      const port = createPort();

      expect(port.isAvailable()).toBe(true);
      await expect(
        port.selectModels({ vendor: 'copilot', version: '2026-07' }),
      ).resolves.toEqual([
        {
          id: 'copilot-gpt-4o',
          name: 'GPT-4o',
          family: 'gpt-4o',
          vendor: 'copilot',
          version: '2026-07',
          maxInputTokens: 128_000,
          access,
        },
      ]);
      expect(mocks.selectChatModels).toHaveBeenCalledWith({
        vendor: 'copilot',
        version: '2026-07',
      });
      expect(mocks.canSendRequest).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'copilot-gpt-4o' }),
      );
    },
  );

  it('forwards native model and access change events', () => {
    const port = createPort();
    const listener = vi.fn();

    port.onDidChangeModels(listener);
    port.onDidChangeAccess(listener);

    expect(mocks.onDidChangeChatModels).toHaveBeenCalledWith(listener);
    expect(mocks.onDidChangeAccess).toHaveBeenCalledWith(listener);
  });

  it('resolves operations by vendor and model id', async () => {
    const model = fakeModel();
    mocks.selectChatModels.mockImplementation(async ({ id }) =>
      id === 'missing' ? [] : [model],
    );
    const port = createPort();

    const reference = { vendor: 'copilot', id: 'copilot-gpt-4o' };
    await expect(port.countTokens(reference, 'hello')).resolves.toBe(42);
    await expect(
      port.countTokens({ vendor: 'copilot', id: 'missing' }, 'hello'),
    ).rejects.toThrow('Language model "missing" is unavailable.');
    expect(model.countTokens).toHaveBeenCalledWith('hello', expect.anything());
    expect(mocks.selectChatModels).toHaveBeenCalledWith(reference);
  });

  it('does not select a model with the same id from another vendor', async () => {
    const otherVendor = fakeModel({
      vendor: 'other-provider',
      countTokens: vi.fn(async () => 99),
    });
    const copilot = fakeModel();
    mocks.selectChatModels.mockResolvedValue([otherVendor, copilot]);

    await expect(
      createPort().countTokens(
        { vendor: 'copilot', id: 'copilot-gpt-4o' },
        'hello',
      ),
    ).resolves.toBe(42);
    expect(otherVendor.countTokens).not.toHaveBeenCalled();
    expect(copilot.countTokens).toHaveBeenCalledOnce();
  });

  it('translates messages, tools, and streamed parts', async () => {
    const sendRequest = vi.fn(
      async (_messages: unknown[], _options: unknown, _token: unknown) => ({
        stream: (async function* () {
          yield new LanguageModelTextPart('hello');
          yield new LanguageModelToolCallPart('next', 'search', { query: 'x' });
          yield { unsupported: true };
        })(),
      }),
    );
    mocks.selectChatModels.mockResolvedValue([fakeModel({ sendRequest })]);
    const parts = [];

    for await (const part of createPort().sendRequest(
      { vendor: 'copilot', id: 'copilot-gpt-4o' },
      [
        {
          role: 'assistant',
          content: [
            { kind: 'text', text: 'prior' },
            {
              kind: 'toolCall',
              callId: 'call-1',
              name: 'search',
              input: { query: 'input' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              kind: 'data',
              data: new Uint8Array([1, 2, 3]),
              mimeType: 'image/png',
            },
            { kind: 'toolResult', callId: 'call-1', text: 'done' },
          ],
        },
      ],
      {
        justification: 'Run TeXRA',
        tools: [
          {
            name: 'search',
            description: 'Search sources',
            inputSchema: { type: 'object' },
          },
        ],
        toolMode: 'required',
      },
      new AbortController().signal,
    )) {
      parts.push(part);
    }

    expect(parts).toEqual([
      { kind: 'text', text: 'hello' },
      {
        kind: 'toolCall',
        callId: 'next',
        name: 'search',
        input: { query: 'x' },
      },
    ]);
    const call = sendRequest.mock.calls.at(0);
    if (!call) throw new Error('Expected the adapter to send one request.');
    const [messages, options] = call;
    expect(messages).toEqual([
      LanguageModelChatMessage.Assistant([
        new LanguageModelTextPart('prior'),
        new LanguageModelToolCallPart('call-1', 'search', { query: 'input' }),
      ]),
      LanguageModelChatMessage.User([
        LanguageModelDataPart.image(new Uint8Array([1, 2, 3]), 'image/png'),
        new LanguageModelToolResultPart('call-1', [
          new LanguageModelTextPart('done'),
        ]),
      ]),
    ]);
    expect(options).toEqual({
      justification: 'Run TeXRA',
      tools: [
        {
          name: 'search',
          description: 'Search sources',
          inputSchema: { type: 'object' },
        },
      ],
      toolMode: 2,
    });
  });

  it.each([
    ['before iteration', 'pre-abort'],
    ['during streaming', 'abort'],
    ['when the consumer stops', 'return'],
  ])('cancels %s', async (_case, mode) => {
    mocks.selectChatModels.mockResolvedValue([
      fakeModel({
        sendRequest: vi.fn(async () => ({
          stream: (async function* () {
            yield new LanguageModelTextPart('hello');
          })(),
        })),
      }),
    ]);
    const controller = new AbortController();
    if (mode === 'pre-abort') controller.abort();
    const stream = createPort().sendRequest(
      { vendor: 'copilot', id: 'copilot-gpt-4o' },
      [],
      {},
      controller.signal,
    );
    const iterator = stream[Symbol.asyncIterator]();

    if (mode === 'pre-abort') {
      await expect(iterator.next()).rejects.toMatchObject({
        code: LANGUAGE_MODEL_PORT_ERROR_CODE.CANCELLED,
        message: 'Language model "copilot-gpt-4o" request was cancelled.',
      });
      expect(cancellationSources[0]?.cancel).toHaveBeenCalledOnce();
      return;
    }

    await iterator.next();
    if (mode === 'abort') controller.abort();
    if (mode === 'return') await iterator.return?.();

    expect(cancellationSources[0]?.cancel).toHaveBeenCalledOnce();
    if (mode !== 'return') await iterator.return?.();
  });

  it('logs discovery failures at the VS Code language-model adapter boundary', async () => {
    const nativeError = new Error('discovery failed');
    mocks.selectChatModels.mockRejectedValue(nativeError);

    await expect(
      createPort().selectModels({ vendor: 'copilot' }),
    ).rejects.toMatchObject({
      name: 'LanguageModelPortError',
      code: LANGUAGE_MODEL_PORT_ERROR_CODE.UNKNOWN,
      cause: nativeError,
    });
    expect(mocks.warn).toHaveBeenCalledWith(
      'LanguageModelPort',
      'Could not discover editor-supplied language models.',
      {
        data: expect.objectContaining({
          name: 'LanguageModelPortError',
          code: LANGUAGE_MODEL_PORT_ERROR_CODE.UNKNOWN,
        }),
      },
    );
  });

  it.each([
    ['NoPermissions', LANGUAGE_MODEL_PORT_ERROR_CODE.NO_PERMISSIONS],
    ['Blocked', LANGUAGE_MODEL_PORT_ERROR_CODE.QUOTA_EXCEEDED],
    ['NotFound', LANGUAGE_MODEL_PORT_ERROR_CODE.MODEL_UNAVAILABLE],
    ['Unknown', LANGUAGE_MODEL_PORT_ERROR_CODE.UNKNOWN],
  ])('translates VS Code %s errors', async (nativeCode, expectedCode) => {
    const nativeError = Object.assign(new Error('native failure'), {
      code: nativeCode,
    });
    mocks.selectChatModels.mockResolvedValue([
      fakeModel({
        sendRequest: vi.fn(async () => Promise.reject(nativeError)),
      }),
    ]);

    const consume = async () => {
      for await (const _part of createPort().sendRequest(
        { vendor: 'copilot', id: 'copilot-gpt-4o' },
        [],
        {},
        new AbortController().signal,
      )) {
        // The request rejects before producing a part.
      }
    };

    await expect(consume()).rejects.toMatchObject({
      name: 'LanguageModelPortError',
      code: expectedCode,
      cause: nativeError,
    });
  });

  it('reports cancellation when VS Code closes the stream normally', async () => {
    const controller = new AbortController();
    mocks.selectChatModels.mockResolvedValue([
      fakeModel({
        sendRequest: vi.fn(async () => ({
          stream: (async function* () {
            yield new LanguageModelTextPart('partial');
            controller.abort();
          })(),
        })),
      }),
    ]);
    const stream = createPort().sendRequest(
      { vendor: 'copilot', id: 'copilot-gpt-4o' },
      [],
      {},
      controller.signal,
    );
    const iterator = stream[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: { kind: 'text', text: 'partial' },
    });
    await expect(iterator.next()).rejects.toMatchObject({
      code: LANGUAGE_MODEL_PORT_ERROR_CODE.CANCELLED,
    });
  });
});
