// Third-party imports
import { openaiResponsesModel } from '@texra-ai/llm/openai-responses';
import { Effect, Fiber, Stream } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import type {
  OpenAIResponsesConfiguration,
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
function sse(frames: object[]): string {
  return frames
    .map(
      (frame, sequence_number) =>
        `data: ${JSON.stringify({ ...frame, sequence_number })}\n\n`,
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
        .pipe(Effect.flatMap(model.generateTurn)),
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
        .pipe(Effect.flatMap(model.generateTurn)),
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
      withoutTemperature
        .prepareTurn(REQUEST)
        .pipe(Effect.flatMap(withoutTemperature.generateTurn)),
    );
    expect(
      JSON.parse(String(fetch.mock.calls[2]?.[1]?.body)).temperature,
    ).toBeUndefined();
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
      model.prepareTurn(REQUEST).pipe(Effect.flatMap(model.generateTurn)),
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
            Effect.flatMap((turn) =>
              Stream.runForEach(model.streamTurn(turn), (event) =>
                Effect.sync(() => {
                  if (event.kind === 'completed') completed();
                  if (event.kind === 'delta') delta();
                }),
              ),
            ),
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
        model.prepareTurn(REQUEST).pipe(Effect.flatMap(model.generateTurn)),
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
