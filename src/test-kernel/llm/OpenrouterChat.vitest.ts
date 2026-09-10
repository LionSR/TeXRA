// Node.js imports
import assert from 'node:assert/strict';

// Third-party imports
import { openrouterChatModel } from '@texra-ai/llm/openrouter-chat';
import {
  ModelError,
  type Model,
  type OpenRouterConfiguration,
  type TurnEvent,
  type TurnRequest,
} from '@texra-ai/llm/turn';
import { it } from '@effect/vitest';
import { Cause, Effect, Exit, Fiber, Stream } from 'effect';
import { describe, expect, vi } from 'vitest';

const CONFIG = {
  protocol: 'openrouter-chat',
  requestedModel: 'selected-model',
  deployment: {
    endpoint: 'https://synthetic.invalid/api/v1',
    credentialScope: 'account',
  },
  supportsTemperature: true,
  supportsForcedToolChoice: true,
  supportsImageInput: true,
  supportsAudioInput: true,
  supportedEfforts: ['none', 'minimal', 'low', 'high', 'max'],
  defaults: {
    maxOutputTokens: 100,
    temperature: 0,
    effort: 'high',
    stopSequences: [],
  },
} as const satisfies OpenRouterConfiguration;
const REQUEST: TurnRequest = {
  messages: [{ role: 'user', content: [{ kind: 'text', text: 'Go.' }] }],
};
const TOOLS = ['search', 'fetch'].map((name) => ({
  name,
  description: name,
  parameters: { type: 'object', properties: { q: { type: 'string' } } },
}));
const IDENTITY = { id: 'generation-1', model: 'returned-model' };
const DETAILS = [
  {
    type: 'reasoning.text',
    id: null,
    index: 0,
    format: 'anthropic-claude-v1',
    text: '',
    signature: null,
  },
  {
    type: 'reasoning.text',
    id: 'same-id',
    index: 1,
    format: null,
    text: 'plan',
    signature: 'signature',
  },
  { type: 'reasoning.summary', id: 'same-id', index: 1, summary: 'summary' },
  { type: 'reasoning.encrypted', data: 'opaque==', id: 'same-id', index: 1 },
  {
    type: 'reasoning.server_tool_call',
    tool_name: 'web_search',
    tool_call_id: null,
    arguments: '{ "q": "x" }',
    result: ' raw hosted result ',
  },
];
const FILE = {
  type: 'file',
  file: {
    hash: 'file-hash',
    name: 'original.pdf',
    content: [
      { type: 'text', text: 'Extracted' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
    ],
  },
};
const CITATION = {
  type: 'url_citation',
  url_citation: {
    url: 'https://synthetic.invalid/citation',
    start_index: 0,
    end_index: 8,
    content: '',
  },
};
const USAGE = {
  prompt_tokens: 11,
  completion_tokens: 7,
  total_tokens: 18,
  cost: 0,
  is_byok: false,
  cost_details: { upstream_inference_cost: 0.125 },
  prompt_tokens_details: {
    cached_tokens: 3,
    cache_write_tokens: 4,
    audio_tokens: 1,
    video_tokens: null,
  },
  completion_tokens_details: {
    reasoning_tokens: 5,
    audio_tokens: null,
    accepted_prediction_tokens: 0,
    rejected_prediction_tokens: 1,
    image_tokens: 2,
  },
  server_tool_use_details: {
    tool_calls_requested: 1,
    tool_calls_executed: 1,
    web_search_requests: 1,
  },
};

function frame(delta: object = {}, finishReason: string | null = null): object {
  return {
    ...IDENTITY,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
        native_finish_reason: null,
      },
    ],
  };
}
function sse(...frames: object[]): string {
  return (
    frames.map((item) => `data: ${JSON.stringify(item)}\n\n`).join('') +
    'data: [DONE]\n\n'
  );
}
function response(body: BodyInit, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/event-stream',
      'X-Request-ID': 'request-1',
    },
  });
}
function call(index: number, args: string, metadata = true): object {
  return {
    index,
    ...(metadata
      ? { id: `call-${index}`, ...(index === 0 ? { type: 'function' } : {}) }
      : { id: null }),
    function: {
      ...(metadata ? { name: TOOLS[index].name } : { name: null }),
      arguments: args,
    },
  };
}
function run(model: Model, request: TurnRequest = REQUEST) {
  return Effect.gen(function* () {
    const turn = yield* model.prepareTurn(request);
    assert.equal(turn.mode, 'foreground');
    return yield* model.generateTurn(turn);
  });
}
function errors(exit: Exit.Exit<unknown, ModelError>) {
  assert(Exit.isFailure(exit));
  return exit.cause.reasons
    .filter(Cause.isFailReason)
    .map((reason) => reason.error);
}

describe('native OpenRouter Chat', () => {
  it.effect(
    'preserves ordered media, complete reasoning, annotations, receipt and tool settlement through rehydrated replay',
    () =>
      Effect.gen(function* () {
        const sent: Record<string, any>[] = [];
        const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
          expect(url).toBe('https://synthetic.invalid/api/v1/chat/completions');
          expect(new Headers(init?.headers).get('Authorization')).toBe(
            'Bearer selected-key',
          );
          sent.push(JSON.parse(String(init?.body)));
          if (sent.length === 2)
            return response(sse(frame({ content: 'Done.' }, 'stop')));
          return response(
            sse(
              frame({ reasoning: null, reasoning_details: null }),
              frame({ reasoning: '', reasoning_details: [] }),
              frame({
                reasoning: 'plain',
                reasoning_details: DETAILS.slice(0, 2),
              }),
              frame({ reasoning: null, reasoning_details: DETAILS.slice(2) }),
              frame({ content: 'Search now.', annotations: [FILE, CITATION] }),
              frame({ tool_calls: [call(1, '{"q":'), call(0, '{')] }),
              frame({
                tool_calls: [
                  call(0, '"q":"a"}', false),
                  call(1, '"b"}', false),
                ],
              }),
              {
                choices: [
                  {
                    index: 0,
                    finish_reason: 'tool_calls',
                    native_finish_reason: 'tool_use',
                  },
                ],
              },
              {
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: 'tool_calls',
                    native_finish_reason: 'tool_use',
                  },
                ],
                usage: USAGE,
                service_tier: 'standard',
              },
              { choices: [], usage: USAGE },
            ),
          );
        });
        const model = openrouterChatModel(CONFIG, {
          apiKey: 'selected-key',
          fetch,
        });
        const request: TurnRequest = {
          system: '',
          tools: TOOLS,
          toolChoice: { name: 'search' },
          effort: 'minimal',
          stopSequences: ['END'],
          messages: [
            {
              role: 'user',
              content: [
                { kind: 'text', text: 'image label' },
                {
                  kind: 'image',
                  mimeType: 'IMAGE/PNG',
                  base64: '',
                  detail: 'high',
                },
                { kind: 'text', text: 'audio label' },
                { kind: 'audio', mimeType: 'audio/mpeg', base64: 'AA==' },
                { kind: 'text', text: 'PDF label' },
                { kind: 'document', mimeType: 'application/pdf', base64: '' },
              ],
            },
          ],
        };
        const turn = yield* model.prepareTurn(request);
        assert.equal(turn.mode, 'foreground');
        const events = yield* Stream.runCollect(model.streamTurn(turn));
        expect(events[0].kind).toBe('identified');
        expect(
          events
            .map((event) =>
              event.kind === 'delta' && event.part === 'reasoning'
                ? event.text
                : '',
            )
            .join(''),
        ).toBe('plansummary');
        const completed = events.findLast(
          (event) => event.kind === 'completed',
        );
        assert(completed?.kind === 'completed');
        const result = completed.result;
        expect(result).toMatchObject({
          providerResponseId: 'generation-1',
          returnedModel: 'returned-model',
          finishReason: 'tool-calls',
          finishEvidence: {
            kind: 'openrouter',
            nativeFinishReason: 'tool_use',
          },
          usage: {
            inputTokens: 11,
            cachedInputTokens: 3,
            reasoningTokens: 5,
            providerUsage: {
              kind: 'openrouter',
              cost: 0,
              isByok: false,
              costDetails: { upstreamInferenceCost: 0.125 },
              inputDetails: { cacheWriteTokens: 4 },
              outputDetails: { acceptedPredictionTokens: 0 },
              serviceTier: 'standard',
            },
          },
        });
        expect(result.content.map((part) => part.kind)).toEqual([
          'reasoning',
          'message',
          'local-call',
          'local-call',
          'file-annotation',
          'url-citation',
        ]);
        expect(result.content[0]).toMatchObject({
          kind: 'reasoning',
          summary: [],
          evidence: {
            kind: 'openrouter-reasoning',
            plain: 'plain',
            details: [
              { kind: 'text', text: '', signature: null },
              { kind: 'text', text: 'plan', signature: 'signature' },
              { kind: 'summary', summary: 'summary' },
              { kind: 'encrypted', data: 'opaque==' },
              {
                kind: 'server-tool-call',
                arguments: '{ "q": "x" }',
                result: ' raw hosted result ',
              },
            ],
          },
        });
        expect('content' in result.content[0]).toBe(false);
        const restored = JSON.parse(JSON.stringify(result));
        const followUp: TurnRequest = {
          ...request,
          messages: [
            ...request.messages,
            {
              role: 'assistant',
              origin: restored.requestedOrigin,
              content: restored.content,
            },
            {
              role: 'tool',
              results: [
                {
                  callOrdinal: 0,
                  status: 'success',
                  content: [{ kind: 'text', text: 'A' }],
                },
                {
                  callOrdinal: 1,
                  status: 'error',
                  content: [{ kind: 'text', text: 'B' }],
                },
              ],
            },
          ],
        };
        yield* run(model, followUp);
        expect(sent[0]).toMatchObject({
          stream: true,
          max_completion_tokens: 100,
          reasoning: { effort: 'minimal' },
          stop: ['END'],
          tool_choice: { type: 'function', function: { name: 'search' } },
        });
        expect(sent[0].messages[1].content).toEqual([
          { type: 'text', text: 'image label' },
          {
            type: 'image_url',
            image_url: { url: 'data:IMAGE/PNG;base64,', detail: 'high' },
          },
          { type: 'text', text: 'audio label' },
          { type: 'input_audio', input_audio: { data: 'AA==', format: 'mp3' } },
          { type: 'text', text: 'PDF label' },
          { type: 'file', file: { file_data: 'data:application/pdf;base64,' } },
        ]);
        expect(sent[1].messages[2]).toMatchObject({
          role: 'assistant',
          content: 'Search now.',
          reasoning: 'plain',
          reasoning_details: DETAILS,
          annotations: [FILE, CITATION],
          tool_calls: [
            {
              id: 'call-0',
              function: { name: 'search', arguments: '{"q":"a"}' },
            },
            {
              id: 'call-1',
              function: { name: 'fetch', arguments: '{"q":"b"}' },
            },
          ],
        });
        expect(sent[1].messages.slice(-2)).toEqual([
          { role: 'tool', tool_call_id: 'call-0', content: 'A' },
          { role: 'tool', tool_call_id: 'call-1', content: 'Error: B' },
        ]);
        for (const order of [
          [1, 0, 2, 3, 4, 5],
          [0, 2, 1, 3, 4, 5],
          [0, 1, 4, 2, 3, 5],
        ]) {
          const exit = yield* Effect.exit(
            model.prepareTurn({
              ...followUp,
              messages: followUp.messages.map((message) =>
                message.role === 'assistant'
                  ? {
                      ...message,
                      content: order.map((index) => result.content[index]),
                    }
                  : message,
              ),
            }),
          );
          expect(errors(exit)[0].kind).toBe('unsupported');
        }
        expect(fetch).toHaveBeenCalledTimes(2);
      }),
  );

  it.effect.each([
    ['absent', {}, {}],
    ['null plain', { reasoning: null }, { reasoning: null }],
    ['empty plain', { reasoning: '' }, { reasoning: '' }],
    ['null details', { reasoning_details: null }, { reasoning_details: null }],
    ['empty details', { reasoning_details: [] }, { reasoning_details: [] }],
    [
      'both empty',
      { reasoning: '', reasoning_details: [] },
      { reasoning: '', reasoning_details: [] },
    ],
  ] as const)(
    'retains %s reasoning-field presence through a subsequent request',
    ([_, delta, expected]) =>
      Effect.gen(function* () {
        const bodies: any[] = [];
        const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return response(sse(frame(delta), frame({}, 'stop')));
        });
        const model = openrouterChatModel(CONFIG, { apiKey: 'key', fetch });
        const result = yield* run(model);
        yield* run(model, {
          messages: [
            ...REQUEST.messages,
            {
              role: 'assistant',
              origin: result.requestedOrigin,
              content: result.content,
            },
            { role: 'user', content: [{ kind: 'text', text: 'Continue.' }] },
          ],
        });
        const assistant = bodies[1].messages[1];
        expect(
          Object.fromEntries(
            Object.entries(assistant).filter(([key]) =>
              key.startsWith('reasoning'),
            ),
          ),
        ).toEqual(expected);
      }),
  );

  it.effect(
    'accepts identity-free terminal accounting, repeated terminal reasons and a DONE sharing its byte chunk with later data',
    () =>
      Effect.gen(function* () {
        const wire =
          ': keep-alive\r\nretry: 1\r\n\r\n' +
          sse(
            frame({ content: 'α\nβ' }),
            {
              choices: [{ finish_reason: 'stop', native_finish_reason: null }],
            },
            {
              choices: [{ finish_reason: 'stop' }],
              usage: {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0,
                cost: 0,
                is_byok: true,
              },
            },
          ) +
          'data: {"error":{"message":"must not be consumed"}}\n\n';
        const encoded = new TextEncoder().encode(wire);
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const byte of encoded.slice(0, -100))
              controller.enqueue(new Uint8Array([byte]));
            controller.enqueue(encoded.slice(-100));
            controller.close();
          },
        });
        const fetch = vi.fn<typeof globalThis.fetch>(async () =>
          response(body),
        );
        const result = yield* run(
          openrouterChatModel(CONFIG, { apiKey: 'key', fetch }),
        );
        expect(result.content).toEqual([
          { kind: 'message', content: [{ kind: 'text', text: 'α\nβ' }] },
        ]);
        expect(result.usage).toMatchObject({
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          providerUsage: { cost: 0, isByok: true },
        });
        assert(result.providerResponseId !== null);
        expect(result.finishEvidence).toEqual({
          kind: 'openrouter',
          nativeFinishReason: null,
        });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(body.locked).toBe(false);
      }),
  );

  it.effect.each([
    [
      'image disabled',
      { ...CONFIG, supportsImageInput: false },
      { kind: 'image', mimeType: 'image/png', base64: '' },
    ],
    [
      'image detail',
      CONFIG,
      { kind: 'image', mimeType: 'image/png', base64: '', detail: 'medium' },
    ],
    [
      'data URL injection',
      CONFIG,
      { kind: 'image', mimeType: 'image/png;base64,QQ==#', base64: 'AA==' },
    ],
    [
      'audio disabled',
      { ...CONFIG, supportsAudioInput: false },
      { kind: 'audio', mimeType: 'audio/mpeg', base64: '' },
    ],
    ['raw audio', CONFIG, { kind: 'audio', mimeType: 'audio/L16', base64: '' }],
    ['video', CONFIG, { kind: 'video', mimeType: 'video/mp4', base64: '' }],
    ['non-PDF', CONFIG, { kind: 'document', mimeType: 'text/csv', base64: '' }],
  ] as const)('rejects %s before I/O', ([_, config, part]) =>
    Effect.gen(function* () {
      const fetch = vi.fn<typeof globalThis.fetch>();
      const model = openrouterChatModel(config, { apiKey: 'key', fetch });
      const exit = yield* Effect.exit(
        model.prepareTurn({ messages: [{ role: 'user', content: [part] }] }),
      );
      expect(errors(exit)[0].kind).toBe('unsupported');
      expect(fetch).not.toHaveBeenCalled();
    }),
  );

  it.effect.each([
    ['unsupported effort', { effort: 'medium' }],
    ['parallel', { parallelToolCalls: false }],
    ['background', { mode: 'background' }],
    ['foreign thinking', { thinking: { mode: 'disabled' } }],
    ['cache key', { promptCacheKey: 'key' }],
    ['unknown named tool', { toolChoice: { name: 'missing' } }],
  ] as const)(
    'rejects %s and does not issue an automatic request',
    ([_, controls]) =>
      Effect.gen(function* () {
        const fetch = vi.fn<typeof globalThis.fetch>();
        const model = openrouterChatModel(CONFIG, { apiKey: 'key', fetch });
        const exit = yield* Effect.exit(
          model.prepareTurn({ ...REQUEST, ...controls }),
        );
        expect(errors(exit)[0].kind).toBe('unsupported');
        expect(fetch).not.toHaveBeenCalled();
      }),
  );

  it.effect.each([
    [
      'missing index',
      [
        frame(
          {
            tool_calls: [
              {
                id: 'call',
                type: 'function',
                function: { name: 'search', arguments: '{}' },
              },
            ],
          },
          'tool_calls',
        ),
      ],
    ],
    [
      'missing call ID',
      [
        frame(
          {
            tool_calls: [
              {
                index: 0,
                type: 'function',
                function: { name: 'search', arguments: '{}' },
              },
            ],
          },
          'tool_calls',
        ),
      ],
    ],
    [
      'changed ID',
      [
        frame({ tool_calls: [call(0, '{')] }),
        frame(
          { tool_calls: [{ ...call(0, '}'), id: 'changed' }] },
          'tool_calls',
        ),
      ],
    ],
    [
      'duplicate IDs',
      [
        frame(
          { tool_calls: [call(0, '{}'), { ...call(1, '{}'), id: 'call-0' }] },
          'tool_calls',
        ),
      ],
    ],
    ['index gap', [frame({ tool_calls: [call(1, '{}')] }, 'tool_calls')]],
    [
      'invalid arguments',
      [frame({ tool_calls: [call(0, '[]')] }, 'tool_calls')],
    ],
    ['wrong finish', [frame({ tool_calls: [call(0, '{}')] }, 'stop')]],
    [
      'content before identity',
      [
        {
          choices: [{ delta: { content: 'premature' }, finish_reason: 'stop' }],
        },
      ],
    ],
    [
      'changed response',
      [frame({ content: 'first' }), { ...frame({}, 'stop'), id: 'other' }],
    ],
    ['late content', [frame({}, 'stop'), frame({ content: 'late' }, 'stop')]],
    [
      'contradictory usage',
      [
        frame({}, 'stop'),
        { choices: [], usage: USAGE },
        { choices: [], usage: { ...USAGE, cost: 3 } },
      ],
    ],
    [
      'malformed encrypted reasoning',
      [
        frame(
          { reasoning_details: [{ type: 'reasoning.encrypted', data: 7 }] },
          'stop',
        ),
      ],
    ],
    [
      'unknown reasoning',
      [
        frame(
          { reasoning_details: [{ type: 'reasoning.future', data: 'x' }] },
          'stop',
        ),
      ],
    ],
    [
      'unsupported returned image',
      [frame({ images: [{ image_url: { url: 'x' } }] }, 'stop')],
    ],
    [
      'changed file hash content',
      [
        frame({ annotations: [FILE] }),
        frame(
          { annotations: [{ type: 'file', file: { hash: 'file-hash' } }] },
          'stop',
        ),
      ],
    ],
    ['missing finish', [frame({ content: 'partial' })]],
  ] as const)('fails %s without producing a completed result', ([_, frames]) =>
    Effect.gen(function* () {
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        response(sse(...frames)),
      );
      const model = openrouterChatModel(CONFIG, { apiKey: 'key', fetch });
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          const turn = yield* model.prepareTurn({ ...REQUEST, tools: TOOLS });
          assert.equal(turn.mode, 'foreground');
          return yield* Stream.runCollect(model.streamTurn(turn));
        }),
      );
      expect(errors(exit)[0].kind).toBe('malformed-output');
      expect(fetch).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect.each([401, 429, 200])(
    'preserves HTTP %s or in-band failure, original code and PDF evidence',
    (status) =>
      Effect.gen(function* () {
        const error = {
          code: status === 200 ? 'server_error' : status,
          message: 'Provider failed',
          metadata: { file_annotations: [FILE] },
        };
        const wire =
          status === 200
            ? sse(frame({ content: 'partial' }), {
                ...IDENTITY,
                error,
                choices: [{ finish_reason: 'error' }],
              })
            : JSON.stringify({ error });
        const fetch = vi.fn<typeof globalThis.fetch>(async () =>
          response(wire, status),
        );
        const model = openrouterChatModel(CONFIG, { apiKey: 'key', fetch });
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const turn = yield* model.prepareTurn(REQUEST);
            assert.equal(turn.mode, 'foreground');
            return yield* model.generateTurn(turn);
          }),
        );
        const failure = errors(exit)[0];
        expect(failure).toMatchObject({
          kind: status === 401 ? 'authentication' : 'provider-rejection',
          message: 'Provider failed',
          requestId: 'request-1',
          cause: error,
          providerEvidence: {
            kind: 'openrouter',
            origin: { protocol: 'openrouter-chat' },
            fileAnnotations: [{ kind: 'file-annotation', hash: 'file-hash' }],
          },
        });
        if (status === 200) expect(failure.responseId).toBe('generation-1');
        expect(failure.providerEvidence?.origin).toEqual({
          protocol: 'openrouter-chat',
          codecVersion: 1,
          requestedModel: CONFIG.requestedModel,
          deployment: CONFIG.deployment,
        });
        expect(fetch).toHaveBeenCalledTimes(1);
      }),
  );

  it.effect.each(['missing DONE', 'invalid JSON', 'connection'] as const)(
    'classifies %s without retry',
    (variant) =>
      Effect.gen(function* () {
        const cause = new Error('Disconnected');
        const fetch = vi.fn<typeof globalThis.fetch>(async () => {
          if (variant === 'connection') throw cause;
          return response(
            variant === 'invalid JSON'
              ? 'data: {broken}\n\n'
              : `data: ${JSON.stringify(frame({ content: 'partial' }, 'stop'))}\n\n`,
          );
        });
        const model = openrouterChatModel(CONFIG, { apiKey: 'key', fetch });
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const turn = yield* model.prepareTurn(REQUEST);
            assert.equal(turn.mode, 'foreground');
            return yield* model.generateTurn(turn);
          }),
        );
        expect(errors(exit)[0].kind).toBe(
          variant === 'connection' ? 'transport' : 'malformed-output',
        );
        expect(fetch).toHaveBeenCalledTimes(1);
      }),
  );

  it.each(['headers', 'body', 'body with distinct cleanup'] as const)(
    'joins cancellation during pending %s',
    async (stage) => {
      let signal: AbortSignal | undefined;
      let release: (() => void) | undefined;
      let body: ReadableStream<Uint8Array> | undefined;
      let cancelled = false;
      let readableProgress = false;
      const cleanup = new Error('Distinct cleanup');
      const fetch = vi.fn<typeof globalThis.fetch>((_url, init) => {
        signal = init?.signal ?? undefined;
        assert(signal);
        if (stage === 'headers')
          return new Promise((_resolve, reject) =>
            signal!.addEventListener('abort', () => reject(signal!.reason), {
              once: true,
            }),
          );
        body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify(frame({ content: 'partial' }))}\n\n`,
              ),
            );
          },
          async cancel() {
            expect(signal!.aborted).toBe(true);
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            cancelled = true;
            if (stage === 'body with distinct cleanup') throw cleanup;
          },
        });
        return Promise.resolve(response(body));
      });
      const model = openrouterChatModel(CONFIG, { apiKey: 'key', fetch });
      const fiber = Effect.runFork(
        Effect.gen(function* () {
          const turn = yield* model.prepareTurn(REQUEST);
          assert.equal(turn.mode, 'foreground');
          yield* Stream.runDrain(
            model.streamTurn(turn).pipe(
              Stream.tap((event) =>
                Effect.sync(() => {
                  if (event.kind === 'delta') readableProgress = true;
                }),
              ),
            ),
          );
        }),
      );
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      if (stage !== 'headers')
        await vi.waitFor(() => {
          expect(body?.locked).toBe(true);
          expect(readableProgress).toBe(true);
        });
      let joined = false;
      const interrupted = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
        joined = true;
        return Effect.runPromise(Fiber.await(fiber));
      });
      await vi.waitFor(() => expect(signal?.aborted).toBe(true));
      if (stage !== 'headers') {
        await vi.waitFor(() => expect(release).toBeDefined());
        expect(joined).toBe(false);
        release!();
      }
      const exit = await interrupted;
      assert(Exit.isFailure(exit));
      expect(exit.cause.reasons.some(Cause.isInterruptReason)).toBe(true);
      if (stage === 'body with distinct cleanup')
        expect(
          exit.cause.reasons.some(
            (reason) => Cause.isDieReason(reason) && reason.defect === cleanup,
          ),
        ).toBe(true);
      if (stage !== 'headers') {
        expect(cancelled).toBe(true);
        expect(body?.locked).toBe(false);
      }
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.effect(
    'preserves the original malformed frame and a distinct reader cleanup defect',
    () =>
      Effect.gen(function* () {
        const cleanup = new Error('Cancellation failed');
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify(frame({ content: 'partial' }))}\n\ndata: {bad}\n\n`,
              ),
            );
          },
          cancel() {
            throw cleanup;
          },
        });
        const fetch = vi.fn<typeof globalThis.fetch>(async () =>
          response(body),
        );
        const model = openrouterChatModel(CONFIG, { apiKey: 'key', fetch });
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const turn = yield* model.prepareTurn(REQUEST);
            assert.equal(turn.mode, 'foreground');
            return yield* Stream.runDrain(model.streamTurn(turn));
          }),
        );
        expect(errors(exit)[0]).toMatchObject({
          kind: 'malformed-output',
          responseId: 'generation-1',
          requestId: 'request-1',
        });
        assert(Exit.isFailure(exit));
        expect(
          exit.cause.reasons.some(
            (reason) => Cause.isDieReason(reason) && reason.defect === cleanup,
          ),
        ).toBe(true);
        expect(body.locked).toBe(false);
      }),
  );
});
