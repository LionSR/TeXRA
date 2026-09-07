// Node imports
import assert from 'node:assert/strict';

// Third-party imports
import { anthropicMessagesModel } from '@texra-ai/llm/anthropic-messages';
import { Cause, Effect, Fiber, Stream } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AnthropicMessagesConfiguration,
  TurnRequest,
} from '@texra-ai/llm/turn';

const CONFIG: AnthropicMessagesConfiguration = {
  protocol: 'anthropic-messages',
  requestedModel: 'selected-claude',
  deployment: {
    endpoint: 'https://synthetic.invalid',
    credentialScope: 'account-a',
  },
  supportsTemperature: true,
  supportsForcedToolChoice: true,
  defaults: {
    maxOutputTokens: 8192,
    temperature: 1,
    parallelToolCalls: false,
    thinking: { mode: 'adaptive', display: 'summarized' },
    effort: 'high',
    cache: '1h',
    stopSequences: [],
    serviceTier: 'auto',
    inferenceGeo: 'us',
  },
};
const REQUEST: TurnRequest = {
  system: 'Exact system\n',
  messages: [
    {
      role: 'user',
      content: [
        { kind: 'text', text: 'Read these exact bytes.' },
        { kind: 'image', mimeType: 'image/png', base64: '' },
        { kind: 'document', mimeType: 'application/pdf', base64: 'AA==' },
      ],
    },
  ],
  tools: ['search', 'fetch'].map((name) => ({
    name,
    description: name,
    parameters: {
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    },
  })),
};

function initial() {
  return {
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'returned-claude',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      container: null,
      usage: {
        input_tokens: 10,
        output_tokens: 1,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 30,
        cache_creation: {
          ephemeral_5m_input_tokens: 11,
          ephemeral_1h_input_tokens: 19,
        },
        service_tier: 'priority',
        inference_geo: 'us',
      },
    },
  };
}
function terminal(reason = 'end_turn', extra: Record<string, unknown> = {}) {
  return [
    {
      type: 'message_delta',
      delta: {
        stop_reason: reason,
        stop_sequence: null,
        stop_details: null,
        ...extra,
      },
      usage: {
        input_tokens: 12,
        output_tokens: 11,
        output_tokens_details: { thinking_tokens: 6 },
      },
    },
    { type: 'message_stop' },
  ];
}
function signedEvents(): Array<Record<string, unknown>> {
  return [
    initial(),
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: '  returned thinking\n' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'signature-a' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'signature_delta', signature: 'signature-empty' },
    },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'redacted_thinking', data: 'opaque-redacted' },
    },
    { type: 'content_block_stop', index: 2 },
    {
      type: 'content_block_start',
      index: 3,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 3,
      delta: { type: 'text_delta', text: '  calling tools\n' },
    },
    { type: 'content_block_stop', index: 3 },
    ...['search', 'fetch'].flatMap((name, ordinal) => [
      {
        type: 'content_block_start',
        index: ordinal + 4,
        content_block: {
          type: 'tool_use',
          id: `call_${ordinal}`,
          name,
          input: {},
          caller: { type: 'direct' },
        },
      },
      {
        type: 'content_block_delta',
        index: ordinal + 4,
        delta: { type: 'input_json_delta', partial_json: '{"q":' },
      },
      {
        type: 'content_block_delta',
        index: ordinal + 4,
        delta: { type: 'input_json_delta', partial_json: '"x"}' },
      },
      { type: 'content_block_stop', index: ordinal + 4 },
    ]),
    ...terminal('tool_use'),
  ];
}
function response(events: Array<Record<string, unknown>>): Response {
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(''),
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  );
}

describe('canonical Anthropic Messages protocol', () => {
  const fetchModel = vi.fn<typeof fetch>();
  const model = (configuration = CONFIG) =>
    anthropicMessagesModel(configuration, {
      apiKey: 'selected-key',
      fetch: fetchModel,
    });
  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', '');
    fetchModel.mockReset();
    fetchModel.mockImplementation(async () => response(signedEvents()));
  });
  afterEach(() => vi.unstubAllEnvs());

  it('round-trips signed and redacted blocks with two ordered local settlements and exact materialized media', async () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'ambient-bearer');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://ambient.invalid');
    const configured = model();
    const prepared = await Effect.runPromise(
      configured.prepareTurn({ ...REQUEST, toolChoice: { name: 'search' } }),
    );
    assert(prepared.mode === 'foreground');
    expect(fetchModel).not.toHaveBeenCalled();
    const events = await Effect.runPromise(
      Stream.runCollect(configured.streamTurn(prepared)),
    );
    expect(events[0]).toMatchObject({
      kind: 'identified',
      providerResponseId: 'msg_1',
      returnedModel: 'returned-claude',
    });
    expect(events.filter((event) => event.kind === 'identified')).toHaveLength(
      1,
    );
    const completed = events.at(-1);
    assert(completed?.kind === 'completed');
    const result = completed.result;
    expect(result.content).toEqual([
      {
        kind: 'reasoning',
        summary: [],
        content: [{ kind: 'text', text: '  returned thinking\n' }],
        evidence: {
          kind: 'anthropic-thinking-signature',
          signature: 'signature-a',
        },
      },
      {
        kind: 'reasoning',
        summary: [],
        content: [{ kind: 'text', text: '' }],
        evidence: {
          kind: 'anthropic-thinking-signature',
          signature: 'signature-empty',
        },
      },
      {
        kind: 'reasoning',
        summary: [],
        evidence: {
          kind: 'anthropic-redacted-thinking',
          data: 'opaque-redacted',
        },
      },
      {
        kind: 'message',
        content: [{ kind: 'text', text: '  calling tools\n' }],
      },
      {
        kind: 'local-call',
        providerCallId: 'call_0',
        name: 'search',
        arguments: { q: 'x' },
      },
      {
        kind: 'local-call',
        providerCallId: 'call_1',
        name: 'fetch',
        arguments: { q: 'x' },
      },
    ]);
    expect(result.usage).toEqual({
      inputTokens: 62,
      outputTokens: 11,
      totalTokens: 73,
      cachedInputTokens: 20,
      reasoningTokens: 6,
      providerUsage: {
        kind: 'anthropic',
        uncachedInputTokens: 12,
        cacheCreationTokens: 30,
        cacheCreation5mTokens: 11,
        cacheCreation1hTokens: 19,
        serviceTier: 'priority',
        inferenceGeo: 'us',
      },
    });
    const first = JSON.parse(fetchModel.mock.calls[0][1]!.body as string);
    const headers = new Headers(fetchModel.mock.calls[0][1]!.headers);
    expect(String(fetchModel.mock.calls[0][0])).toBe(
      'https://synthetic.invalid/v1/messages',
    );
    expect(headers.get('x-api-key')).toBe('selected-key');
    expect(headers.has('authorization')).toBe(false);
    expect(first).toMatchObject({
      model: 'selected-claude',
      system: REQUEST.system,
      stream: true,
      temperature: 1,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' },
      cache_control: { type: 'ephemeral', ttl: '1h' },
      service_tier: 'auto',
      inference_geo: 'us',
      tool_choice: {
        type: 'tool',
        name: 'search',
        disable_parallel_tool_use: true,
      },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Read these exact bytes.' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: '' },
            },
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: 'AA==',
              },
            },
          ],
        },
      ],
    });
    const next = await Effect.runPromise(
      configured.prepareTurn(
        JSON.parse(
          JSON.stringify({
            ...REQUEST,
            effort: null,
            inferenceGeo: null,
            serviceTier: 'standard-only',
            messages: [
              ...REQUEST.messages,
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
                      { kind: 'text', text: 'ok' },
                      { kind: 'image', mimeType: 'image/png', base64: '' },
                    ],
                  },
                  {
                    callOrdinal: 1,
                    status: 'error',
                    content: [
                      {
                        kind: 'document',
                        mimeType: 'application/pdf',
                        base64: 'AA==',
                      },
                    ],
                  },
                ],
              },
            ],
          }),
        ),
      ),
    );
    assert(next.mode === 'foreground');
    fetchModel.mockImplementationOnce(async () =>
      response([initial(), ...terminal()]),
    );
    await Effect.runPromise(configured.generateTurn(next));
    const sent = JSON.parse(fetchModel.mock.calls[1][1]!.body as string);
    expect(sent).not.toHaveProperty('output_config');
    expect(sent).not.toHaveProperty('inference_geo');
    expect(sent.service_tier).toBe('standard_only');
    expect(sent.messages.slice(1)).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: '  returned thinking\n',
            signature: 'signature-a',
          },
          { type: 'thinking', thinking: '', signature: 'signature-empty' },
          { type: 'redacted_thinking', data: 'opaque-redacted' },
          { type: 'text', text: '  calling tools\n' },
          { type: 'tool_use', id: 'call_0', name: 'search', input: { q: 'x' } },
          { type: 'tool_use', id: 'call_1', name: 'fetch', input: { q: 'x' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_0',
            is_error: false,
            content: [
              { type: 'text', text: 'ok' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: '' },
              },
            ],
          },
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            is_error: true,
            content: [
              {
                type: 'document',
                source: {
                  type: 'base64',
                  media_type: 'application/pdf',
                  data: 'AA==',
                },
              },
            ],
          },
        ],
      },
    ]);
  });

  it.each([
    ['stop_sequence', 'stop-sequence', { stop_sequence: '</done>' }],
    [
      'refusal',
      'refusal',
      {
        stop_details: { type: 'refusal', category: 'cyber', explanation: null },
      },
    ],
    ['model_context_window_exceeded', 'context-window-exceeded', {}],
    ['max_tokens', 'length', {}],
    ['end_turn', 'stop', { stop_details: undefined }],
  ] as const)(
    'preserves terminal %s and partial receipt knowledge',
    async (reason, finishReason, extra) => {
      const start = initial();
      fetchModel.mockImplementation(async () =>
        response([
          {
            ...start,
            message: {
              ...start.message,
              usage: { input_tokens: 7, output_tokens: 0 },
            },
          },
          {
            type: 'message_delta',
            delta: {
              stop_reason: reason,
              stop_sequence: null,
              stop_details: null,
              ...extra,
            },
            usage: { output_tokens: 3 },
          },
          { type: 'message_stop' },
        ]),
      );
      const configured = model();
      const turn = await Effect.runPromise(configured.prepareTurn(REQUEST));
      assert(turn.mode === 'foreground');
      const result = await Effect.runPromise(configured.generateTurn(turn));
      expect(result.finishReason).toBe(finishReason);
      expect(result.content).toEqual([]);
      expect(result.stopSequence).toBe(
        reason === 'stop_sequence' ? '</done>' : undefined,
      );
      if (reason === 'refusal')
        expect(result.refusalEvidence).toEqual({
          kind: 'anthropic-refusal',
          category: 'cyber',
          explanation: null,
        });
      else
        expect(result.refusalEvidence).toBe(
          reason === 'end_turn' ? undefined : null,
        );
      expect(result.usage).toMatchObject({
        inputTokens: null,
        totalTokens: null,
        outputTokens: 3,
        cachedInputTokens: null,
        reasoningTokens: null,
        providerUsage: {
          uncachedInputTokens: 7,
          cacheCreationTokens: null,
          serviceTier: null,
          inferenceGeo: null,
        },
      });
    },
  );

  it.each([
    {
      thinking: { mode: 'enabled', budgetTokens: 1024, display: 'omitted' },
      effort: 'low',
      temperature: 1,
    },
    { thinking: { mode: 'disabled' }, effort: 'medium', temperature: 0.25 },
  ] satisfies Partial<TurnRequest>[])(
    'keeps effort independent of $thinking.mode thinking',
    async (controls) => {
      fetchModel.mockImplementation(async () =>
        response([initial(), ...terminal()]),
      );
      const configured = model();
      const turn = await Effect.runPromise(
        configured.prepareTurn({ ...REQUEST, ...controls }),
      );
      assert(turn.mode === 'foreground');
      await Effect.runPromise(configured.generateTurn(turn));
      const body = JSON.parse(fetchModel.mock.calls[0][1]!.body as string);
      expect(body.output_config.effort).toBe(controls.effort);
      expect(body.temperature).toBe(controls.temperature);
      expect(body.thinking.type).toBe(controls.thinking?.mode);
    },
  );

  it.each([
    { temperature: 0.5 },
    {
      thinking: { mode: 'enabled', budgetTokens: 8192, display: 'summarized' },
    },
    { thinking: { mode: 'enabled' } },
    {
      thinking: { mode: 'enabled', budgetTokens: 1024, display: 'summarized' },
      toolChoice: { name: 'search' },
    },
    { toolChoice: { name: 'absent' } },
    { serviceTier: null },
    { serviceTier: 'fast' },
    { mode: 'background' },
    { store: true },
    {
      messages: [
        {
          role: 'user',
          content: [{ kind: 'audio', mimeType: 'audio/mp3', base64: '' }],
        },
      ],
    },
  ] as const)(
    'rejects unsupported or invalid author controls before I/O: %j',
    async (patch) => {
      await expect(
        Effect.runPromise(model().prepareTurn({ ...REQUEST, ...patch })),
      ).rejects.toMatchObject({ _tag: 'ModelError' });
      expect(fetchModel).not.toHaveBeenCalled();
    },
  );

  it('rejects ambient custom headers before they override the selected credentials', () => {
    vi.stubEnv(
      'ANTHROPIC_CUSTOM_HEADERS',
      'X-Api-Key: another-key\nanthropic-version: another-version',
    );
    expect(() => model()).toThrow(
      expect.objectContaining({ _tag: 'ModelError', kind: 'unsupported' }),
    );
    expect(fetchModel).not.toHaveBeenCalled();
  });

  it.each([
    'null-block',
    'invalid-arguments',
    'prototype-arguments',
    'missing-signature',
    'duplicate-call',
    'missing-stop',
    'pause',
    'citations',
    'wrong-stop-sequence',
  ] as const)(
    'rejects %s without completing or losing learned identity',
    async (variant) => {
      const events = signedEvents();
      if (variant === 'null-block')
        events[1] = {
          type: 'content_block_start',
          index: 0,
          content_block: null,
        };
      else if (
        variant === 'invalid-arguments' ||
        variant === 'prototype-arguments'
      ) {
        events[14] = {
          type: 'content_block_delta',
          index: 4,
          delta: {
            type: 'input_json_delta',
            partial_json:
              variant === 'invalid-arguments' ? '[' : '{"__proto__":',
          },
        };
      } else if (variant === 'missing-signature') events.splice(3, 1);
      else if (variant === 'duplicate-call')
        events[17] = {
          type: 'content_block_start',
          index: 5,
          content_block: {
            type: 'tool_use',
            id: 'call_0',
            name: 'fetch',
            input: {},
          },
        };
      else if (variant === 'missing-stop') events.pop();
      else if (variant === 'pause')
        events.splice(-2, 2, ...terminal('pause_turn'));
      else if (variant === 'citations')
        events[10] = {
          type: 'content_block_start',
          index: 3,
          content_block: {
            type: 'text',
            text: '',
            citations: [{ source: 'unrepresented' }],
          },
        };
      else
        events.splice(
          -2,
          2,
          ...terminal('end_turn', { stop_sequence: 'unexpected' }),
        );
      fetchModel.mockImplementation(async () => response(events));
      const configured = model();
      const turn = await Effect.runPromise(configured.prepareTurn(REQUEST));
      assert(turn.mode === 'foreground');
      await expect(
        Effect.runPromise(configured.generateTurn(turn)),
      ).rejects.toMatchObject({
        _tag: 'ModelError',
        responseId: 'msg_1',
        model: 'returned-claude',
      });
    },
  );

  it.each([
    [401, 'authentication'],
    [429, 'provider-rejection'],
    [undefined, 'transport'],
  ] as const)(
    'classifies actual SDK failure %s without retry',
    async (status, kind) => {
      fetchModel.mockImplementation(async () => {
        if (status === undefined) throw new TypeError('Network failed');
        return new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'test_error', message: 'Rejected' },
          }),
          {
            status,
            headers: {
              'content-type': 'application/json',
              'request-id': 'request_1',
            },
          },
        );
      });
      const configured = model();
      const turn = await Effect.runPromise(configured.prepareTurn(REQUEST));
      assert(turn.mode === 'foreground');
      await expect(
        Effect.runPromise(configured.generateTurn(turn)),
      ).rejects.toMatchObject({
        _tag: 'ModelError',
        kind,
        model: 'selected-claude',
        ...(status === undefined ? {} : { status, requestId: 'request_1' }),
      });
      expect(fetchModel).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    'headers',
    'body',
    'failed-read',
    'malformed',
    'successful-take',
    'completed',
  ] as const)(
    'owns the pending %s lifetime without an emitter or remote cancellation',
    async (phase) => {
      let enter: () => void = () => {};
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      let aborted = false;
      const cleanupFailure = new Error('Cleanup failed');
      let bodyController: ReadableStreamDefaultController<Uint8Array>;
      fetchModel.mockImplementation(async (_url, init) => {
        assert(init?.signal);
        const signal = init.signal;
        if (phase === 'headers')
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                aborted = true;
                reject(new DOMException('Aborted', 'AbortError'));
              },
              { once: true },
            );
            enter();
          });
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              bodyController = controller;
              controller.enqueue(
                new TextEncoder().encode(
                  (phase === 'completed'
                    ? [initial(), ...terminal()]
                    : signedEvents().slice(0, 3)
                  )
                    .map((event, index) =>
                      phase === 'malformed' && index === 1
                        ? {
                            type: 'content_block_start',
                            index: 0,
                            content_block: null,
                          }
                        : event,
                    )
                    .map(
                      (event) =>
                        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                    )
                    .join(''),
                ),
              );
              signal.addEventListener(
                'abort',
                () => {
                  aborted = true;
                  if (phase === 'body' || phase === 'completed')
                    controller.error(new DOMException('Aborted', 'AbortError'));
                },
                { once: true },
              );
            },
            cancel() {
              if (phase === 'successful-take' || phase === 'malformed')
                throw cleanupFailure;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      });
      const configured = model();
      const turn = await Effect.runPromise(configured.prepareTurn(REQUEST));
      assert(turn.mode === 'foreground');
      const progress = configured
        .streamTurn(turn)
        .pipe(Stream.filter((event) => event.kind === 'delta'));
      if (phase === 'completed') {
        await expect(
          Effect.runPromise(configured.generateTurn(turn)),
        ).resolves.toMatchObject({
          providerResponseId: 'msg_1',
          finishReason: 'stop',
        });
      } else if (phase === 'malformed') {
        const exit = await Effect.runPromise(
          Effect.exit(Stream.runDrain(progress)),
        );
        assert(exit._tag === 'Failure');
        expect(
          exit.cause.reasons.find(Cause.isFailReason)?.error,
        ).toMatchObject({
          kind: 'malformed-output',
          responseId: 'msg_1',
          model: 'returned-claude',
        });
        expect(exit.cause.reasons.find(Cause.isDieReason)?.defect).toBe(
          cleanupFailure,
        );
      } else if (phase === 'successful-take') {
        await expect(
          Effect.runPromise(progress.pipe(Stream.take(1), Stream.runDrain)),
        ).rejects.toThrow('Cleanup failed');
      } else if (phase === 'failed-read') {
        await expect(
          Effect.runPromise(
            Stream.runForEach(progress, () =>
              Effect.sync(() =>
                bodyController.error(new Error('Primary read failed')),
              ),
            ),
          ),
        ).rejects.toMatchObject({
          _tag: 'ModelError',
          responseId: 'msg_1',
          message: 'Primary read failed',
        });
      } else {
        const fiber = Effect.runFork(
          Stream.runForEach(progress, () => Effect.sync(enter)),
        );
        await entered;
        await Effect.runPromise(Fiber.interrupt(fiber));
      }
      expect(aborted).toBe(true);
      expect(fetchModel).toHaveBeenCalledTimes(1);
    },
  );
});
