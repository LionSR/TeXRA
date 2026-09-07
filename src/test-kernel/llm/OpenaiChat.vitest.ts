// Third-party imports
import { openaiChatModel } from '@texra-ai/llm/openai-chat';
import { ModelError, type Model, type TurnRequest } from '@texra-ai/llm/turn';
import { Effect, Fiber, Stream } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';

const CONFIG = {
  protocol: 'openai-chat' as const,
  requestedModel: 'synthetic-model',
  deployment: {
    endpoint: 'https://synthetic.invalid/v1',
    credentialScope: 'synthetic-account',
  },
  defaults: { temperature: 0, maxOutputTokens: 100, parallelToolCalls: true },
};
const REQUEST: TurnRequest = {
  messages: [
    { role: 'user', content: [{ kind: 'text', text: 'Generate YAML.' }] },
  ],
};

function chunk(overrides: Record<string, unknown> = {}): object {
  return {
    id: 'synthetic-response',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'returned-model-version',
    choices: [
      {
        index: 0,
        delta: { content: 'generated: true' },
        finish_reason: 'stop',
      },
    ],
    ...overrides,
  };
}

function sse(...events: object[]): string {
  return (
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') +
    'data: [DONE]\n\n'
  );
}

function response(body: string): Response {
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function toolChunk(
  toolCalls: object[],
  finishReason: string | null = null,
): object {
  return chunk({
    choices: [
      {
        index: 0,
        delta: { tool_calls: toolCalls },
        finish_reason: finishReason,
      },
    ],
  });
}

const TOOLS = ['search', 'fetch'].map((name) => ({
  name,
  description: `Synthetic ${name}`,
  parameters: { type: 'object', properties: { query: { type: 'string' } } },
}));

function call(index: number, overrides: Record<string, unknown> = {}): object {
  return {
    index,
    id: `call_${index}`,
    type: 'function',
    function: { name: TOOLS[index]?.name ?? 'search', arguments: '{}' },
    ...overrides,
  };
}

function modelWith(fetch: typeof globalThis.fetch): Model {
  return openaiChatModel(CONFIG, { apiKey: 'synthetic-not-a-secret', fetch });
}

const generate = (model: Model) =>
  Effect.gen(function* () {
    return yield* model.generateTurn(yield* model.prepareTurn(REQUEST));
  });

afterEach(() => vi.unstubAllEnvs());

describe('native OpenAI Chat protocol', () => {
  it('freezes preparation and collects trailing usage in one execution', async () => {
    vi.stubEnv('OPENAI_ORG_ID', 'unselected-organization');
    vi.stubEnv('OPENAI_PROJECT_ID', 'unselected-project');
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      response(
        sse(
          chunk(),
          chunk({
            choices: [],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 4,
              total_tokens: 14,
              prompt_tokens_details: { cached_tokens: 3 },
              completion_tokens_details: { reasoning_tokens: 1 },
            },
          }),
        ),
      ),
    );
    const config = structuredClone(CONFIG);
    const model = openaiChatModel(config, { apiKey: 'synthetic', fetch });
    const request = structuredClone(REQUEST);
    const prepared = await Effect.runPromise(model.prepareTurn(request));
    config.defaults.maxOutputTokens = 200;
    config.requestedModel = 'later-model';
    const content = prepared.messages.find(
      (message) => message.role === 'user',
    )?.content;
    expect(content).toHaveLength(1);
    expect(Object.isFrozen(content?.[0])).toBe(true);

    const events = await Effect.runPromise(
      Stream.runCollect(model.streamTurn(prepared)),
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    const init = fetch.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'synthetic-model',
      temperature: 0,
      max_completion_tokens: 100,
      n: 1,
      stream: true,
      stream_options: { include_usage: true },
    });
    const headers = new Headers(init?.headers);
    expect(headers.has('openai-organization')).toBe(false);
    expect(headers.has('openai-project')).toBe(false);
    expect(events).toEqual([
      {
        kind: 'identified',
        providerResponseId: 'synthetic-response',
        requestedOrigin: {
          protocol: 'openai-chat',
          codecVersion: 1,
          requestedModel: CONFIG.requestedModel,
          deployment: CONFIG.deployment,
        },
        returnedModel: 'returned-model-version',
      },
      { kind: 'delta', part: 'text', text: 'generated: true' },
      {
        kind: 'completed',
        result: {
          providerResponseId: 'synthetic-response',
          requestedOrigin: {
            protocol: 'openai-chat',
            codecVersion: 1,
            requestedModel: 'synthetic-model',
            deployment: CONFIG.deployment,
          },
          returnedModel: 'returned-model-version',
          modelFingerprint: null,
          content: [
            {
              kind: 'message',
              content: [{ kind: 'text', text: 'generated: true' }],
            },
          ],
          finishReason: 'stop',
          usage: {
            inputTokens: 10,
            outputTokens: 4,
            totalTokens: 14,
            cachedInputTokens: 3,
            reasoningTokens: 1,
          },
        },
      },
    ]);
  });

  it('preserves unknown usage and rejects another prepared deployment before sending', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response(sse(chunk())));
    const model = modelWith(fetch);
    const result = await Effect.runPromise(generate(model));
    expect(result.usage).toBeNull();
    const prepared = await Effect.runPromise(model.prepareTurn(REQUEST));
    const failure = await Effect.runPromise(
      Effect.flip(
        model.generateTurn({
          ...prepared,
          deployment: {
            ...prepared.deployment,
            credentialScope: 'another-account',
          },
        }),
      ),
    );
    expect(failure).toMatchObject({ kind: 'unsupported' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('collects indexed calls once and lowers ordered results without losing error status', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        response(
          sse(
            chunk({
              choices: [
                {
                  index: 0,
                  delta: { content: 'Checking.' },
                  finish_reason: null,
                },
              ],
            }),
            toolChunk([
              call(1, { function: { name: 'fetch', arguments: '{"query":' } }),
              call(0, { function: { name: 'search', arguments: '{"query":' } }),
            ]),
            toolChunk([
              {
                index: 0,
                id: 'call_0',
                function: { name: 'search', arguments: '"first"}' },
              },
              {
                index: 1,
                id: null,
                type: null,
                function: { name: null, arguments: '"second"}' },
              },
            ]),
            chunk({
              choices: [
                {
                  index: 0,
                  delta: { tool_calls: null },
                  finish_reason: 'tool_calls',
                },
              ],
            }),
            chunk({
              choices: [],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 8,
                total_tokens: 18,
              },
            }),
          ),
        ),
      )
      .mockResolvedValueOnce(response(sse(chunk())));
    const model = modelWith(fetch);
    const prepared = await Effect.runPromise(
      model.prepareTurn({ ...REQUEST, tools: TOOLS }),
    );
    const events = await Effect.runPromise(
      Stream.runCollect(model.streamTurn(prepared)),
    );
    expect(events).toHaveLength(3);
    expect(events[0]?.kind).toBe('identified');
    expect(events[1]).toEqual({
      kind: 'delta',
      part: 'text',
      text: 'Checking.',
    });
    const completed = events[2];
    expect(completed?.kind).toBe('completed');
    if (completed?.kind !== 'completed')
      throw new Error('Missing completed result');
    const result = completed.result;
    expect(result).toMatchObject({
      finishReason: 'tool-calls',
      usage: { totalTokens: 18 },
      content: [
        { kind: 'message', content: [{ kind: 'text', text: 'Checking.' }] },
        {
          kind: 'local-call',
          providerCallId: 'call_0',
          name: 'search',
          arguments: { query: 'first' },
        },
        {
          kind: 'local-call',
          providerCallId: 'call_1',
          name: 'fetch',
          arguments: { query: 'second' },
        },
      ],
    });
    await Effect.runPromise(
      model
        .prepareTurn({
          messages: [
            ...REQUEST.messages,
            {
              role: 'assistant',
              origin: result.requestedOrigin,
              content: [
                {
                  kind: 'message',
                  content: [{ kind: 'text', text: 'Prior context.' }],
                },
                ...result.content,
              ],
            },
            {
              role: 'tool',
              results: [
                {
                  callOrdinal: 0,
                  status: 'success',
                  content: [{ kind: 'text', text: 'same text' }],
                },
                {
                  callOrdinal: 1,
                  status: 'error',
                  content: [{ kind: 'text', text: 'same text' }],
                },
              ],
            },
          ],
          tools: TOOLS,
        })
        .pipe(Effect.flatMap(model.generateTurn)),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      tools: TOOLS.map((tool) => ({
        type: 'function',
        function: { ...tool, strict: false },
      })),
      tool_choice: 'auto',
      parallel_tool_calls: true,
    });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).messages).toEqual(
      [
        { role: 'user', content: 'Generate YAML.' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Prior context.' }],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Checking.' }],
          tool_calls: [
            {
              id: 'call_0',
              type: 'function',
              function: { name: 'search', arguments: '{"query":"first"}' },
            },
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'fetch', arguments: '{"query":"second"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_0', content: 'same text' },
        { role: 'tool', tool_call_id: 'call_1', content: 'Error: same text' },
      ],
    );
  });

  it('freezes configured parallelism and the required tool before sending', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () =>
        response(sse(toolChunk([call(0)], 'tool_calls'))),
      );
    const config = structuredClone(CONFIG);
    config.defaults.parallelToolCalls = false;
    const model = openaiChatModel(config, { apiKey: 'synthetic', fetch });
    const choice = { name: 'search' };
    const turn = await Effect.runPromise(
      model.prepareTurn({ ...REQUEST, tools: TOOLS, toolChoice: choice }),
    );
    config.defaults.parallelToolCalls = true;
    choice.name = 'fetch';
    await Effect.runPromise(model.generateTurn(turn));
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      parallel_tool_calls: false,
      tool_choice: { type: 'function', function: { name: 'search' } },
    });
    await Effect.runPromise(
      model
        .prepareTurn({ ...REQUEST, tools: TOOLS, parallelToolCalls: true })
        .pipe(Effect.flatMap(model.generateTurn)),
    );
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      parallel_tool_calls: true,
      tool_choice: 'auto',
    });
    const failure = await Effect.runPromise(
      Effect.flip(
        model.prepareTurn({
          ...REQUEST,
          tools: TOOLS,
          toolChoice: { name: 'absent' },
        }),
      ),
    );
    expect(failure.kind).toBe('invalid-request');
    const forged = await Effect.runPromise(
      Effect.flip(
        model.generateTurn({
          ...turn,
          tools: [],
        }),
      ),
    );
    expect(forged.kind).toBe('invalid-request');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    'user media',
    'tool media',
    'reasoning',
    'missing call ID',
    'text after calls',
    'reasoning control',
    'service-tier control',
    'Responses message evidence',
    'Responses call evidence',
  ] as const)('rejects unsupported %s before transport', async (scenario) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const model = modelWith(fetch);
    const image = { kind: 'image', mimeType: 'image/png', base64: '' } as const;
    const content: TurnRequest['messages'][number] = {
      role: 'assistant',
      origin: {
        protocol: 'openai-chat',
        codecVersion: 1,
        requestedModel: CONFIG.requestedModel,
        deployment: CONFIG.deployment,
      },
      content: [
        {
          kind: 'local-call',
          providerCallId: scenario === 'missing call ID' ? null : 'call_0',
          name: 'search',
          arguments: {},
        },
        ...(scenario === 'text after calls'
          ? [
              {
                kind: 'message' as const,
                content: [{ kind: 'text' as const, text: 'later text' }],
              },
            ]
          : []),
      ],
    };
    let request: TurnRequest = {
      messages: [
        ...REQUEST.messages,
        content,
        {
          role: 'tool',
          results: [
            {
              callOrdinal: 0,
              status: 'success',
              content:
                scenario === 'tool media'
                  ? [image]
                  : [{ kind: 'text', text: 'done' }],
            },
          ],
        },
      ],
    };
    if (scenario === 'user media')
      request = { messages: [{ role: 'user', content: [image] }] };
    if (scenario === 'reasoning control')
      request = { ...REQUEST, reasoning: null };
    if (scenario === 'service-tier control')
      request = { ...REQUEST, serviceTier: null };
    if (scenario === 'Responses message evidence')
      request = {
        messages: [
          ...REQUEST.messages,
          {
            ...content,
            origin: { ...content.origin, protocol: 'openai-responses' },
            content: [
              {
                kind: 'message',
                content: [{ kind: 'text', text: 'Keep this phase.' }],
                evidence: {
                  kind: 'openai-responses-message',
                  itemId: 'msg_1',
                  status: 'completed',
                  phase: 'commentary',
                },
              },
            ],
          },
        ],
      };
    if (scenario === 'Responses call evidence')
      request = {
        ...request,
        messages: request.messages.map((message) =>
          message.role === 'assistant'
            ? {
                ...message,
                origin: { ...message.origin, protocol: 'openai-responses' },
                content: message.content.map((part) =>
                  part.kind === 'local-call'
                    ? {
                        ...part,
                        evidence: {
                          kind: 'openai-responses-function-call' as const,
                          itemId: 'fc_1',
                        },
                      }
                    : part,
                ),
              }
            : message,
        ),
      };
    if (scenario === 'reasoning')
      request = {
        messages: [
          ...REQUEST.messages,
          {
            ...content,
            content: [
              {
                kind: 'reasoning',
                summary: [{ kind: 'text', text: 'reason' }],
                evidence: null,
              },
            ],
          },
        ],
      };
    const failure = await Effect.runPromise(
      Effect.flip(model.prepareTurn(request)),
    );
    expect(failure.kind).toBe('unsupported');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'changed call ID', deltas: [call(0), { index: 0, id: 'changed' }] },
    {
      name: 'changed call name',
      deltas: [call(0), { index: 0, function: { name: 'fetch' } }],
    },
    { name: 'missing call ID', deltas: [call(0, { id: undefined })] },
    { name: 'missing call type', deltas: [call(0, { type: undefined })] },
    {
      name: 'missing call name',
      deltas: [call(0, { function: { arguments: '{}' } })],
    },
    {
      name: 'duplicate call IDs',
      deltas: [call(0), call(1, { id: 'call_0' })],
    },
    { name: 'missing index', deltas: [call(1)] },
    {
      name: 'malformed JSON',
      deltas: [call(0, { function: { name: 'search', arguments: '{' } })],
    },
    {
      name: 'non-object JSON',
      deltas: [call(0, { function: { name: 'search', arguments: '[]' } })],
    },
    {
      name: 'unsupported JSON key',
      deltas: [
        call(0, {
          function: { name: 'search', arguments: '{"__proto__":{}}' },
        }),
      ],
    },
    { name: 'stop with calls', deltas: [call(0)], finish: 'stop' },
    { name: 'truncated calls', deltas: [call(0)], finish: 'length' },
  ])(
    'never completes malformed tool output: $name',
    async ({ deltas, finish }) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          response(
            sse(
              ...deltas.map((delta) => toolChunk([delta])),
              toolChunk([], finish ?? 'tool_calls'),
            ),
          ),
        );
      const model = modelWith(fetch);
      const completed = vi.fn();
      const failure = await Effect.runPromise(
        Effect.flip(
          model.prepareTurn({ ...REQUEST, tools: TOOLS }).pipe(
            Effect.flatMap((turn) =>
              Stream.runForEach(model.streamTurn(turn), (event) =>
                Effect.sync(() => {
                  if (event.kind === 'completed') completed();
                }),
              ),
            ),
          ),
        ),
      );
      expect(failure).toMatchObject({
        kind: 'malformed-output',
        responseId: 'synthetic-response',
      });
      expect(completed).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    {
      name: 'connection',
      send: () => Promise.reject(new TypeError('synthetic connection failure')),
      kind: 'transport',
    },
    {
      name: 'authentication',
      send: async () =>
        new Response('{"error":{"message":"denied"}}', {
          status: 401,
          headers: { 'x-request-id': 'synthetic-request' },
        }),
      kind: 'authentication',
    },
    {
      name: 'rate limiting',
      send: async () =>
        new Response('{"error":{"message":"limited"}}', {
          status: 429,
          headers: { 'x-request-id': 'synthetic-request' },
        }),
      kind: 'provider-rejection',
    },
    {
      name: 'malformed SSE',
      send: async () => response('data: malformed JSON\n\n'),
      kind: 'malformed-output',
    },
  ])('classifies $name without a hidden SDK retry', async ({ send, kind }) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(send);
    const failure = await Effect.runPromise(
      Effect.flip(generate(modelWith(fetch))),
    );
    expect(failure).toBeInstanceOf(ModelError);
    expect(failure.kind).toBe(kind);
    expect(failure.message.length).toBeGreaterThan(0);
    expect(failure.cause).toBeDefined();
    if (kind === 'authentication' || kind === 'provider-rejection') {
      expect(failure.requestId).toBe('synthetic-request');
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: 'unfinished response', tail: '' },
    {
      name: 'tool completion without calls',
      tail: sse(
        chunk({
          choices: [
            {
              index: 0,
              delta: { tool_calls: [] },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      ),
    },
    { name: 'changed identity', tail: sse(chunk({ id: 'another-response' })) },
    { name: 'malformed later event', tail: 'data: malformed JSON\n\n' },
  ])('retains available response identity after $name', async ({ tail }) => {
    const first = chunk({
      choices: [
        { index: 0, delta: { content: 'partial' }, finish_reason: null },
      ],
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response(`data: ${JSON.stringify(first)}\n\n${tail}`));
    const failure = await Effect.runPromise(
      Effect.flip(generate(modelWith(fetch))),
    );
    expect(failure).toMatchObject({
      kind: 'malformed-output',
      responseId: 'synthetic-response',
      model: 'returned-model-version',
    });
  });

  it.each(['headers', 'body', 'tool arguments'] as const)(
    'interrupts a pending %s read and joins cleanup',
    async (phase) => {
      let requestSignal: AbortSignal | null | undefined;
      const cancel = vi.fn();
      const onDelta = vi.fn();
      const onCompleted = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify(chunk({ choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] }))}\n\n`,
            ),
          );
          if (phase === 'tool arguments')
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify(toolChunk([call(0, { function: { name: 'search', arguments: '{' } })]))}\n\n`,
              ),
            );
        },
        cancel,
      });
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation((_input, init) => {
          requestSignal = init?.signal;
          if (phase !== 'headers')
            return Promise.resolve(
              new Response(body, {
                headers: { 'content-type': 'text/event-stream' },
              }),
            );
          return new Promise((_resolve, reject) =>
            requestSignal?.addEventListener(
              'abort',
              () => reject(requestSignal?.reason),
              { once: true },
            ),
          );
        });
      const model = modelWith(fetch);
      const prepared = await Effect.runPromise(model.prepareTurn(REQUEST));
      const fiber = Effect.runFork(
        Stream.runForEach(model.streamTurn(prepared), (event) =>
          Effect.sync(() => {
            if (event.kind === 'delta') onDelta();
            if (event.kind === 'completed') onCompleted();
          }),
        ),
      );
      await vi.waitFor(() => {
        expect(requestSignal).toBeDefined();
        if (phase !== 'headers') expect(onDelta).toHaveBeenCalledTimes(1);
      });

      await Effect.runPromise(Fiber.interrupt(fiber));

      expect(requestSignal?.aborted).toBe(true);
      if (phase !== 'headers') expect(cancel).toHaveBeenCalledTimes(1);
      expect(onCompleted).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
});
