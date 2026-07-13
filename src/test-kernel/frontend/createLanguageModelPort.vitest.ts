import { beforeEach, describe, expect, it, vi } from 'vitest';

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
}));

vi.mock('vscode', () => ({
  lm: {
    selectChatModels: mocks.selectChatModels,
    onDidChangeChatModels: mocks.onDidChangeChatModels,
  },
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
  LanguageModelChatMessage,
  LanguageModelChatToolMode: { Auto: 1, Required: 2 },
  CancellationTokenSource,
}));

const { createLanguageModelPort } =
  await import('@frontend/lm/createLanguageModelPort');

function createPort() {
  return createLanguageModelPort({
    languageModelAccessInformation: {
      canSendRequest: mocks.canSendRequest,
      onDidChange: mocks.onDidChangeAccess,
    },
  } as unknown as Parameters<typeof createLanguageModelPort>[0]);
}

describe('createLanguageModelPort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cancellationSources.length = 0;
  });

  it('maps model descriptors and forwards selectors', async () => {
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
      },
    ]);
    expect(mocks.selectChatModels).toHaveBeenCalledWith({
      vendor: 'copilot',
      version: '2026-07',
    });
  });

  it('resolves operations directly by model id', async () => {
    const model = fakeModel();
    mocks.selectChatModels.mockImplementation(async ({ id }) =>
      id === 'missing' ? [] : [model],
    );
    mocks.canSendRequest.mockReturnValue(true);
    const port = createPort();

    await expect(port.countTokens('copilot-gpt-4o', 'hello')).resolves.toBe(42);
    await expect(port.canSendRequest('copilot-gpt-4o')).resolves.toBe(true);
    await expect(port.countTokens('missing', 'hello')).rejects.toThrow(
      'Language model "missing" is unavailable.',
    );
    expect(model.countTokens).toHaveBeenCalledWith('hello');
    expect(mocks.canSendRequest).toHaveBeenCalledWith(model);
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
      'copilot-gpt-4o',
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
          content: [{ kind: 'toolResult', callId: 'call-1', text: 'done' }],
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
    ['before iteration', true],
    ['during streaming', false],
  ])('cancels %s when the AbortSignal fires', async (_case, preAborted) => {
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
    if (preAborted) controller.abort();
    const stream = createPort().sendRequest(
      'copilot-gpt-4o',
      [],
      {},
      controller.signal,
    );
    const iterator = stream[Symbol.asyncIterator]();

    await iterator.next();
    if (!preAborted) controller.abort();

    expect(cancellationSources[0]?.cancel).toHaveBeenCalledOnce();
    await iterator.return?.();
  });
});
