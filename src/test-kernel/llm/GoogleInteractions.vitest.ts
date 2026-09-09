// Node imports
import assert from 'node:assert/strict';

// Third-party imports
import { it as effectIt } from '@effect/vitest';
import { RemoteOperationSchema } from '@texra-ai/llm/turn';
import { googleInteractionsModel } from '@texra-ai/llm/google-interactions';
import { Cause, Deferred, Effect, Fiber, Stream, Redacted } from 'effect';
import { TestClock } from 'effect/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelError, TurnRequest, TurnResult } from '@texra-ai/llm/turn';

function model(
  store = true,
  supportsInputTokenEstimation = true,
  background: 'supported' | 'unsupported' = 'unsupported',
) {
  return googleInteractionsModel(
    {
      protocol: 'google-interactions',
      requestedModel: 'gemini-test',
      supportsInputTokenEstimation,
      background,
      deployment: {
        endpoint: 'https://synthetic.invalid',
        credentialScope: 'test-account',
      },
      defaults: { maxOutputTokens: 2048, store, thinkingLevel: 'high' },
    },
    { apiKey: Redacted.make('synthetic-key') },
  );
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function backgroundFixture() {
  return Effect.gen(function* () {
    const configured = model(true, true, 'supported');
    const turn = yield* configured.prepareTurn({
      ...request(),
      mode: 'background',
    });
    assert(
      turn.mode === 'background' && turn.protocol === 'google-interactions',
    );
    assert(configured.background);
    const operation = RemoteOperationSchema.parse({
      origin: {
        protocol: turn.protocol,
        codecVersion: turn.codecVersion,
        requestedModel: turn.requestedModel,
        deployment: turn.deployment,
      },
      providerResponseId: 'int_1',
      afterSequence: null,
    });
    return { configured, turn, background: configured.background, operation };
  });
}

function request(): TurnRequest {
  return {
    system: 'Use both tools.',
    messages: [
      {
        role: 'user',
        content: [
          { kind: 'text', text: 'go' },
          { kind: 'text', text: 'Image: figures/panel.png' },
          {
            kind: 'image',
            mimeType: 'image/png',
            base64: 'AA==',
            detail: 'high',
          },
          { kind: 'text', text: 'Audio: sound.mp3' },
          { kind: 'audio', mimeType: 'audio/mp3', base64: 'TQ==' },
          { kind: 'text', text: 'Video: clip.mp4' },
          { kind: 'video', mimeType: 'video/mp4', base64: 'Vg==' },
          { kind: 'text', text: 'Document: paper.pdf' },
          { kind: 'document', mimeType: 'application/pdf', base64: 'UA==' },
          { kind: 'text', text: 'Document: empty.csv' },
          { kind: 'document', mimeType: 'text/csv', base64: '' },
        ],
      },
    ],
    tools: [
      {
        name: 'search',
        description: 'Search',
        parameters: {
          type: 'object',
          properties: { q: { type: 'string' } },
          required: ['q'],
        },
      },
      {
        name: 'fetch',
        description: 'Fetch',
        parameters: {
          type: 'object',
          properties: { u: { type: 'string' } },
          required: ['u'],
        },
      },
    ],
  };
}

function signedEvents(
  includeSummary = true,
  toolUseTokens?: number,
): Array<Record<string, unknown>> {
  return [
    {
      event_type: 'interaction.created',
      interaction: {
        id: 'int_1',
        status: 'in_progress',
        model: 'gemini-returned',
      },
    },
    { event_type: 'step.start', index: 0, step: { type: 'thought' } },
    ...(includeSummary
      ? [
          {
            event_type: 'step.delta',
            index: 0,
            delta: {
              type: 'thought_summary',
              content: { type: 'text', text: 'plan' },
            },
          },
        ]
      : []),
    {
      event_type: 'step.delta',
      index: 0,
      delta: { type: 'thought_signature', signature: 'sig_b' },
    },
    { event_type: 'step.stop', index: 0 },
    { event_type: 'step.start', index: 1, step: { type: 'model_output' } },
    {
      event_type: 'step.delta',
      index: 1,
      delta: { type: 'text', text: 'thinking done' },
    },
    { event_type: 'step.stop', index: 1 },
    {
      event_type: 'step.start',
      index: 2,
      step: {
        type: 'function_call',
        id: 'call_1',
        name: 'search',
        arguments: {},
      },
    },
    {
      event_type: 'step.delta',
      index: 2,
      delta: { type: 'arguments_delta', arguments: '{"q":' },
    },
    {
      event_type: 'step.delta',
      index: 2,
      delta: { type: 'arguments_delta', arguments: '"x"}' },
    },
    { event_type: 'step.stop', index: 2 },
    {
      event_type: 'step.start',
      index: 3,
      step: {
        type: 'function_call',
        id: 'call_2',
        name: 'fetch',
        arguments: {},
      },
    },
    {
      event_type: 'step.delta',
      index: 3,
      delta: { type: 'arguments_delta', arguments: '{"u":"y"}' },
    },
    { event_type: 'step.stop', index: 3 },
    {
      event_type: 'interaction.completed',
      interaction: {
        id: 'int_1',
        status: 'requires_action',
        usage: {
          total_input_tokens: 12,
          total_thought_tokens: 3,
          total_tool_use_tokens: toolUseTokens,
        },
      },
    },
  ];
}

function response(events: unknown[]): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  );
}

function exchange(result: TurnResult): TurnRequest {
  assert(result.providerResponseId !== null);
  const initial = request();
  return {
    ...initial,
    continuation: result.continuation,
    messages: [
      ...initial.messages,
      {
        role: 'assistant',
        origin: result.requestedOrigin,
        content: result.content,
      },
      {
        role: 'tool',
        results: [
          {
            callOrdinal: 0,
            status: 'success',
            content: [
              { kind: 'text', text: 'a' },
              {
                kind: 'image',
                mimeType: 'image/png',
                base64: 'AQ==',
                detail: 'ultra-high',
              },
            ],
          },
          {
            callOrdinal: 1,
            status: 'success',
            content: [{ kind: 'text', text: 'b' }],
          },
        ],
      },
    ],
  };
}

// The Google SDK clones every request before handing it to `fetch`, and Node
// links a cloned Request's abort signal to its parent only weakly: once that
// dependent controller is collected the clone never sees the abort, so the
// signal reaching `fetch` is not a sound place to observe cancellation. The
// pre-clone signal the SDK derived from ours stays linked, so record it here
// and let the abort fixtures watch that one.
const preCloneSignal = new WeakMap<Request, AbortSignal>();
const cloneRequest = Request.prototype.clone;

describe('canonical Google Interactions protocol', () => {
  const fetchModel = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchModel
      .mockReset()
      .mockImplementation(async () => response(signedEvents()));
    vi.stubGlobal('fetch', fetchModel);
    Request.prototype.clone = function (this: Request) {
      const clone = cloneRequest.call(this);
      preCloneSignal.set(clone, this.signal);
      return clone;
    };
  });
  afterEach(() => {
    Request.prototype.clone = cloneRequest;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  effectIt.effect(
    'submits once, polls signed tool calls, and replays their canonical results',
    () =>
      Effect.gen(function* () {
        const { configured, turn, background, operation } =
          yield* backgroundFixture();
        fetchModel.mockImplementationOnce(async () =>
          Response.json({
            id: 'int_1',
            status: 'queued',
            model: 'gemini-returned',
          }),
        );
        expect(yield* background.submit(turn)).toEqual({
          kind: 'accepted',
          operation,
          returnedModel: 'gemini-returned',
        });
        expect(
          yield* Effect.promise(() =>
            (fetchModel.mock.calls[0][0] as Request).json(),
          ),
        ).toMatchObject({ background: true, stream: false, store: true });
        fetchModel.mockImplementationOnce(async () =>
          Response.json({
            id: 'int_1',
            status: 'in_progress',
            model: 'gemini-returned',
          }),
        );
        fetchModel.mockImplementationOnce(async () =>
          Response.json({
            id: 'int_1',
            status: 'requires_action',
            steps: [
              {
                type: 'thought',
                summary: [{ type: 'text', text: 'plan' }],
                signature: 'sig_b',
              },
              {
                type: 'model_output',
                content: [{ type: 'text', text: 'thinking done' }],
              },
              {
                type: 'function_call',
                id: 'call_1',
                name: 'search',
                arguments: { q: 'one' },
              },
              {
                type: 'function_call',
                id: 'call_2',
                name: 'fetch',
                arguments: { u: 'two' },
              },
            ],
            usage: {
              total_input_tokens: 12,
              total_output_tokens: 8,
              total_tokens: 20,
              total_cached_tokens: 3,
              total_thought_tokens: 2,
              total_tool_use_tokens: 5,
            },
          }),
        );
        const observation = yield* Stream.runCollect(
          background.observe(operation, { deadlineAtMs: 10_000 }),
        ).pipe(Effect.forkChild);
        yield* TestClock.adjust('5 seconds');
        const events = yield* Fiber.join(observation);
        expect(
          events.map((event) => [event.kind, event.afterSequence]),
        ).toEqual([
          ['identified', null],
          ['completed', null],
        ]);
        const completed = events.at(-1);
        assert(completed?.kind === 'completed');
        expect(completed.result).toMatchObject({
          providerResponseId: 'int_1',
          returnedModel: 'gemini-returned',
          finishReason: 'tool-calls',
          usage: {
            inputTokens: 12,
            outputTokens: 8,
            totalTokens: 20,
            cachedInputTokens: 3,
            reasoningTokens: 2,
            providerUsage: { kind: 'google', toolUsePromptTokens: 5 },
          },
        });
        expect(completed.result.continuation).toBeUndefined();
        const replay = yield* configured.prepareTurn(
          exchange(completed.result),
        );
        assert(replay.mode === 'foreground');
        yield* configured.generateTurn(replay);
        expect(
          yield* Effect.promise(() =>
            (fetchModel.mock.calls[3][0] as Request).json(),
          ),
        ).toMatchObject({
          background: false,
          stream: true,
          input: expect.arrayContaining([
            {
              type: 'thought',
              summary: [{ type: 'text', text: 'plan' }],
              signature: 'sig_b',
            },
            {
              type: 'function_call',
              id: 'call_1',
              name: 'search',
              arguments: { q: 'one' },
            },
            {
              type: 'function_call',
              id: 'call_2',
              name: 'fetch',
              arguments: { u: 'two' },
            },
          ]),
        });
        expect(
          fetchModel.mock.calls
            .slice(1, 3)
            .every(([url]) =>
              (url as Request).url.includes('include_input=false'),
            ),
        ).toBe(true);
        expect(fetchModel).toHaveBeenCalledTimes(4);
      }),
  );

  effectIt.effect.each([
    ['cancelled', 'confirmed-cancelled'],
    ['completed', 'observed-terminal'],
    ['requires_action', 'observed-terminal'],
    ['in_progress', 'unconfirmed'],
  ] as const)('reports cancellation state %s as %s', ([status, kind]) =>
    Effect.gen(function* () {
      const { background, operation } = yield* backgroundFixture();
      fetchModel.mockImplementationOnce(async () =>
        Response.json({ id: 'int_1', status, model: 'gemini-returned' }),
      );
      expect(yield* background.cancel(operation)).toMatchObject({
        kind,
        providerResponseId: 'int_1',
        returnedModel: 'gemini-returned',
        ...(status === 'cancelled' ? {} : { status }),
      });
      expect(fetchModel).toHaveBeenCalledTimes(1);
      expect((fetchModel.mock.calls[0][0] as Request).url).toContain(
        '/int_1/cancel',
      );
    }),
  );

  effectIt.effect(
    'enforces binding, storage, and the original observation deadline before requests',
    () =>
      Effect.gen(function* () {
        const { configured, turn, background, operation } =
          yield* backgroundFixture();
        expect(model().background).toBeUndefined();
        expect(
          (yield* Effect.flip(
            model(false, true, 'supported').prepareTurn({
              ...request(),
              mode: 'background',
            }),
          )).kind,
        ).toBe('unsupported');
        expect(
          (yield* Effect.flip(
            background.submit({
              ...turn,
              controls: { ...turn.controls, store: false },
            }),
          )).kind,
        ).toBe('unsupported');
        const other = RemoteOperationSchema.parse({
          ...operation,
          origin: {
            ...operation.origin,
            deployment: {
              ...operation.origin.deployment,
              credentialScope: 'other-account',
            },
          },
        });
        expect((yield* Effect.flip(background.cancel(other))).kind).toBe(
          'unsupported',
        );
        expect(
          yield* Effect.flip(
            Stream.runDrain(background.observe(operation, { deadlineAtMs: 0 })),
          ),
        ).toMatchObject({ kind: 'observation-deadline', operation });
        const invalidForeground = JSON.parse(JSON.stringify(turn));
        expect(
          (yield* Effect.flip(configured.generateTurn(invalidForeground))).kind,
        ).toBe('unsupported');
        expect(fetchModel).not.toHaveBeenCalled();
      }),
  );

  effectIt.effect.each([
    'malformed-terminal',
    'mismatched-cancellation',
    'changed-model',
    'retrieval-failure',
  ] as const)(
    'retains accepted operation evidence for %s without retry',
    (failure) =>
      Effect.gen(function* () {
        const { turn, background, operation } = yield* backgroundFixture();
        if (failure === 'malformed-terminal') {
          fetchModel.mockImplementationOnce(async () =>
            Response.json({
              id: 'int_1',
              status: 'completed',
              steps: [{ type: 'unknown' }],
            }),
          );
          expect(yield* Effect.flip(background.submit(turn))).toMatchObject({
            kind: 'malformed-output',
            operation,
            responseId: 'int_1',
          });
        } else if (failure === 'mismatched-cancellation') {
          fetchModel.mockImplementationOnce(async () =>
            Response.json({ id: 'different', status: 'cancelled' }),
          );
          expect(
            yield* Effect.flip(background.cancel(operation)),
          ).toMatchObject({
            kind: 'malformed-output',
            operation,
            responseId: 'int_1',
          });
        } else {
          if (failure === 'changed-model') {
            fetchModel.mockImplementationOnce(async () =>
              Response.json({
                id: 'int_1',
                status: 'in_progress',
                model: 'first',
              }),
            );
            fetchModel.mockImplementationOnce(async () =>
              Response.json({
                id: 'int_1',
                status: 'completed',
                model: 'other',
                steps: [
                  {
                    type: 'model_output',
                    content: [{ type: 'text', text: 'x' }],
                  },
                ],
              }),
            );
          } else
            fetchModel.mockImplementationOnce(async () =>
              Response.json({ error: { message: 'denied' } }, { status: 403 }),
            );
          const observation = yield* Effect.flip(
            Stream.runDrain(
              background.observe(operation, { deadlineAtMs: 10_000 }),
            ),
          ).pipe(Effect.forkChild);
          if (failure === 'changed-model') yield* TestClock.adjust('5 seconds');
          expect(yield* Fiber.join(observation)).toMatchObject({
            kind:
              failure === 'changed-model'
                ? 'malformed-output'
                : 'authentication',
            operation,
            responseId: 'int_1',
            ...(failure === 'changed-model' ? { model: 'first' } : {}),
          });
        }
        expect(fetchModel).toHaveBeenCalledTimes(
          failure === 'changed-model' ? 2 : 1,
        );
      }),
  );

  effectIt.effect.each([
    'submit',
    'observe',
    'cancel',
    'deadline',
    'deadline-cleanup-failure',
  ] as const)(
    'aborts and joins the full background %s body without cancelling remote work',
    (kind) =>
      Effect.gen(function* () {
        const { turn, background, operation } = yield* backgroundFixture();
        const timedOut =
          kind === 'deadline' || kind === 'deadline-cleanup-failure';
        const entered = gate();
        const aborted = gate();
        const released = gate();
        const failure = new Error('Late background body failure');
        fetchModel.mockImplementation(async (input) => {
          const request = input as Request;
          const signal = preCloneSignal.get(request) ?? request.signal;
          return new Response(
            new ReadableStream<Uint8Array>(
              {
                start(controller) {
                  signal.addEventListener(
                    'abort',
                    () => {
                      aborted.release();
                      void released.promise.then(() =>
                        controller.error(
                          kind === 'deadline'
                            ? new DOMException('Aborted', 'AbortError')
                            : failure,
                        ),
                      );
                    },
                    { once: true },
                  );
                },
                pull() {
                  entered.release();
                },
              },
              { highWaterMark: 0 },
            ),
            { headers: { 'content-type': 'application/json' } },
          );
        });
        let action: Effect.Effect<unknown, ModelError>;
        if (kind === 'submit') action = background.submit(turn);
        else if (kind === 'cancel') action = background.cancel(operation);
        else
          action = Stream.runDrain(
            background.observe(operation, {
              deadlineAtMs: timedOut ? 1_000 : 60_000,
            }),
          );
        let finished = false;
        const fiber = yield* action.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              finished = true;
            }),
          ),
          Effect.forkChild,
        );
        yield* Effect.promise(() => entered.promise);
        const interruption = timedOut
          ? yield* TestClock.adjust(1_000).pipe(Effect.forkChild)
          : yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
        yield* Effect.promise(() => aborted.promise);
        expect(finished).toBe(false);
        released.release();
        yield* Fiber.join(interruption);
        const exit = yield* Fiber.await(fiber);
        assert(exit._tag === 'Failure');
        if (timedOut) {
          expect(
            exit.cause.reasons.find(Cause.isFailReason)?.error,
          ).toMatchObject({
            kind: 'observation-deadline',
            operation,
            responseId: 'int_1',
          });
        } else expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        if (kind === 'deadline')
          expect(exit.cause.reasons.filter(Cause.isDieReason)).toHaveLength(0);
        else {
          expect(
            exit.cause.reasons.find(Cause.isDieReason)?.defect,
          ).toMatchObject({
            cause: failure,
            ...(kind === 'submit' ? {} : { operation, responseId: 'int_1' }),
          });
        }
        expect(fetchModel).toHaveBeenCalledTimes(1);
        if (kind !== 'cancel')
          expect((fetchModel.mock.calls[0][0] as Request).url).not.toContain(
            '/cancel',
          );
      }),
  );

  it.each([undefined, '', ' Exact system\n'])(
    'counts exact cold converted content with system %j without generating',
    async (system) => {
      const inputTokens = system === undefined ? 0 : 7;
      fetchModel.mockImplementation(async () =>
        Response.json({ totalTokens: inputTokens }),
      );
      const configured = model();
      expect(model(true, false).estimateInputTokens).toBeUndefined();
      assert(configured.estimateInputTokens);
      const turn = await Effect.runPromise(
        configured.prepareTurn({
          ...(system === undefined ? {} : { system }),
          messages: [
            {
              role: 'user',
              content: [
                { kind: 'text', text: '  exact\n' },
                { kind: 'text', text: '' },
                { kind: 'text', text: 'last' },
              ],
            },
          ],
        }),
      );
      assert(turn.mode === 'foreground');
      expect(fetchModel).not.toHaveBeenCalled();
      const estimate = await Effect.runPromise(
        configured.estimateInputTokens(JSON.parse(JSON.stringify(turn))),
      );
      expect(estimate).toEqual({
        inputTokens,
        coverage: 'google-converted-content',
      });
      expect(Object.isFrozen(estimate)).toBe(true);
      expect(fetchModel).toHaveBeenCalledTimes(1);
      const [url, init] = fetchModel.mock.calls[0];
      expect(String(url)).toBe(
        'https://synthetic.invalid/v1beta/models/gemini-test:countTokens',
      );
      expect(JSON.parse(init!.body as string)).toEqual({
        contents: [
          ...(system === undefined
            ? []
            : [{ role: 'system', parts: [{ text: system }] }]),
          {
            role: 'user',
            parts: [{ text: '  exact\n' }, { text: '' }, { text: 'last' }],
          },
        ],
      });
      expect(new Headers(init!.headers).get('x-goog-api-key')).toBe(
        'synthetic-key',
      );
    },
  );

  it.each(['tools', 'media', 'history', 'binding', 'choice'] as const)(
    'rejects unsupported %s before counting any Google input',
    async (kind) => {
      const configured = model();
      assert(configured.estimateInputTokens);
      const turn = await Effect.runPromise(
        configured.prepareTurn({
          messages: [{ role: 'user', content: [{ kind: 'text', text: 'x' }] }],
        }),
      );
      assert(turn.protocol === 'google-interactions');
      let input: unknown = turn;
      if (kind === 'tools') input = { ...turn, tools: request().tools };
      if (kind === 'media') input = { ...turn, messages: request().messages };
      if (kind === 'history')
        input = { ...turn, messages: [...turn.messages, ...turn.messages] };
      if (kind === 'binding')
        input = {
          ...turn,
          deployment: {
            ...turn.deployment,
            credentialScope: 'another-account',
          },
        };
      if (kind === 'choice')
        input = {
          ...turn,
          controls: { ...turn.controls, toolChoice: { name: 'absent' } },
        };
      await expect(
        Effect.runPromise(
          configured.estimateInputTokens(JSON.parse(JSON.stringify(input))),
        ),
      ).rejects.toMatchObject({ _tag: 'ModelError' });
      expect(fetchModel).not.toHaveBeenCalled();
    },
  );

  it.each([
    { body: '{}', status: 200, kind: 'malformed-output' },
    { body: '{"totalTokens":-1}', status: 200, kind: 'malformed-output' },
    { body: '{', status: 200, kind: 'malformed-output' },
    {
      body: '{"error":{"message":"denied"}}',
      status: 401,
      kind: 'authentication',
    },
    {
      body: '{"error":{"message":"busy"}}',
      status: 429,
      kind: 'provider-rejection',
    },
  ])(
    'rejects Google count receipt $body at HTTP $status without retry',
    async ({ body, status, kind }) => {
      fetchModel.mockImplementation(
        async () =>
          new Response(body, {
            status,
            headers: { 'content-type': 'application/json' },
          }),
      );
      const configured = model();
      assert(configured.estimateInputTokens);
      const turn = await Effect.runPromise(
        configured.prepareTurn({
          messages: [{ role: 'user', content: [{ kind: 'text', text: 'x' }] }],
        }),
      );
      assert(turn.mode === 'foreground');
      const exit = await Effect.runPromise(
        Effect.exit(configured.estimateInputTokens(turn)),
      );
      assert(exit._tag === 'Failure');
      expect(exit.cause.reasons).toHaveLength(1);
      expect(exit.cause.reasons.find(Cause.isFailReason)?.error).toMatchObject({
        kind,
        ...(status === 200 ? {} : { status }),
      });
      expect(fetchModel).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['headers', 'body', 'late-body-failure'] as const)(
    'aborts and joins the complete Google count promise during %s',
    async (phase) => {
      let enter: () => void = () => {};
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      let abort: () => void = () => {};
      const aborted = new Promise<void>((resolve) => {
        abort = resolve;
      });
      let release: () => void = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const failure = new Error('Late count read failure');
      fetchModel.mockImplementation(async (_url, init) => {
        assert(init?.signal);
        const signal = init.signal;
        if (phase === 'headers')
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                abort();
                void released.then(() =>
                  reject(new DOMException('Aborted', 'AbortError')),
                );
              },
              { once: true },
            );
            enter();
          });
        return new Response(
          new ReadableStream<Uint8Array>(
            {
              start(controller) {
                signal.addEventListener(
                  'abort',
                  () => {
                    abort();
                    void released.then(() =>
                      controller.error(
                        phase === 'late-body-failure'
                          ? failure
                          : new DOMException('Aborted', 'AbortError'),
                      ),
                    );
                  },
                  { once: true },
                );
              },
              pull() {
                enter();
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: { 'content-type': 'application/json' } },
        );
      });
      const configured = model();
      assert(configured.estimateInputTokens);
      const turn = await Effect.runPromise(
        configured.prepareTurn({
          messages: [{ role: 'user', content: [{ kind: 'text', text: 'x' }] }],
        }),
      );
      assert(turn.mode === 'foreground');
      const fiber = Effect.runFork(configured.estimateInputTokens(turn));
      await entered;
      let finished = false;
      const interruption = Effect.runPromise(Fiber.interrupt(fiber)).then(
        (exit) => {
          finished = true;
          return exit;
        },
      );
      await aborted;
      expect(finished).toBe(false);
      release();
      await interruption;
      const exit = await Effect.runPromise(Fiber.await(fiber));
      assert(exit._tag === 'Failure');
      expect(Cause.hasInterrupts(exit.cause)).toBe(true);
      if (phase === 'late-body-failure')
        expect(
          exit.cause.reasons.find(Cause.isDieReason)?.defect,
        ).toMatchObject({ cause: failure });
      else expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(fetchModel).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { store: true, includeSummary: true, toolUseTokens: 0 },
    { store: false, includeSummary: false, toolUseTokens: undefined },
  ])(
    'preserves a signed two-call exchange with store=$store and readable summary=$includeSummary',
    async ({ store, includeSummary, toolUseTokens }) => {
      fetchModel.mockImplementationOnce(async () =>
        response(signedEvents(includeSummary, toolUseTokens)),
      );
      vi.stubEnv('GOOGLE_GENAI_USE_ENTERPRISE', 'true');
      const configured = model(store);
      const prepared = await Effect.runPromise(
        configured.prepareTurn(request()),
      );
      assert(prepared.mode === 'foreground');
      expect(fetchModel).not.toHaveBeenCalled();
      const events = await Effect.runPromise(
        Stream.runCollect(configured.streamTurn(prepared)),
      );
      expect(events[0]).toMatchObject({
        kind: 'identified',
        providerResponseId: 'int_1',
        requestedOrigin: {
          protocol: 'google-interactions',
          requestedModel: 'gemini-test',
        },
        returnedModel: 'gemini-returned',
      });
      expect(
        events.filter((event) => event.kind === 'identified'),
      ).toHaveLength(1);
      expect(
        events.flatMap((event) => {
          if (event.kind === 'phase')
            return [[event.part, event.boundary, event.providerItemIndex]];
          if (event.kind === 'delta')
            return [[event.part, event.text, event.providerItemIndex]];
          return [];
        }),
      ).toEqual([
        ['reasoning', 'start', 0],
        ...(includeSummary ? [['reasoning', 'plan', 0]] : []),
        ['reasoning', 'end', 0],
        ['text', 'start', 1],
        ['text', 'thinking done', 1],
        ['text', 'end', 1],
      ]);
      const completed = events.at(-1);
      if (completed?.kind !== 'completed')
        throw new Error('Missing completed result');
      const result = completed.result;
      assert(result.providerResponseId !== null);
      const initialBody = await (fetchModel.mock.calls[0][0] as Request).json();
      expect(initialBody.input).toEqual([
        {
          type: 'user_input',
          content: [
            { type: 'text', text: 'go' },
            { type: 'text', text: 'Image: figures/panel.png' },
            {
              type: 'image',
              mime_type: 'image/png',
              data: 'AA==',
              resolution: 'high',
            },
            { type: 'text', text: 'Audio: sound.mp3' },
            { type: 'audio', mime_type: 'audio/mp3', data: 'TQ==' },
            { type: 'text', text: 'Video: clip.mp4' },
            {
              type: 'video',
              mime_type: 'video/mp4',
              data: 'Vg==',
              processing: 'static',
            },
            { type: 'text', text: 'Document: paper.pdf' },
            { type: 'document', mime_type: 'application/pdf', data: 'UA==' },
            { type: 'text', text: 'Document: empty.csv' },
            { type: 'document', mime_type: 'text/csv', data: '' },
          ],
        },
      ]);
      expect(result).toMatchObject({
        providerResponseId: 'int_1',
        returnedModel: 'gemini-returned',
        requestedOrigin: {
          requestedModel: 'gemini-test',
          deployment: { credentialScope: 'test-account' },
        },
        finishReason: 'tool-calls',
        // The finish reason is now read off the wire status rather than
        // synthesized from the presence of calls, and the status Google sent
        // is carried verbatim.
        finishEvidence: {
          kind: 'google-interactions',
          status: 'requires_action',
          terminalReason: null,
        },
        content: [
          {
            kind: 'reasoning',
            summary: includeSummary ? [{ kind: 'text', text: 'plan' }] : [],
            evidence: {
              kind: 'google-interactions-thought-signature',
              signature: 'sig_b',
            },
          },
          {
            kind: 'message',
            content: [{ kind: 'text', text: 'thinking done' }],
          },
          {
            kind: 'local-call',
            providerCallId: 'call_1',
            name: 'search',
            arguments: { q: 'x' },
          },
          {
            kind: 'local-call',
            providerCallId: 'call_2',
            name: 'fetch',
            arguments: { u: 'y' },
          },
        ],
        usage: {
          inputTokens: 12,
          outputTokens: null,
          totalTokens: null,
          cachedInputTokens: null,
          reasoningTokens: 3,
          providerUsage: {
            kind: 'google',
            toolUsePromptTokens: toolUseTokens ?? null,
          },
        },
      });
      if (store)
        expect(result.continuation).toMatchObject({
          coveredMessages: 2,
          anchor: { interactionId: 'int_1', coveredSteps: 5 },
        });
      else expect(result.continuation).toBeUndefined();

      // Rehydrated canonical values, not another SDK transcript or reasoning cache.
      const restored: TurnResult = JSON.parse(JSON.stringify(result));
      const next = await Effect.runPromise(
        configured.prepareTurn(exchange(restored)),
      );
      assert(next.mode === 'foreground');
      assert(configured.estimateInputTokens);
      await expect(
        Effect.runPromise(configured.estimateInputTokens(next)),
      ).rejects.toMatchObject({ kind: 'unsupported' });
      expect(fetchModel).toHaveBeenCalledTimes(1);
      fetchModel.mockImplementationOnce(async () =>
        response([
          {
            event_type: 'interaction.created',
            interaction: { id: 'int_2', status: 'in_progress' },
          },
          {
            event_type: 'step.start',
            index: 0,
            step: { type: 'model_output' },
          },
          {
            event_type: 'step.delta',
            index: 0,
            delta: { type: 'text', text: 'done' },
          },
          { event_type: 'step.stop', index: 0 },
          {
            event_type: 'interaction.completed',
            interaction: {
              id: 'int_2',
              status: 'completed',
            },
          },
        ]),
      );
      await Effect.runPromise(configured.generateTurn(next));
      const sent = fetchModel.mock.calls[1][0] as Request;
      expect(sent.url).toBe('https://synthetic.invalid/v1beta/interactions');
      const body = await sent.json();
      expect(body.store).toBe(store);
      expect(body.generation_config).toEqual({
        max_output_tokens: 2048,
        thinking_level: 'high',
        thinking_summaries: 'auto',
        tool_choice: 'auto',
      });
      expect(body.previous_interaction_id).toBe(store ? 'int_1' : undefined);
      expect(body.input.map((step: { type: string }) => step.type)).toEqual(
        store
          ? ['function_result', 'function_result']
          : [
              'user_input',
              'thought',
              'model_output',
              'function_call',
              'function_call',
              'function_result',
              'function_result',
            ],
      );
      expect(body.input.slice(-2)).toEqual([
        {
          type: 'function_result',
          call_id: 'call_1',
          name: 'search',
          result: [
            { type: 'text', text: 'a' },
            {
              type: 'image',
              mime_type: 'image/png',
              data: 'AQ==',
              resolution: 'ultra_high',
            },
          ],
        },
        {
          type: 'function_result',
          call_id: 'call_2',
          name: 'fetch',
          result: [{ type: 'text', text: 'b' }],
        },
      ]);
      if (!store) {
        expect(body.input[0]).toEqual(initialBody.input[0]);
        expect(body.input[1].signature).toBe('sig_b');
      }
      expect(fetchModel).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    'system',
    'signature',
    'cursor',
    'missing-result',
    'origin',
    'media-bytes',
    'media-mime',
    'media-detail',
    'media-label',
  ] as const)('rejects a changed %s before provider I/O', async (changed) => {
    const configured = model();
    const prepared = await Effect.runPromise(configured.prepareTurn(request()));
    assert(prepared.mode === 'foreground');
    const result = await Effect.runPromise(configured.generateTurn(prepared));
    const next = JSON.parse(JSON.stringify(exchange(result)));
    if (changed === 'system') next.system = 'different';
    if (changed === 'signature')
      next.messages[1].content[0].evidence.signature = 'changed';
    if (changed === 'cursor') next.continuation.anchor.coveredSteps = 4;
    if (changed === 'missing-result') next.messages[2].results.pop();
    if (changed === 'origin')
      next.continuation.origin.deployment.credentialScope = 'other-account';
    if (changed === 'media-bytes') next.messages[0].content[2].base64 = 'AQ==';
    if (changed === 'media-mime')
      next.messages[0].content[2].mimeType = 'image/jpeg';
    if (changed === 'media-detail') next.messages[0].content[2].detail = 'low';
    if (changed === 'media-label')
      next.messages[0].content[1].text = 'Other figure';
    await expect(
      Effect.runPromise(configured.prepareTurn(next)),
    ).rejects.toMatchObject({ _tag: 'ModelError' });
    expect(fetchModel).toHaveBeenCalledTimes(1);
  });

  it.each([
    'raw-audio',
    'tool-audio',
    'tool-video',
    'tool-document',
    'parallel-control',
    'reasoning-control',
    'service-tier-control',
    'prompt-cache-key',
    'anthropic-controls',
    'background-mode',
  ] as const)(
    'rejects unsupported %s before provider I/O',
    async (unsupported) => {
      const configured = model();
      const prepared = await Effect.runPromise(
        configured.prepareTurn(request()),
      );
      assert(prepared.mode === 'foreground');
      const result = await Effect.runPromise(configured.generateTurn(prepared));
      const next = JSON.parse(JSON.stringify(exchange(result)));
      let expectedMessage = 'Google tool results';
      if (unsupported === 'parallel-control') {
        next.parallelToolCalls = false;
        expectedMessage = 'Google parallel-call control';
      } else if (
        unsupported === 'reasoning-control' ||
        unsupported === 'service-tier-control'
      ) {
        next[
          unsupported === 'reasoning-control' ? 'reasoning' : 'serviceTier'
        ] = null;
        expectedMessage = 'Google does not support';
      } else if (unsupported === 'anthropic-controls') {
        Object.assign(next, {
          thinking: { mode: 'disabled' },
          effort: null,
          cache: 'disabled',
          stopSequences: [],
          inferenceGeo: null,
        });
        expectedMessage = 'Google does not support';
      } else if (unsupported === 'background-mode') {
        next.mode = 'background';
        expectedMessage = 'Google background execution';
      } else if (unsupported === 'prompt-cache-key') {
        next.promptCacheKey = 'run-cache-key';
        expectedMessage = 'Google does not support';
      } else if (unsupported === 'raw-audio') {
        expectedMessage = 'Raw Google audio';
        next.messages.push({
          role: 'user',
          content: [
            {
              kind: 'audio',
              mimeType: 'audio/L16 ; rate=24000',
              base64: 'AA==',
            },
          ],
        });
      } else {
        const parts = {
          'tool-audio': {
            kind: 'audio',
            mimeType: 'audio/mp3',
            base64: 'AA==',
          },
          'tool-video': {
            kind: 'video',
            mimeType: 'video/mp4',
            base64: 'AA==',
          },
          'tool-document': {
            kind: 'document',
            mimeType: 'application/pdf',
            base64: 'AA==',
          },
        };
        next.messages[2].results[0].content.push(parts[unsupported]);
      }
      await expect(
        Effect.runPromise(configured.prepareTurn(next)),
      ).rejects.toMatchObject({
        _tag: 'ModelError',
        kind: 'unsupported',
        message: expect.stringContaining(expectedMessage),
      });
      expect(fetchModel).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves a named tool choice and validates its definition before I/O', async () => {
    const configured = model();
    const input: TurnRequest = { ...request(), toolChoice: { name: 'search' } };
    await expect(
      Effect.runPromise(
        configured.prepareTurn({ ...input, toolChoice: { name: 'absent' } }),
      ),
    ).rejects.toMatchObject({ _tag: 'ModelError', kind: 'invalid-request' });
    const prepared = await Effect.runPromise(configured.prepareTurn(input));
    const restored = JSON.parse(JSON.stringify(prepared));
    restored.controls.toolChoice.name = 'absent';
    await expect(
      Effect.runPromise(configured.generateTurn(restored)),
    ).rejects.toMatchObject({ _tag: 'ModelError', kind: 'invalid-request' });
    expect(fetchModel).not.toHaveBeenCalled();
    const events = signedEvents();
    events.splice(12, 3);
    fetchModel.mockImplementation(async () => response(events));
    const result = await Effect.runPromise(
      configured.generateTurn(JSON.parse(JSON.stringify(prepared))),
    );
    expect(
      result.content.filter((part) => part.kind === 'local-call'),
    ).toMatchObject([{ name: 'search', providerCallId: 'call_1' }]);
    const body = await (fetchModel.mock.calls[0][0] as Request).json();
    expect(body.generation_config.tool_choice).toEqual({
      allowed_tools: { mode: 'any', tools: ['search'] },
    });
    expect(fetchModel).toHaveBeenCalledTimes(1);
  });

  it.each([
    'arguments',
    'duplicate-id',
    'missing-id',
    'incomplete',
    'null-event',
    'null-step',
    'invalid-text',
    'invalid-usage',
    'terminal-snapshot',
    'prototype-key',
    'empty-action',
    'completed-calls',
    'changed-model',
    'changed-signature',
    'initial-arguments',
  ] as const)('does not complete a response with %s', async (invalid) => {
    const events: unknown[] = signedEvents();
    if (invalid === 'arguments')
      events[10] = {
        event_type: 'step.delta',
        index: 2,
        delta: { type: 'arguments_delta', arguments: 'broken' },
      };
    if (invalid === 'duplicate-id')
      events[12] = {
        event_type: 'step.start',
        index: 3,
        step: {
          type: 'function_call',
          id: 'call_1',
          name: 'fetch',
          arguments: {},
        },
      };
    if (invalid === 'missing-id')
      events[12] = {
        event_type: 'step.start',
        index: 3,
        step: { type: 'function_call', id: '', name: 'fetch', arguments: {} },
      };
    if (invalid === 'incomplete') events.pop();
    if (invalid === 'null-event') events[1] = null;
    if (invalid === 'null-step')
      events[1] = { event_type: 'step.start', index: 0, step: null };
    if (invalid === 'invalid-text')
      events[6] = {
        event_type: 'step.delta',
        index: 1,
        delta: { type: 'text', text: 3 },
      };
    if (invalid === 'invalid-usage')
      events[15] = {
        event_type: 'interaction.completed',
        interaction: {
          id: 'int_1',
          status: 'requires_action',
          usage: 'invalid',
        },
      };
    if (invalid === 'terminal-snapshot')
      events[15] = {
        event_type: 'interaction.completed',
        interaction: {
          id: 'int_1',
          status: 'requires_action',
          steps: [
            {
              type: 'function_call',
              id: 'different',
              name: 'search',
              arguments: {},
            },
          ],
        },
      };
    if (invalid === 'prototype-key') {
      events[9] = {
        event_type: 'step.delta',
        index: 2,
        delta: { type: 'arguments_delta', arguments: '{"__proto__":{}}' },
      };
      events[10] = {
        event_type: 'step.delta',
        index: 2,
        delta: { type: 'arguments_delta', arguments: '' },
      };
    }
    if (invalid === 'empty-action')
      events.splice(1, events.length, {
        event_type: 'interaction.completed',
        interaction: { id: 'int_1', status: 'requires_action' },
      });
    if (invalid === 'changed-model')
      events[15] = {
        event_type: 'interaction.completed',
        interaction: {
          id: 'int_1',
          status: 'requires_action',
          model: 'other-model',
        },
      };
    if (invalid === 'completed-calls')
      events[15] = {
        event_type: 'interaction.completed',
        interaction: { id: 'int_1', status: 'completed' },
      };
    if (invalid === 'changed-signature')
      events.splice(4, 0, {
        event_type: 'step.delta',
        index: 0,
        delta: { type: 'thought_signature', signature: 'changed-signature' },
      });
    if (invalid === 'initial-arguments')
      events[8] = {
        event_type: 'step.start',
        index: 2,
        step: {
          type: 'function_call',
          id: 'call_1',
          name: 'search',
          arguments: { q: 'different' },
        },
      };
    fetchModel.mockImplementation(async () => response(events));
    const configured = model();
    const prepared = await Effect.runPromise(configured.prepareTurn(request()));
    assert(prepared.mode === 'foreground');
    await expect(
      Effect.runPromise(configured.generateTurn(prepared)),
    ).rejects.toMatchObject({
      _tag: 'ModelError',
      responseId: 'int_1',
      model: 'gemini-returned',
    });
    expect(fetchModel).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, 'authentication'],
    [429, 'provider-rejection'],
    [undefined, 'transport'],
  ] as const)('classifies SDK failure with status %s', async (status, kind) => {
    fetchModel.mockImplementation(async () => {
      if (status === undefined) throw new TypeError('Connection failed');
      return new Response(JSON.stringify({ error: { message: 'Rejected' } }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    });
    const configured = model();
    const prepared = await Effect.runPromise(configured.prepareTurn(request()));
    assert(prepared.mode === 'foreground');
    await expect(
      Effect.runPromise(configured.generateTurn(prepared)),
    ).rejects.toMatchObject({
      _tag: 'ModelError',
      kind,
      ...(status === undefined ? {} : { status }),
      model: 'gemini-test',
    });
    expect(fetchModel).toHaveBeenCalledTimes(1);
  });

  it('retains response identity when the body fails after progress', async () => {
    const readFailure = new Error('Body failed');
    let bodyController: ReadableStreamDefaultController<Uint8Array>;
    fetchModel.mockImplementation(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              bodyController = controller;
              controller.enqueue(
                new TextEncoder().encode(
                  signedEvents()
                    .slice(0, 3)
                    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                    .join(''),
                ),
              );
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const configured = model();
    const prepared = await Effect.runPromise(configured.prepareTurn(request()));
    assert(prepared.mode === 'foreground');
    const exit = await Effect.runPromise(
      Effect.exit(
        configured.streamTurn(prepared).pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event.kind === 'delta') bodyController.error(readFailure);
            }),
          ),
        ),
      ),
    );
    assert(exit._tag === 'Failure');
    expect(exit.cause.reasons).toHaveLength(1);
    const primary = exit.cause.reasons.find(Cause.isFailReason)?.error;
    expect(primary).toMatchObject({
      _tag: 'ModelError',
      kind: 'transport',
      responseId: 'int_1',
      model: 'gemini-returned',
      message: 'Body failed',
      cause: readFailure,
    });
  });

  it.each(['headers', 'body', 'malformed', 'successful-take'] as const)(
    'aborts before cleanup after %s',
    async (phase) => {
      const entered = await Effect.runPromise(Deferred.make<void>());
      const order: string[] = [];
      const cleanupFailure = new Error('Cancellation failed');
      fetchModel.mockImplementation((input) => {
        const request = input as Request;
        if (phase === 'headers') {
          return new Promise<Response>((_resolve, reject) => {
            request.signal.addEventListener(
              'abort',
              () => {
                order.push('abort');
                reject(new DOMException('Aborted', 'AbortError'));
              },
              { once: true },
            );
            Effect.runSync(Deferred.succeed(entered, undefined));
          });
        }
        request.signal.addEventListener('abort', () => order.push('abort'), {
          once: true,
        });
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    [
                      {
                        event_type: 'interaction.created',
                        interaction: { id: 'int_1', status: 'in_progress' },
                      },
                      {
                        event_type: 'step.start',
                        index: 0,
                        step: { type: 'model_output' },
                      },
                      {
                        event_type: 'step.delta',
                        index: 0,
                        delta: { type: 'text', text: 'started' },
                      },
                    ]
                      .map((event, index) =>
                        phase === 'malformed' && index === 1
                          ? { event_type: 'step.start', index: 0, step: null }
                          : event,
                      )
                      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                      .join(''),
                  ),
                );
              },
              cancel() {
                order.push(
                  request.signal.aborted
                    ? 'cancel-after-abort'
                    : 'cancel-before-abort',
                );
                throw cleanupFailure;
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
        );
      });
      const configured = model();
      const prepared = await Effect.runPromise(
        configured.prepareTurn(request()),
      );
      assert(prepared.mode === 'foreground');
      if (phase === 'malformed') {
        const exit = await Effect.runPromise(
          Effect.exit(Stream.runDrain(configured.streamTurn(prepared))),
        );
        assert(exit._tag === 'Failure');
        expect(
          exit.cause.reasons.find(Cause.isFailReason)?.error,
        ).toMatchObject({
          kind: 'malformed-output',
          responseId: 'int_1',
          model: 'gemini-test',
        });
        expect(exit.cause.reasons.find(Cause.isDieReason)?.defect).toBe(
          cleanupFailure,
        );
      } else if (phase === 'successful-take') {
        await expect(
          Effect.runPromise(
            configured.streamTurn(prepared).pipe(
              Stream.filter((event) => event.kind === 'delta'),
              Stream.take(1),
              Stream.runDrain,
            ),
          ),
        ).rejects.toThrow('Cancellation failed');
      } else {
        const fiber = Effect.runFork(
          Stream.runForEach(configured.streamTurn(prepared), (event) =>
            event.kind === 'delta'
              ? Deferred.succeed(entered, undefined)
              : Effect.void,
          ),
        );
        await Effect.runPromise(Deferred.await(entered));
        await Effect.runPromise(Fiber.interrupt(fiber));
      }
      expect(order).toEqual(
        phase === 'headers' ? ['abort'] : ['abort', 'cancel-after-abort'],
      );
      expect(fetchModel).toHaveBeenCalledTimes(1);
    },
  );
});
