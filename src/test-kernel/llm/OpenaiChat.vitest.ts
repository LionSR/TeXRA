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
  defaults: { temperature: 0, maxOutputTokens: 100 },
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
          content: [{ kind: 'text', text: 'generated: true' }],
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
      name: 'unsupported tool call',
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

  it.each(['headers', 'body'] as const)(
    'interrupts a pending %s read and joins cleanup',
    async (phase) => {
      let requestSignal: AbortSignal | null | undefined;
      const cancel = vi.fn();
      const onDelta = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify(chunk({ choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] }))}\n\n`,
            ),
          );
        },
        cancel,
      });
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation((_input, init) => {
          requestSignal = init?.signal;
          if (phase === 'body')
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
          }),
        ),
      );
      await vi.waitFor(() => {
        expect(requestSignal).toBeDefined();
        if (phase === 'body') expect(onDelta).toHaveBeenCalledTimes(1);
      });

      await Effect.runPromise(Fiber.interrupt(fiber));

      expect(requestSignal?.aborted).toBe(true);
      if (phase === 'body') expect(cancel).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
});
