// Node imports
import assert from 'node:assert/strict';

// Third-party imports
import { openaiChatModel } from '@texra-ai/llm/openai-chat';
import {
  openaiResponsesContinuation,
  openaiResponsesModel,
} from '@texra-ai/llm/openai-responses';
import { ContinuationSchema } from '@texra-ai/llm/turn';
import { Cause, Effect, Fiber, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  BackgroundEvent,
  ModelError,
  OpenAIResponsesConfiguration,
  RemoteOperation,
  TurnEvent,
  TurnRequest,
} from '@texra-ai/llm/turn';

const CONFIG: OpenAIResponsesConfiguration = {
  protocol: 'openai-responses',
  requestedModel: 'synthetic-model',
  deployment: {
    endpoint: 'https://synthetic.invalid/v1',
    credentialScope: 'synthetic-account',
  },
  supportsTemperature: true,
  background: 'unsupported',
  defaults: {
    temperature: 0.7,
    maxOutputTokens: 100,
    store: false,
    parallelToolCalls: true,
    reasoning: { effort: 'high', mode: 'pro', summary: 'auto' },
    serviceTier: 'fast',
  },
};
const REQUEST: TurnRequest = {
  messages: [
    { role: 'user', content: [{ kind: 'text', text: 'Compare two files.' }] },
  ],
  tools: [
    {
      name: 'read_file',
      description: 'Read a file.',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  ],
};
const OPERATION: RemoteOperation = {
  origin: {
    protocol: 'openai-responses',
    codecVersion: 1,
    requestedModel: CONFIG.requestedModel,
    deployment: CONFIG.deployment,
  },
  providerResponseId: 'resp_1',
  afterSequence: null,
};
const REASONING = {
  type: 'reasoning',
  id: 'rs_1',
  status: 'completed',
  summary: [
    { type: 'summary_text', text: 'plan A' },
    { type: 'summary_text', text: 'plan B' },
  ],
  content: [{ type: 'reasoning_text', text: 'reported reasoning' }],
  encrypted_content: 'enc_complete',
};
const MESSAGE = {
  type: 'message',
  role: 'assistant',
  id: 'msg_1',
  status: 'completed',
  phase: 'commentary',
  content: [
    { type: 'output_text', text: 'I will check.', annotations: [] },
    { type: 'output_text', text: 'Then compare.', annotations: [] },
  ],
};
const CALLS = ['a', 'b'].map((path, index) => ({
  type: 'function_call',
  id: `fc_${index + 1}`,
  call_id: `call_${index + 1}`,
  status: 'completed',
  name: 'read_file',
  arguments: JSON.stringify({ path }),
}));
const OUTPUT = [REASONING, MESSAGE, ...CALLS];

function snapshot(
  output: object[],
  overrides: Record<string, unknown> = {},
): object {
  return {
    id: 'resp_1',
    object: 'response',
    model: 'returned-model',
    status: 'completed',
    output,
    usage: null,
    ...overrides,
  };
}
function events(output: object[], final: object = snapshot(output)): object[] {
  return [
    {
      type: 'response.created',
      response: snapshot([], { status: 'in_progress' }),
    },
    ...output.flatMap((item, index) => [
      { type: 'response.output_item.added', output_index: index, item },
      { type: 'response.output_item.done', output_index: index, item },
    ]),
    { type: 'response.completed', response: final },
  ];
}
function sse(frames: object[], startingAt = 0): string {
  return frames
    .map(
      (frame, sequence_number) =>
        `data: ${JSON.stringify({ ...frame, sequence_number: startingAt + sequence_number })}\n\n`,
    )
    .join('');
}
function response(frames: object[]): Response {
  return new Response(sse(frames), {
    headers: {
      'content-type': 'text/event-stream',
      'x-request-id': 'request_1',
    },
  });
}
function modelWith(fetch: typeof globalThis.fetch, configuration = CONFIG) {
  return openaiResponsesModel(configuration, {
    apiKey: 'synthetic-not-a-secret',
    fetch,
  });
}

describe('native OpenAI Responses protocol', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each(['Chat', 'Responses'] as const)(
    '%s rejects ambient header overrides and disables SDK diagnostic logging',
    async (protocol) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response('data: malformed-provider-data\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
      const construct = () =>
        protocol === 'Responses'
          ? modelWith(fetch)
          : openaiChatModel(
              {
                protocol: 'openai-chat',
                requestedModel: CONFIG.requestedModel,
                deployment: CONFIG.deployment,
                defaults: {
                  temperature: 0,
                  maxOutputTokens: 100,
                  parallelToolCalls: true,
                },
              },
              { apiKey: 'synthetic-not-a-secret', fetch },
            );
      vi.stubEnv(
        'OPENAI_CUSTOM_HEADERS',
        'Authorization: Bearer other-account',
      );
      expect(construct).toThrow('Ambient OpenAI');
      expect(fetch).not.toHaveBeenCalled();
      vi.stubEnv('OPENAI_CUSTOM_HEADERS', '');
      vi.stubEnv('OPENAI_LOG', 'debug');
      const logs = (['debug', 'log', 'info', 'warn', 'error'] as const).map(
        (method) => vi.spyOn(console, method).mockImplementation(() => {}),
      );
      const model = construct();
      const turn = await Effect.runPromise(model.prepareTurn(REQUEST));
      assert(turn.mode === 'foreground');
      expect(
        await Effect.runPromise(Effect.flip(model.generateTurn(turn))),
      ).toMatchObject({ kind: 'malformed-output' });
      expect(fetch).toHaveBeenCalledTimes(1);
      for (const log of logs) expect(log).not.toHaveBeenCalled();
    },
  );

  it('joins submission detach, resumes only the accepted job and constructs continuation from admitted input', async () => {
    let finishCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      finishCancellation = resolve;
    });
    const cancelBody = vi.fn(() => cancellation);
    const submissionFinished = vi.fn();
    const acceptance = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            sse([
              {
                type: 'response.created',
                response: snapshot([], { status: 'queued' }),
              },
            ]),
          ),
        );
      },
      cancel: cancelBody,
    });
    const observedFrames = [
      {
        type: 'response.in_progress',
        response: snapshot([], { status: 'in_progress' }),
      },
      {
        type: 'response.output_text.delta',
        output_index: 1,
        item_id: 'msg_1',
        delta: 'Progress only',
      },
      { type: 'response.completed', response: snapshot(OUTPUT) },
    ];
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async (url, init) => {
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body));
          if (body.background)
            return new Response(acceptance, {
              headers: { 'content-type': 'text/event-stream' },
            });
          return response(events([MESSAGE]));
        }
        const after = Number(
          new URL(String(url)).searchParams.get('starting_after'),
        );
        return new Response(sse(observedFrames.slice(after), after + 1), {
          headers: { 'content-type': 'text/event-stream' },
        });
      });
    const model = modelWith(fetch, { ...CONFIG, background: 'supported' });
    assert(model.background);
    const turn = await Effect.runPromise(
      model.prepareTurn({
        ...REQUEST,
        mode: 'background',
        store: true,
        system: 'policy',
      }),
    );
    assert(turn.mode === 'background');
    const fiber = Effect.runFork(
      model.background
        .submit(turn)
        .pipe(Effect.tap(() => Effect.sync(submissionFinished))),
    );
    await vi.waitFor(() => expect(cancelBody).toHaveBeenCalledTimes(1));
    expect(submissionFinished).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    finishCancellation();
    const accepted = await Effect.runPromise(Fiber.join(fiber));
    assert(accepted.kind === 'accepted');
    expect(accepted.operation).toEqual({
      origin: {
        protocol: turn.protocol,
        codecVersion: turn.codecVersion,
        requestedModel: turn.requestedModel,
        deployment: turn.deployment,
      },
      providerResponseId: 'resp_1',
      afterSequence: 0,
    });
    const policy = { deadlineAtMs: Date.now() + 60_000 };
    const initial = await Effect.runPromise(
      Stream.runCollect(
        model.background
          .observe(accepted.operation, policy)
          .pipe(Stream.take(1)),
      ),
    );
    expect(initial[0]).toMatchObject({ kind: 'identified', afterSequence: 1 });
    const resumed = await Effect.runPromise(
      Stream.runCollect(
        model.background.observe(
          { ...accepted.operation, afterSequence: 1 },
          policy,
        ),
      ),
    );
    expect(resumed.map((event) => [event.kind, event.afterSequence])).toEqual([
      ['delta', 2],
      ['completed', 3],
    ]);
    const terminal = resumed.at(-1);
    assert(terminal?.kind === 'completed');
    expect(terminal.result.continuation).toBeUndefined();
    const continuation = await Effect.runPromise(
      openaiResponsesContinuation(turn, terminal.result),
    );
    assert(continuation && 'responseId' in continuation.anchor);
    expect(continuation).toMatchObject({
      coveredMessages: 2,
      anchor: { responseId: 'resp_1', coveredItems: 5 },
    });
    const messages: TurnRequest['messages'] = [
      ...turn.messages,
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
            content: [{ kind: 'text', text: 'b' }],
          },
        ],
      },
    ];
    const nextRequest = {
      ...REQUEST,
      messages,
      system: 'policy',
      continuation,
    };
    const next = await Effect.runPromise(model.prepareTurn(nextRequest));
    assert(next.mode === 'foreground');
    await Effect.runPromise(model.generateTurn(next));
    expect(
      JSON.parse(String(fetch.mock.calls.at(-1)?.[1]?.body)),
    ).toMatchObject({
      previous_response_id: 'resp_1',
      instructions: 'policy',
      input: [
        { type: 'function_call_output', call_id: 'call_1', output: 'a' },
        { type: 'function_call_output', call_id: 'call_2', output: 'Error: b' },
      ],
    });
    for (const request of [
      { ...nextRequest, system: 'changed' },
      {
        ...nextRequest,
        continuation: ContinuationSchema.parse({
          ...continuation,
          anchor: { ...continuation.anchor, coveredItems: 4 },
        }),
      },
    ])
      expect(
        (await Effect.runPromise(Effect.flip(model.prepareTurn(request)))).kind,
      ).toBe('invalid-request');
    const retrievals = fetch.mock.calls.filter(
      ([, init]) => init?.method === 'GET',
    );
    expect(retrievals).toHaveLength(2);
    expect(
      retrievals.map(([url]) =>
        new URL(String(url)).searchParams.get('starting_after'),
      ),
    ).toEqual(['0', '1']);
    for (const [url] of retrievals)
      expect(String(url)).toContain('reasoning.encrypted_content');
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('retains learned acceptance in an unexpected cleanup defect', async () => {
    const cleanupFailure = new Error('cancel rejected');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            sse([
              {
                type: 'response.created',
                response: snapshot([], { status: 'in_progress' }),
              },
            ]),
          ),
        );
      },
      cancel() {
        return Promise.reject(cleanupFailure);
      },
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(body, {
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    const model = modelWith(fetch, { ...CONFIG, background: 'supported' });
    assert(model.background);
    const turn = await Effect.runPromise(
      model.prepareTurn({ ...REQUEST, mode: 'background' }),
    );
    assert(turn.mode === 'background');
    const exit = await Effect.runPromise(
      Effect.exit(model.background.submit(turn)),
    );
    assert(exit._tag === 'Failure');
    const defect = exit.cause.reasons.find(Cause.isDieReason);
    expect(defect?.defect).toMatchObject({
      operation: { providerResponseId: 'resp_1', afterSequence: 0 },
      cause: cleanupFailure,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['completed', 'stop'],
    ['incomplete', 'length'],
  ])(
    'returns immediate %s output without requiring stored history',
    async (status, finishReason) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        response([
          {
            type: `response.${status}`,
            response: snapshot([{ ...MESSAGE, status }], {
              status,
              ...(status === 'incomplete'
                ? { incomplete_details: { reason: 'max_output_tokens' } }
                : {}),
            }),
          },
        ]),
      );
      const model = modelWith(fetch, { ...CONFIG, background: 'supported' });
      assert(model.background);
      const turn = await Effect.runPromise(
        model.prepareTurn({ ...REQUEST, mode: 'background', store: false }),
      );
      assert(turn.mode === 'background');
      const submitted = await Effect.runPromise(model.background.submit(turn));
      assert(submitted.kind === 'completed');
      expect(submitted.result).toMatchObject({
        finishReason,
        providerResponseId: 'resp_1',
      });
      expect(submitted.result).not.toHaveProperty('continuation');
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
        background: true,
        stream: true,
        store: false,
      });
    },
  );

  it.each(['submit', 'cancel'] as const)(
    'interrupts a pending %s HTTP read without reporting acceptance or cancellation',
    async (operationName) => {
      let signal: AbortSignal | null | undefined;
      const cancelBody = vi.fn();
      const body = new ReadableStream<Uint8Array>({ cancel: cancelBody });
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(async (_url, init) => {
          signal = init?.signal;
          return new Response(body, {
            headers: {
              'content-type':
                operationName === 'submit'
                  ? 'text/event-stream'
                  : 'application/json',
            },
          });
        });
      const model = modelWith(fetch, { ...CONFIG, background: 'supported' });
      assert(model.background);
      const turn = await Effect.runPromise(
        model.prepareTurn({ ...REQUEST, mode: 'background' }),
      );
      assert(turn.mode === 'background');
      const completed = vi.fn();
      const task =
        operationName === 'submit'
          ? model.background.submit(turn).pipe(Effect.asVoid)
          : model.background.cancel(OPERATION).pipe(Effect.asVoid);
      const fiber = Effect.runFork(
        task.pipe(Effect.tap(() => Effect.sync(completed))),
      );
      await vi.waitFor(() => expect(body.locked).toBe(true));
      await Effect.runPromise(Fiber.interrupt(fiber));
      expect(signal?.aborted).toBe(true);
      expect(completed).not.toHaveBeenCalled();
      if (operationName === 'submit')
        expect(cancelBody).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['missing', 'failed', 'not-found'] as const)(
    'does not recreate work or advance a terminal cursor after %s observation',
    async (outcome) => {
      const frames = [
        {
          type: 'response.created',
          response: snapshot([], { status: 'in_progress' }),
        },
      ];
      if (outcome === 'failed')
        frames.push({
          type: 'response.failed',
          response: snapshot([], {
            status: 'failed',
            error: { code: 'server_error', message: 'Original job failure' },
          }),
        });
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        outcome === 'not-found'
          ? new Response(
              JSON.stringify({
                error: { message: 'Job no longer retrievable' },
              }),
              {
                status: 404,
                headers: { 'content-type': 'application/json' },
              },
            )
          : response(frames),
      );
      const model = modelWith(fetch, { ...CONFIG, background: 'supported' });
      assert(model.background);
      const observed: BackgroundEvent[] = [];
      const failure = await Effect.runPromise(
        Effect.flip(
          Stream.runForEach(
            model.background.observe(OPERATION, {
              deadlineAtMs: Date.now() + 60_000,
            }),
            (event) =>
              Effect.sync(() => {
                observed.push(event);
              }),
          ),
        ),
      );
      expect(failure).toMatchObject({
        kind: outcome === 'missing' ? 'malformed-output' : 'provider-rejection',
        operation: OPERATION,
        responseId: 'resp_1',
      });
      if (outcome === 'failed')
        expect(failure.message).toBe('Original job failure');
      expect(observed.map((event) => event.afterSequence)).toEqual(
        outcome === 'not-found' ? [] : [0],
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0]?.[1]?.method).toBe('GET');
    },
  );

  it.each(['same', 'omitted', 'changed', 'sparse'] as const)(
    'preserves observed completed evidence against a %s terminal snapshot',
    async (variant) => {
      let output: object[] = [REASONING];
      if (variant === 'omitted')
        output = [
          {
            type: REASONING.type,
            id: REASONING.id,
            summary: REASONING.summary,
            content: REASONING.content,
          },
        ];
      if (variant === 'changed')
        output = [{ ...REASONING, encrypted_content: 'contradictory_opaque' }];
      if (variant === 'sparse') output = [];
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        response([
          {
            type: 'response.in_progress',
            response: snapshot([], { status: 'in_progress' }),
          },
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: REASONING,
          },
          { type: 'response.completed', response: snapshot(output) },
        ]),
      );
      const model = modelWith(fetch, { ...CONFIG, background: 'supported' });
      assert(model.background);
      const seen: BackgroundEvent[] = [];
      const exit = await Effect.runPromise(
        Effect.exit(
          Stream.runForEach(
            model.background.observe(OPERATION, {
              deadlineAtMs: Date.now() + 60_000,
            }),
            (event) =>
              Effect.sync(() => {
                seen.push(event);
              }),
          ),
        ),
      );
      if (variant === 'changed' || variant === 'sparse') {
        assert(exit._tag === 'Failure');
        expect(
          exit.cause.reasons.find(Cause.isFailReason)?.error,
        ).toMatchObject({ kind: 'malformed-output' });
        expect(seen.map((event) => event.afterSequence)).toEqual([0, 1]);
      } else {
        expect(exit._tag).toBe('Success');
        expect(seen.at(-1)).toMatchObject({
          kind: 'completed',
          afterSequence: 2,
          result: {
            content: [
              {
                kind: 'reasoning',
                evidence: {
                  encryptedContent: 'enc_complete',
                  status: 'completed',
                  itemId: 'rs_1',
                },
              },
            ],
          },
        });
      }
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['foreground', 'observation'] as const)(
    'settles %s at the semantic terminal event while the HTTP body remains open',
    async (mode) => {
      const cancelBody = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              sse([
                {
                  type: 'response.completed',
                  response: snapshot([MESSAGE]),
                },
              ]),
            ),
          );
        },
        cancel: cancelBody,
      });
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response(body, {
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
      const model = modelWith(fetch, { ...CONFIG, background: 'supported' });
      assert(model.background);
      const turn = await Effect.runPromise(model.prepareTurn(REQUEST));
      assert(turn.mode === 'foreground');
      const stream: Stream.Stream<TurnEvent | BackgroundEvent, ModelError> =
        mode === 'foreground'
          ? model.streamTurn(turn)
          : model.background.observe(OPERATION, {
              deadlineAtMs: Date.now() + 60_000,
            });
      const seen = await Effect.runPromise(Stream.runCollect(stream));
      const completed = seen.at(-1);
      expect(completed).toMatchObject({
        kind: 'completed',
        result: { providerResponseId: 'resp_1', finishReason: 'stop' },
      });
      if (mode === 'observation')
        expect(completed).toHaveProperty('afterSequence', 0);
      expect(cancelBody).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['headers', 'body'] as const)(
    'keeps the original deadline while waiting for %s and before another request',
    async (phase) => {
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const cancelled = vi.fn();
      const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
      let sendHeaders!: () => void;
      const headers = new Promise<void>((resolve) => {
        sendHeaders = resolve;
      });
      let signal: AbortSignal | null | undefined;
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(async (_url, init) => {
          signal = init?.signal;
          markStarted();
          await headers;
          return new Response(body, {
            headers: { 'content-type': 'text/event-stream' },
          });
        });
      const model = modelWith(fetch, { ...CONFIG, background: 'supported' });
      assert(model.background);
      const background = model.background;
      await Effect.runPromise(
        Effect.gen(function* () {
          const observation = Stream.runDrain(
            background.observe(OPERATION, { deadlineAtMs: 100 }),
          );
          const fiber = yield* Effect.forkChild(Effect.flip(observation));
          yield* Effect.promise(() => started);
          yield* TestClock.adjust('40 millis');
          if (phase === 'body') {
            sendHeaders();
            yield* Effect.promise(() =>
              vi.waitFor(() => expect(body.locked).toBe(true)),
            );
          }
          yield* TestClock.adjust('60 millis');
          expect((yield* Fiber.join(fiber)).kind).toBe('observation-deadline');
          expect(signal?.aborted).toBe(true);
          expect(cancelled).toHaveBeenCalledTimes(phase === 'body' ? 1 : 0);
          expect((yield* Effect.flip(observation)).kind).toBe(
            'observation-deadline',
          );
          expect(fetch).toHaveBeenCalledTimes(1);
        }).pipe(Effect.provide(TestClock.layer())),
      );
      sendHeaders();
      expect(String(fetch.mock.calls[0]?.[0])).not.toContain('starting_after');
    },
  );

  it.each([
    ['cancelled', 'confirmed-cancelled'],
    ['completed', 'observed-terminal'],
    ['failed', 'observed-terminal'],
    ['incomplete', 'observed-terminal'],
    ['queued', 'unconfirmed'],
    ['in_progress', 'unconfirmed'],
  ])(
    'reports cancellation status %s as %s without claiming ordering',
    async (status, kind) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response(JSON.stringify(snapshot([], { status })), {
          headers: { 'content-type': 'application/json' },
        }),
      );
      const model = modelWith(fetch, { ...CONFIG, background: 'supported' });
      assert(model.background);
      const result = await Effect.runPromise(
        model.background.cancel({ ...OPERATION, afterSequence: 0 }),
      );
      expect(result).toMatchObject({
        kind,
        providerResponseId: 'resp_1',
        returnedModel: 'returned-model',
      });
      expect(result).not.toHaveProperty('result');
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(fetch.mock.calls[0]?.[0])).toContain(
        '/responses/resp_1/cancel',
      );
    },
  );

  it('preserves grouped completed items, encrypted evidence and original tool IDs through a sparse terminal snapshot', async () => {
    const frames = events(
      OUTPUT,
      snapshot(
        [
          {
            type: REASONING.type,
            id: REASONING.id,
            summary: REASONING.summary,
            content: REASONING.content,
          },
          { ...CALLS[0], arguments: '{ "path" : "a" }' },
        ],
        {
          usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
        },
      ),
    );
    frames[1] = {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        ...REASONING,
        status: 'in_progress',
        encrypted_content: 'enc_partial',
      },
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(frames))
      .mockResolvedValueOnce(
        response(events([{ ...MESSAGE, id: 'msg_2', phase: 'final_answer' }])),
      );
    const model = modelWith(fetch);
    const turn = await Effect.runPromise(model.prepareTurn(REQUEST));
    assert(turn.mode === 'foreground');
    const collected = await Effect.runPromise(
      Stream.runCollect(model.streamTurn(turn)),
    );
    expect(collected[0]).toMatchObject({
      kind: 'identified',
      providerResponseId: 'resp_1',
      returnedModel: 'returned-model',
    });
    expect(collected).toHaveLength(2);
    const terminal = collected[1];
    if (terminal?.kind !== 'completed')
      throw new Error('Missing completed response');
    expect(terminal.result).toMatchObject({
      finishReason: 'tool-calls',
      usage: { totalTokens: 15 },
      content: [
        {
          kind: 'reasoning',
          summary: [
            { kind: 'text', text: 'plan A' },
            { kind: 'text', text: 'plan B' },
          ],
          content: [{ kind: 'text', text: 'reported reasoning' }],
          evidence: { itemId: 'rs_1', encryptedContent: 'enc_complete' },
        },
        {
          kind: 'message',
          content: [
            { kind: 'text', text: 'I will check.' },
            { kind: 'text', text: 'Then compare.' },
          ],
          evidence: { itemId: 'msg_1', phase: 'commentary' },
        },
        {
          kind: 'local-call',
          providerCallId: 'call_1',
          evidence: { itemId: 'fc_1' },
          arguments: { path: 'a' },
        },
        {
          kind: 'local-call',
          providerCallId: 'call_2',
          evidence: { itemId: 'fc_2' },
          arguments: { path: 'b' },
        },
      ],
    });
    const next = await Effect.runPromise(
      model
        .prepareTurn({
          ...REQUEST,
          messages: [
            ...REQUEST.messages,
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
                  content: [{ kind: 'text', text: 'file text' }],
                },
                {
                  callOrdinal: 1,
                  status: 'error',
                  content: [{ kind: 'text', text: 'missing' }],
                },
              ],
            },
          ],
        })
        .pipe(
          Effect.flatMap((turn) => {
            assert(turn.mode === 'foreground');
            return model.generateTurn(turn);
          }),
        ),
    );
    expect(next.content[0]).toMatchObject({
      kind: 'message',
      evidence: { itemId: 'msg_2', phase: 'final_answer' },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).input).toEqual([
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'Compare two files.' }],
      },
      ...OUTPUT,
      { type: 'function_call_output', call_id: 'call_1', output: 'file text' },
      {
        type: 'function_call_output',
        call_id: 'call_2',
        output: 'Error: missing',
      },
    ]);
  });

  it('freezes selected controls and distinguishes absent controls, explicit null and numeric zero', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => response(events([MESSAGE])));
    const config = { ...CONFIG, defaults: { ...CONFIG.defaults } };
    const model = modelWith(fetch, config);
    const turn = await Effect.runPromise(
      model.prepareTurn({
        ...REQUEST,
        temperature: 0,
        parallelToolCalls: false,
        toolChoice: { name: 'read_file' },
      }),
    );
    config.defaults.reasoning = null;
    config.defaults.serviceTier = null;
    assert(turn.mode === 'foreground');
    await Effect.runPromise(model.generateTurn(turn));
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      temperature: 0,
      parallel_tool_calls: false,
      tool_choice: { type: 'function', name: 'read_file' },
      reasoning: { effort: 'high', mode: 'pro', summary: 'auto' },
      service_tier: 'fast',
      store: false,
      background: false,
      include: ['reasoning.encrypted_content'],
    });
    await Effect.runPromise(
      model
        .prepareTurn({ ...REQUEST, reasoning: null, serviceTier: null })
        .pipe(
          Effect.flatMap((turn) => {
            assert(turn.mode === 'foreground');
            return model.generateTurn(turn);
          }),
        ),
    );
    const omitted = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    expect(omitted.reasoning).toBeUndefined();
    expect(omitted.service_tier).toBeUndefined();
    const withoutTemperature = modelWith(fetch, {
      ...CONFIG,
      supportsTemperature: false,
      defaults: { ...CONFIG.defaults, temperature: null },
    });
    expect(
      (
        await Effect.runPromise(
          Effect.flip(
            withoutTemperature.prepareTurn({ ...REQUEST, temperature: 0 }),
          ),
        )
      ).kind,
    ).toBe('unsupported');
    await Effect.runPromise(
      withoutTemperature.prepareTurn(REQUEST).pipe(
        Effect.flatMap((turn) => {
          assert(turn.mode === 'foreground');
          return withoutTemperature.generateTurn(turn);
        }),
      ),
    );
    expect(
      JSON.parse(String(fetch.mock.calls[2]?.[1]?.body)).temperature,
    ).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(
      await Effect.runPromise(
        Effect.flip(
          model.prepareTurn({
            ...REQUEST,
            continuation: {
              origin: { ...OPERATION.origin, protocol: 'google-interactions' },
              coveredMessages: 1,
              prefixFingerprint: 'a'.repeat(64),
              anchor: { interactionId: 'int_1', coveredSteps: 1 },
            },
          }),
        ),
      ),
    ).toMatchObject({ kind: 'unsupported' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('returns explicit length-limited text without dispatchable unfinished calls', async () => {
    const final = snapshot([{ ...MESSAGE, status: 'incomplete' }], {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      response([
        {
          type: 'response.created',
          response: snapshot([], { status: 'in_progress' }),
        },
        { type: 'response.incomplete', response: final },
      ]),
    );
    const model = modelWith(fetch);
    const result = await Effect.runPromise(
      model.prepareTurn(REQUEST).pipe(
        Effect.flatMap((turn) => {
          assert(turn.mode === 'foreground');
          return model.generateTurn(turn);
        }),
      ),
    );
    expect(result).toMatchObject({
      finishReason: 'length',
      usage: null,
      content: [{ kind: 'message', evidence: { status: 'incomplete' } }],
    });
  });

  it.each([
    {
      name: 'changed encrypted content',
      final: snapshot([{ ...REASONING, encrypted_content: 'changed' }]),
    },
    {
      name: 'changed message phase',
      final: snapshot([REASONING, { ...MESSAGE, phase: 'final_answer' }]),
    },
    {
      name: 'reordered completed items',
      final: snapshot([MESSAGE, REASONING]),
    },
    {
      name: 'invalid local-call arguments',
      final: snapshot([{ ...CALLS[0], arguments: '{' }]),
      output: [{ ...CALLS[0], arguments: '{' }],
    },
    {
      name: 'changed local-call ID',
      final: snapshot([CALLS[0]!]),
      output: [CALLS[0]!],
      added: { ...CALLS[0], call_id: 'original_call' },
    },
    {
      name: 'changed local-call name',
      final: snapshot([CALLS[0]!]),
      output: [CALLS[0]!],
      added: { ...CALLS[0], name: 'original_name' },
    },
    {
      name: 'text progress on a local call',
      final: snapshot([CALLS[0]!]),
      output: [CALLS[0]!],
      progress: {
        type: 'response.output_text.delta',
        output_index: 0,
        item_id: 'fc_1',
        delta: 'Not message content',
      },
    },
    {
      name: 'unfinished local call',
      final: snapshot([{ ...CALLS[0], status: 'incomplete' }]),
      output: [{ ...CALLS[0], status: 'incomplete' }],
    },
    {
      name: 'unsupported annotations',
      final: snapshot([
        {
          ...MESSAGE,
          content: [
            {
              type: 'output_text',
              text: 'text',
              annotations: [
                { type: 'url_citation', url: 'https://example.invalid' },
              ],
            },
          ],
        },
      ]),
      output: [],
    },
  ])(
    'rejects $name without a completed result',
    async ({ final, output, added, progress }) => {
      const frames = events(output ?? OUTPUT, final);
      if (added)
        frames[1] = {
          type: 'response.output_item.added',
          output_index: 0,
          item: added,
        };
      if (progress) frames.splice(2, 0, progress);
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(response(frames));
      const model = modelWith(fetch);
      const completed = vi.fn();
      const delta = vi.fn();
      const failure = await Effect.runPromise(
        Effect.flip(
          model.prepareTurn(REQUEST).pipe(
            Effect.flatMap((turn) => {
              assert(turn.mode === 'foreground');
              return Stream.runForEach(model.streamTurn(turn), (event) =>
                Effect.sync(() => {
                  if (event.kind === 'completed') completed();
                  if (event.kind === 'delta') delta();
                }),
              );
            }),
          ),
        ),
      );
      expect(failure).toMatchObject({
        kind: 'malformed-output',
        responseId: 'resp_1',
        requestId: 'request_1',
      });
      expect(completed).not.toHaveBeenCalled();
      expect(delta).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves a terminal provider failure even when output remains unfinished', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      response([
        {
          type: 'response.created',
          response: snapshot([], { status: 'in_progress' }),
        },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { ...MESSAGE, status: 'in_progress' },
        },
        {
          type: 'response.failed',
          response: snapshot([], {
            status: 'failed',
            error: {
              code: 'server_error',
              message: 'Original provider failure',
            },
          }),
        },
      ]),
    );
    const model = modelWith(fetch);
    const failure = await Effect.runPromise(
      Effect.flip(
        model.prepareTurn(REQUEST).pipe(
          Effect.flatMap((turn) => {
            assert(turn.mode === 'foreground');
            return model.generateTurn(turn);
          }),
        ),
      ),
    );
    expect(failure).toMatchObject({
      kind: 'provider-rejection',
      message: 'Original provider failure',
      responseId: 'resp_1',
      requestId: 'request_1',
      model: 'returned-model',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('interrupts a pending body read after publishing identity and joins cleanup', async () => {
    let signal: AbortSignal | null | undefined;
    const cancel = vi.fn();
    const identified = vi.fn();
    const completed = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            sse([
              {
                type: 'response.created',
                response: snapshot([], { status: 'in_progress' }),
              },
            ]),
          ),
        );
      },
      cancel,
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async (_url, init) => {
        signal = init?.signal;
        return new Response(body, {
          headers: { 'content-type': 'text/event-stream' },
        });
      });
    const model = modelWith(fetch);
    const turn = await Effect.runPromise(model.prepareTurn(REQUEST));
    assert(turn.mode === 'foreground');
    const fiber = Effect.runFork(
      Stream.runForEach(model.streamTurn(turn), (event) =>
        Effect.sync(() => {
          if (event.kind === 'identified') identified();
          if (event.kind === 'completed') completed();
        }),
      ),
    );
    await vi.waitFor(() => expect(identified).toHaveBeenCalledTimes(1));
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(completed).not.toHaveBeenCalled();
  });
});
