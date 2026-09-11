// Third-party imports
import { it as effectIt } from '@effect/vitest';
import { Cause, Effect, Exit, Fiber, Scope, Stream } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LANGUAGE_MODEL_PORT_ERROR_CODE } from '@platform/languageModel';

import type {
  TurnRequest,
  VscodeLanguageModelConfiguration,
} from '@texra-ai/llm/turn';

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
  readonly listeners = new Set<() => void>();
  readonly token = {
    isCancellationRequested: false,
    onCancellationRequested: (listener: () => void) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    },
  };
  readonly cancel = vi.fn(() => {
    this.token.isCancellationRequested = true;
    for (const listener of this.listeners) listener();
  });
  readonly dispose = vi.fn(() => this.listeners.clear());

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
  LanguageModelChatMessageRole: { User: 'user', Assistant: 'assistant' },
  LanguageModelChatToolMode: { Auto: 1, Required: 2 },
  CancellationTokenSource,
  CancellationError,
}));

const { createLanguageModelPort } =
  await import('@frontend/lm/createLanguageModelPort');
const { acquireVscodeLanguageModel } =
  await import('@frontend/lm/acquireVscodeLanguageModel');

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
        maxTokens: 128,
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
      modelOptions: { max_tokens: 128 },
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

function nativeConfiguration(): VscodeLanguageModelConfiguration {
  return {
    protocol: 'vscode-lm',
    requestedModel: 'copilot-gpt-4o',
    deployment: { vendor: 'copilot', version: '2026-07' },
    supportsImageInput: true,
    supportsToolCalling: true,
    defaults: { justification: 'Run the selected TeXRA agent.' },
  };
}

function nativeResponse(parts: readonly unknown[]) {
  return {
    stream: (async function* () {
      yield* parts;
    })(),
  };
}

const nativeContext = {
  languageModelAccessInformation: {
    canSendRequest: mocks.canSendRequest,
    onDidChange: mocks.onDidChangeAccess,
  },
} as unknown as Parameters<typeof acquireVscodeLanguageModel>[0];

const nativeRequest: TurnRequest = {
  messages: [{ role: 'user', content: [{ kind: 'text', text: 'question' }] }],
};

describe('native editor model', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cancellationSources.length = 0;
    mocks.canSendRequest.mockReturnValue(true);
  });

  effectIt.effect(
    'captures the exact model and preserves ordered text, images and complete tool exchanges without invented metadata',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const sendRequest = vi
            .fn()
            .mockResolvedValueOnce(
              nativeResponse([
                new LanguageModelTextPart(''),
                new LanguageModelTextPart('be'),
                new LanguageModelTextPart('fore'),
                new LanguageModelToolCallPart('original-0', 'search', {
                  q: 'a',
                }),
                new LanguageModelTextPart('between'),
                new LanguageModelToolCallPart('original-1', 'search', {
                  q: 'b',
                }),
                new LanguageModelTextPart('af'),
                new LanguageModelTextPart('ter'),
              ]),
            )
            .mockResolvedValueOnce(
              nativeResponse([new LanguageModelTextPart('done')]),
            );
          const selected = fakeModel({ sendRequest });
          mocks.selectChatModels.mockResolvedValue([
            fakeModel({ vendor: 'other' }),
            selected,
          ]);
          const model = yield* acquireVscodeLanguageModel(
            nativeContext,
            nativeConfiguration(),
          );
          const prepared = yield* model.prepareTurn({
            ...nativeRequest,
            system: 'rules',
            messages: [
              {
                role: 'user',
                content: [
                  { kind: 'text', text: 'question' },
                  { kind: 'text', text: 'Image: exact.png' },
                  { kind: 'image', mimeType: 'image/PNG', base64: 'AAE=' },
                  { kind: 'image', mimeType: 'image/png', base64: '' },
                ],
              },
            ],
            tools: [
              {
                name: 'search',
                description: 'Search',
                parameters: { type: 'object' },
              },
            ],
          });
          if (prepared.mode !== 'foreground')
            throw new Error('Expected foreground input.');
          mocks.selectChatModels.mockResolvedValue([
            fakeModel({ version: 'replacement' }),
          ]);
          const events = yield* Stream.runCollect(model.streamTurn(prepared));
          expect(events.some((event) => event.kind === 'identified')).toBe(
            false,
          );
          expect(
            events
              .filter((event) => event.kind === 'delta')
              .map((event) => event.text)
              .join(''),
          ).toBe('beforebetweenafter');
          const terminal = events.find((event) => event.kind === 'completed');
          if (terminal?.kind !== 'completed')
            throw new Error('Expected completed response.');
          expect(terminal.result).toMatchObject({
            providerResponseId: null,
            returnedModel: null,
            modelFingerprint: null,
            finishReason: null,
            usage: null,
            requestedOrigin: {
              protocol: 'vscode-lm',
              requestedModel: 'copilot-gpt-4o',
              deployment: { vendor: 'copilot', version: '2026-07' },
            },
          });
          expect(terminal.result.content.map((part) => part.kind)).toEqual([
            'message',
            'local-call',
            'message',
            'local-call',
            'message',
          ]);
          const followUp = yield* model.prepareTurn({
            messages: [
              ...nativeRequest.messages,
              {
                role: 'assistant',
                origin: terminal.result.requestedOrigin,
                content: terminal.result.content,
              },
              {
                role: 'tool',
                results: [
                  {
                    callOrdinal: 0,
                    status: 'success',
                    content: [{ kind: 'text', text: 'a' }],
                  },
                  {
                    callOrdinal: 1,
                    status: 'error',
                    content: [{ kind: 'text', text: 'failed' }],
                  },
                ],
              },
            ],
          });
          if (followUp.mode !== 'foreground')
            throw new Error('Expected foreground input.');
          expect((yield* model.generateTurn(followUp)).finishReason).toBeNull();
          expect(mocks.selectChatModels).toHaveBeenCalledOnce();
          expect(mocks.selectChatModels).toHaveBeenCalledWith({
            vendor: 'copilot',
            id: 'copilot-gpt-4o',
            version: '2026-07',
          });
          expect(mocks.canSendRequest).toHaveBeenCalledWith(selected);
          const [messages, options] = sendRequest.mock.calls[0];
          expect(
            messages[0].content.map((part: unknown) =>
              part instanceof LanguageModelDataPart
                ? { data: [...part.data], mimeType: part.mimeType }
                : part,
            ),
          ).toEqual([
            new LanguageModelTextPart('rules\n\nquestion'),
            new LanguageModelTextPart('Image: exact.png'),
            { data: [0, 1], mimeType: 'image/PNG' },
            { data: [], mimeType: 'image/png' },
          ]);
          expect(options).toEqual({
            justification: 'Run the selected TeXRA agent.',
            toolMode: 1,
            tools: [
              {
                name: 'search',
                description: 'Search',
                inputSchema: { type: 'object' },
              },
            ],
          });
          expect(sendRequest.mock.calls[1][0][1].content).toEqual([
            new LanguageModelTextPart('before'),
            new LanguageModelToolCallPart('original-0', 'search', { q: 'a' }),
            new LanguageModelTextPart('between'),
            new LanguageModelToolCallPart('original-1', 'search', { q: 'b' }),
            new LanguageModelTextPart('after'),
          ]);
          expect(sendRequest.mock.calls[1][0][2].content).toEqual([
            new LanguageModelToolResultPart('original-0', [
              new LanguageModelTextPart('a'),
            ]),
            new LanguageModelToolResultPart('original-1', [
              new LanguageModelTextPart('Error: failed'),
            ]),
          ]);
          expect(sendRequest).toHaveBeenCalledTimes(2);
          expect(
            cancellationSources.every(
              (source) =>
                source.cancel.mock.calls.length === 1 &&
                source.dispose.mock.calls.length === 1,
            ),
          ).toBe(true);
        }),
      ),
  );

  effectIt.effect.each([
    [false, false, 'require-granted', false],
    [false, false, 'request-on-send', false],
    [undefined, undefined, 'require-granted', false],
    [undefined, undefined, 'request-on-send', true],
    [true, false, 'require-granted', false],
    [true, false, 'request-on-send', false],
    [true, undefined, 'require-granted', false],
    [true, undefined, 'request-on-send', true],
  ] as const)(
    'requires explicit consent authority for access %s then %s and mode %s',
    ([initialAccess, sendAccess, mode, permitted]) =>
      Effect.gen(function* () {
        mocks.canSendRequest.mockReturnValue(initialAccess);
        const selected = fakeModel({
          sendRequest: vi.fn(async () => nativeResponse([])),
        });
        mocks.selectChatModels.mockResolvedValue([selected]);
        const exit = yield* Effect.exit(
          Effect.scoped(
            Effect.gen(function* () {
              const model = yield* acquireVscodeLanguageModel(
                nativeContext,
                nativeConfiguration(),
                mode,
              );
              const turn = yield* model.prepareTurn(nativeRequest);
              if (turn.mode !== 'foreground')
                throw new Error('Expected foreground input.');
              mocks.canSendRequest.mockReturnValue(sendAccess);
              return yield* model.generateTurn(turn);
            }),
          ),
        );
        expect(Exit.isSuccess(exit)).toBe(permitted);
        if (Exit.isFailure(exit)) {
          const failure = exit.cause.reasons.find(Cause.isFailReason);
          expect(failure?.error).toMatchObject({ kind: 'authentication' });
          expect(failure?.error).not.toHaveProperty('providerEvidence');
        }
        expect(selected.sendRequest).toHaveBeenCalledTimes(Number(permitted));
        expect(mocks.selectChatModels).toHaveBeenCalledOnce();
        expect(mocks.canSendRequest).toHaveBeenLastCalledWith(selected);
      }),
  );

  effectIt.effect(
    'rejects foreign and retired acquisitions without reselecting or sending',
    () =>
      Effect.gen(function* () {
        const selected = fakeModel();
        mocks.selectChatModels.mockResolvedValue([selected]);
        const scope = yield* Scope.make();
        const model = yield* acquireVscodeLanguageModel(
          nativeContext,
          nativeConfiguration(),
        ).pipe(Scope.provide(scope));
        const turn = yield* model.prepareTurn(nativeRequest);
        if (turn.mode !== 'foreground' || turn.protocol !== 'vscode-lm')
          throw new Error('Expected editor input.');
        const foreign = yield* Effect.exit(
          model.generateTurn({
            ...turn,
            acquisitionId: '11111111-1111-4111-8111-111111111111',
          }),
        );
        expect(Exit.isFailure(foreign)).toBe(true);
        yield* Scope.close(scope, Exit.void);
        expect(
          Exit.isFailure(yield* Effect.exit(model.generateTurn(turn))),
        ).toBe(true);
        expect(
          Exit.isFailure(yield* Effect.exit(model.prepareTurn(nativeRequest))),
        ).toBe(true);
        expect(mocks.selectChatModels).toHaveBeenCalledOnce();
        expect(selected.sendRequest).not.toHaveBeenCalled();
      }),
  );

  effectIt.effect.each([
    { ...nativeRequest, temperature: 0.2 },
    {
      messages: [
        {
          role: 'user',
          content: [
            { kind: 'document', mimeType: 'application/pdf', base64: '' },
          ],
        },
      ],
    },
    {
      messages: [
        {
          role: 'user',
          content: [
            {
              kind: 'image',
              mimeType: 'image/png',
              base64: '',
              detail: 'high',
            },
          ],
        },
      ],
    },
    { ...nativeRequest, toolChoice: { name: 'search' } },
  ] satisfies TurnRequest[])(
    'rejects unsupported prepared input before generation: %j',
    (request) =>
      Effect.gen(function* () {
        const selected = fakeModel();
        mocks.selectChatModels.mockResolvedValue([selected]);
        const exit = yield* Effect.exit(
          Effect.scoped(
            Effect.gen(function* () {
              const model = yield* acquireVscodeLanguageModel(
                nativeContext,
                nativeConfiguration(),
              );
              return yield* model.prepareTurn(request);
            }),
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(selected.sendRequest).not.toHaveBeenCalled();
      }),
  );

  effectIt.effect.each(['NoPermissions', 'Blocked', 'NotFound'] as const)(
    'retains actual native %s evidence without a synthetic HTTP status',
    (code) =>
      Effect.gen(function* () {
        const cause = Object.assign(new Error('native rejection'), { code });
        mocks.selectChatModels.mockResolvedValue([
          fakeModel({
            sendRequest: vi.fn(async () => {
              throw cause;
            }),
          }),
        ]);
        const exit = yield* Effect.exit(
          Effect.scoped(
            Effect.gen(function* () {
              const model = yield* acquireVscodeLanguageModel(
                nativeContext,
                nativeConfiguration(),
              );
              const turn = yield* model.prepareTurn(nativeRequest);
              if (turn.mode !== 'foreground')
                throw new Error('Expected foreground input.');
              return yield* model.generateTurn(turn);
            }),
          ),
        );
        if (!Exit.isFailure(exit)) throw new Error('Expected native failure.');
        expect(exit.cause.reasons).toHaveLength(1);
        const failure = exit.cause.reasons.find(Cause.isFailReason);
        expect(failure?.error).toMatchObject({
          message: 'native rejection',
          cause,
          providerEvidence: { kind: 'vscode-lm', code },
        });
        expect(failure?.error).not.toHaveProperty('status');
        expect(cancellationSources[0].dispose).toHaveBeenCalledOnce();
      }),
  );

  effectIt.effect.each(['headers', 'body'] as const)(
    'cancels before joining the exposed pending %s operation',
    (stage) =>
      Effect.gen(function* () {
        let entered!: () => void;
        const ready = new Promise<void>((resolve) => {
          entered = resolve;
        });
        let finish!: () => void;
        const order: string[] = [];
        const sendRequest = vi.fn(
          async (
            _messages,
            _options,
            token: CancellationTokenSource['token'],
          ) => {
            token.onCancellationRequested(() => {
              order.push('cancel');
            });
            const pending = new Promise<never>((_resolve, reject) => {
              finish = () => {
                order.push('joined');
                reject(new CancellationError());
              };
            });
            if (stage === 'headers') {
              entered();
              return pending;
            }
            return {
              stream: {
                [Symbol.asyncIterator]: () => ({
                  next: () => {
                    entered();
                    return pending;
                  },
                  return: async () => {
                    order.push('return');
                    return { done: true, value: undefined };
                  },
                }),
              },
            };
          },
        );
        mocks.selectChatModels.mockResolvedValue([fakeModel({ sendRequest })]);
        const fiber = yield* Effect.forkChild(
          Effect.scoped(
            Effect.gen(function* () {
              const model = yield* acquireVscodeLanguageModel(
                nativeContext,
                nativeConfiguration(),
              );
              const turn = yield* model.prepareTurn(nativeRequest);
              if (turn.mode !== 'foreground')
                throw new Error('Expected foreground input.');
              return yield* model.generateTurn(turn);
            }),
          ),
        );
        yield* Effect.promise(() => ready);
        const cancellation = yield* Effect.forkChild(Fiber.interrupt(fiber));
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(order).toEqual(['cancel'])),
        );
        expect(cancellation.pollUnsafe()).toBeUndefined();
        finish();
        yield* Fiber.join(cancellation);
        expect(order).toEqual(
          stage === 'headers'
            ? ['cancel', 'joined']
            : ['cancel', 'joined', 'return'],
        );
        expect(cancellationSources[0].dispose).toHaveBeenCalledOnce();
        expect(sendRequest).toHaveBeenCalledOnce();
      }),
  );

  effectIt.effect(
    'preserves a primary malformed response and a distinct iterator cleanup defect',
    () =>
      Effect.gen(function* () {
        const cleanup = new Error('return failed');
        mocks.selectChatModels.mockResolvedValue([
          fakeModel({
            sendRequest: vi.fn(async () => ({
              stream: {
                [Symbol.asyncIterator]: () => ({
                  next: async () => ({
                    done: false,
                    value: new LanguageModelToolCallPart('', 'search', {}),
                  }),
                  return: async () => {
                    throw cleanup;
                  },
                }),
              },
            })),
          }),
        ]);
        const exit = yield* Effect.exit(
          Effect.scoped(
            Effect.gen(function* () {
              const model = yield* acquireVscodeLanguageModel(
                nativeContext,
                nativeConfiguration(),
              );
              const turn = yield* model.prepareTurn(nativeRequest);
              if (turn.mode !== 'foreground')
                throw new Error('Expected foreground input.');
              return yield* model.generateTurn(turn);
            }),
          ),
        );
        if (!Exit.isFailure(exit)) throw new Error('Expected failure.');
        expect(
          exit.cause.reasons.find(Cause.isFailReason)?.error,
        ).toMatchObject({
          kind: 'malformed-output',
        });
        expect(
          exit.cause.reasons.find(Cause.isDieReason)?.defect,
        ).toMatchObject({
          cause: cleanup,
        });
        expect(cancellationSources[0].dispose).toHaveBeenCalledOnce();
      }),
  );
});
