// Third-party imports
import { googleInteractionsModel } from '@texra-ai/llm/google-interactions';
import { Deferred, Effect, Fiber, Stream } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnRequest, TurnResult } from '@texra-ai/llm/turn';

function model(store = true) {
  return googleInteractionsModel(
    {
      protocol: 'google-interactions',
      requestedModel: 'gemini-test',
      deployment: {
        endpoint: 'https://synthetic.invalid',
        credentialScope: 'test-account',
      },
      defaults: { maxOutputTokens: 2048, store, thinkingLevel: 'high' },
    },
    { apiKey: 'synthetic-key' },
  );
}

function request(): TurnRequest {
  return {
    system: 'Use both tools.',
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'go' }] }],
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

function signedEvents(): Array<Record<string, unknown>> {
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
    {
      event_type: 'step.delta',
      index: 0,
      delta: {
        type: 'thought_summary',
        content: { type: 'text', text: 'plan' },
      },
    },
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
        usage: { total_input_tokens: 12, total_thought_tokens: 3 },
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
            content: [{ kind: 'text', text: 'a' }],
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

describe('canonical Google Interactions protocol', () => {
  const fetchModel = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchModel
      .mockReset()
      .mockImplementation(async () => response(signedEvents()));
    vi.stubGlobal('fetch', fetchModel);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([true, false])(
    'preserves a signed two-call exchange with store=%s',
    async (store) => {
      vi.stubEnv('GOOGLE_GENAI_USE_ENTERPRISE', 'true');
      const configured = model(store);
      const prepared = await Effect.runPromise(
        configured.prepareTurn(request()),
      );
      expect(fetchModel).not.toHaveBeenCalled();
      const result = await Effect.runPromise(configured.generateTurn(prepared));
      expect(result).toMatchObject({
        providerResponseId: 'int_1',
        returnedModel: 'gemini-returned',
        requestedOrigin: {
          requestedModel: 'gemini-test',
          deployment: { credentialScope: 'test-account' },
        },
        finishReason: 'tool-calls',
        content: [
          {
            kind: 'reasoning',
            summary: [{ kind: 'text', text: 'plan' }],
            evidence: {
              kind: 'google-interactions-thought-signature',
              signature: 'sig_b',
            },
          },
          { kind: 'text', text: 'thinking done' },
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
      fetchModel.mockImplementationOnce(async () =>
        response([
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
          result: [{ type: 'text', text: 'a' }],
        },
        {
          type: 'function_result',
          call_id: 'call_2',
          name: 'fetch',
          result: [{ type: 'text', text: 'b' }],
        },
      ]);
      if (!store) expect(body.input[1].signature).toBe('sig_b');
    },
  );

  it.each([
    'system',
    'signature',
    'cursor',
    'missing-result',
    'origin',
  ] as const)('rejects a changed %s before provider I/O', async (changed) => {
    const configured = model();
    const prepared = await Effect.runPromise(configured.prepareTurn(request()));
    const result = await Effect.runPromise(configured.generateTurn(prepared));
    const next = JSON.parse(JSON.stringify(exchange(result)));
    if (changed === 'system') next.system = 'different';
    if (changed === 'signature')
      next.messages[1].content[0].evidence.signature = 'changed';
    if (changed === 'cursor') next.continuation.anchor.coveredSteps = 4;
    if (changed === 'missing-result') next.messages[2].results.pop();
    if (changed === 'origin')
      next.continuation.origin.deployment.credentialScope = 'other-account';
    await expect(
      Effect.runPromise(configured.prepareTurn(next)),
    ).rejects.toMatchObject({ _tag: 'ModelError' });
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
    await expect(
      Effect.runPromise(
        configured
          .streamTurn(prepared)
          .pipe(
            Stream.runForEach(() =>
              Effect.sync(() => bodyController.error(new Error('Body failed'))),
            ),
          ),
      ),
    ).rejects.toMatchObject({
      _tag: 'ModelError',
      kind: 'transport',
      responseId: 'int_1',
      model: 'gemini-returned',
      message: 'Body failed',
    });
  });

  it.each(['headers', 'body', 'successful-take'] as const)(
    'aborts before cleanup after %s',
    async (phase) => {
      const entered = await Effect.runPromise(Deferred.make<void>());
      const order: string[] = [];
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
                throw new Error('Cancellation failed');
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
      if (phase === 'successful-take') {
        await expect(
          Effect.runPromise(
            configured
              .streamTurn(prepared)
              .pipe(Stream.take(1), Stream.runDrain),
          ),
        ).rejects.toThrow('Cancellation failed');
      } else {
        const fiber = Effect.runFork(
          Stream.runForEach(configured.streamTurn(prepared), () =>
            Deferred.succeed(entered, undefined),
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
