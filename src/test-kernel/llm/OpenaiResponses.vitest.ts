// Node imports
import assert from 'node:assert/strict';
import { once } from 'node:events';

// Third-party imports
import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Schema, Stream } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  completedTurn,
  RemoteOperationSchema,
  type TurnRequest,
} from '@texra-ai/llm';
import { openaiResponsesModel } from '../../../packages/llm/src/api/openaiResponses.js';
import { openaiResponsesWebSocketModel } from '../../../packages/llm/src/api/openaiResponsesWebSocket.js';
import type { OpenAIResponsesConfiguration } from '../../../packages/llm/src/turn.js';

const CONFIG: OpenAIResponsesConfiguration = {
  protocol: 'openai-responses',
  requestedModel: 'synthetic-model',
  deployment: {
    endpoint: 'https://synthetic.invalid/v1',
    credentialScope: 'synthetic-account',
  },
  supportsTemperature: true,
  supportsMaxOutputTokens: true,
  supportsStorage: true,
  supportsDocumentInput: true,
  allowedReasoningEfforts: [
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ],
  instructions: { kind: 'optional' },
  continuationInheritsInstructions: false,
  supportsForcedToolChoice: true,
  openaiEndpoint: true,
  requestDialect: 'openai',
  webSocketStreamParameter: 'implicit',
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
    authentication: { kind: 'api-key', apiKey: 'synthetic-not-a-secret' },
    fetch,
  });
}

const socketServers: WebSocketServer[] = [];
async function socketServer(
  onConnection: (
    socket: WebSocket,
    request: import('node:http').IncomingMessage,
  ) => void,
  options: ConstructorParameters<typeof WebSocketServer>[0] = {},
) {
  const server = new WebSocketServer({
    ...options,
    host: '127.0.0.1',
    port: 0,
  });
  socketServers.push(server);
  server.on('connection', onConnection);
  await once(server, 'listening');
  const address = server.address();
  assert(address !== null && typeof address !== 'string');
  return {
    ...CONFIG,
    deployment: {
      ...CONFIG.deployment,
      endpoint: `http://127.0.0.1:${address.port}/v1`,
    },
  };
}

describe('native OpenAI Responses protocol', () => {
  afterEach(async () => {
    for (const server of socketServers.splice(0)) {
      for (const socket of server.clients) socket.terminate();
      server.close();
      await once(server, 'close');
    }
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.live(
    'owns one WebSocket reader across a second length-limited turn without a chaining anchor',
    () =>
      Effect.gen(function* () {
        const requests: Record<string, unknown>[] = [];
        let connections = 0;
        let closes = 0;
        const configuration = yield* Effect.promise(() =>
          socketServer((socket) => {
            connections += 1;
            socket.once('close', () => {
              closes += 1;
            });
            socket.on('message', (data) => {
              requests.push(JSON.parse(data.toString()));
              const id = `resp_${requests.length}`;
              const limited = requests.length === 2;
              const output =
                requests.length === 1
                  ? OUTPUT
                  : [
                      {
                        ...MESSAGE,
                        status: limited ? 'incomplete' : 'completed',
                      },
                    ];
              for (const [sequence_number, event] of events(
                output,
                snapshot(output, {
                  id,
                  ...(limited
                    ? {
                        status: 'incomplete',
                        incomplete_details: { reason: 'max_output_tokens' },
                      }
                    : {}),
                }),
              ).entries()) {
                const value =
                  'response' in event
                    ? {
                        ...event,
                        response: { ...(event.response as object), id },
                      }
                    : event;
                socket.send(
                  JSON.stringify({
                    ...value,
                    sequence_number,
                    ...(limited &&
                    'type' in event &&
                    event.type === 'response.completed'
                      ? { type: 'response.incomplete' }
                      : {}),
                  }),
                );
              }
            });
          }),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const model = yield* openaiResponsesWebSocketModel(configuration, {
              kind: 'api-key',
              apiKey: 'synthetic-not-a-secret',
            });
            const turn = yield* model.prepareTurn(REQUEST);
            assert(
              turn.protocol === 'openai-responses' &&
                turn.mode === 'foreground',
            );
            const first = yield* completedTurn(model.streamTurn(turn));
            assert(first.providerResponseId !== null);
            expect(first.continuation).toBeUndefined();
            const nextRequest: TurnRequest = {
              ...REQUEST,
              messages: [
                ...turn.messages,
                {
                  role: 'assistant',
                  origin: first.requestedOrigin,
                  content: first.content,
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
              ],
            };
            const next = yield* model.prepareTurn(nextRequest);
            assert(next.mode === 'foreground');
            const second = yield* completedTurn(model.streamTurn(next));
            expect(second.providerResponseId).toBe('resp_2');
            expect(second.finishReason).toBe('length');
            expect(second.continuation).toBeUndefined();
            const http = modelWith(vi.fn(), configuration);
            expect(
              yield* Effect.flip(completedTurn(http.streamTurn(turn))),
            ).toMatchObject({
              kind: 'unsupported',
            });
            expect(connections).toBe(1);
          }),
        );
        yield* Effect.promise(() => vi.waitFor(() => expect(closes).toBe(1)));
        expect(requests).toHaveLength(2);
        expect(requests[0]).toMatchObject({
          type: 'response.create',
          store: false,
        });
        expect(requests[0]).not.toHaveProperty('stream');
        expect(requests[0]).not.toHaveProperty('background');
        // The websocket lane carries no chaining anchor, so the second turn
        // replays the whole prefix. The lowered calls must carry the provider's
        // own argument bytes, not a re-encoding of their parse.
        expect(requests[1]).not.toHaveProperty('previous_response_id');
        expect(
          (requests[1] as { input: Record<string, unknown>[] }).input.slice(-4),
        ).toEqual([
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'read_file',
            arguments: '{"path":"a"}',
            id: 'fc_1',
            status: 'completed',
          },
          {
            type: 'function_call',
            call_id: 'call_2',
            name: 'read_file',
            arguments: '{"path":"b"}',
            id: 'fc_2',
            status: 'completed',
          },
          { type: 'function_call_output', call_id: 'call_1', output: 'a' },
          {
            type: 'function_call_output',
            call_id: 'call_2',
            output: 'Error: b',
          },
        ]);
      }),
  );

  it.effect(
    'rejects ambient header overrides and disables SDK diagnostic logging',
    () =>
      Effect.gen(function* () {
        const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
          new Response('data: malformed-provider-data\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          }),
        );
        const construct = () => modelWith(fetch);
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
        const turn = yield* model.prepareTurn(REQUEST);
        assert(turn.mode === 'foreground');
        expect(
          yield* Effect.flip(completedTurn(model.streamTurn(turn))),
        ).toMatchObject({
          kind: 'malformed-output',
        });
        for (const log of logs) expect(log).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'joins submission detach, resumes only the accepted job and anchors its continuation',
    () =>
      Effect.gen(function* () {
        let finishCancellation!: () => void;
        const cancellation = new Promise<void>((resolve) => {
          finishCancellation = resolve;
        });
        // Completed when the acceptance body is cancelled, the fact the
        // submission detach used to be polled for.
        const cancelling = yield* Deferred.make<void>();
        const cancelBody = () => {
          Deferred.doneUnsafe(cancelling, Effect.void);
          return cancellation;
        };
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
            type: 'response.output_item.added',
            output_index: 0,
            item: { ...REASONING, status: 'in_progress', summary: [] },
          },
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: REASONING,
          },
          {
            type: 'response.output_text.delta',
            output_index: 1,
            item_id: 'msg_1',
            delta: 'Progress only',
          },
          {
            type: 'response.output_item.done',
            output_index: 1,
            item: MESSAGE,
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
        const configuration = { ...CONFIG, background: 'supported' as const };
        const model = modelWith(fetch, configuration);
        assert(model.background);
        const turn = yield* model.prepareTurn({
          ...REQUEST,
          mode: 'background',
          store: true,
          system: 'policy',
        });
        assert(
          turn.mode === 'background' && turn.protocol === 'openai-responses',
        );
        const fiber = yield* Effect.forkChild(
          model.background
            .submit(turn)
            .pipe(Effect.tap(() => Effect.sync(submissionFinished))),
        );
        yield* Deferred.await(cancelling);
        expect(submissionFinished).not.toHaveBeenCalled();
        finishCancellation();
        const accepted = yield* Fiber.join(fiber);
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
        // observe subtracts Clock.currentTimeMillis, which TestClock starts at 0.
        const policy = { deadlineAtMs: 60_000 };
        const initial = yield* Stream.runCollect(
          model.background
            .observe(turn, accepted.operation, policy)
            .pipe(Stream.take(3)),
        );
        expect(initial[0]).toMatchObject({
          kind: 'identified',
          afterSequence: 1,
        });
        expect(initial.slice(1)).toEqual([
          { kind: 'cursor', afterSequence: 2 },
          { kind: 'cursor', afterSequence: 3 },
        ]);
        const resumed = yield* Stream.runCollect(
          model.background.observe(
            turn,
            Schema.decodeUnknownSync(RemoteOperationSchema)({
              ...accepted.operation,
              afterSequence: 3,
            }),
            policy,
          ),
        );
        expect(
          resumed.map((event) => [event.kind, event.afterSequence]),
        ).toEqual([
          ['delta', 4],
          ['cursor', 5],
          ['completed', 6],
        ]);
        const terminal = resumed.at(-1);
        assert(terminal?.kind === 'completed');
        // An observed background turn anchors exactly as a foreground one does.
        const continuation = terminal.result.continuation;
        assert(continuation && 'responseId' in continuation.anchor);
        expect(continuation).toMatchObject({
          coveredMessages: 2,
          anchor: { kind: 'stored', responseId: 'resp_1', coveredItems: 5 },
        });
        const retrievals = fetch.mock.calls.filter(
          ([, init]) => init?.method === 'GET',
        );
        expect(
          retrievals.map(([url]) =>
            new URL(String(url)).searchParams.get('starting_after'),
          ),
        ).toEqual(['0', '3']);
        for (const [url] of retrievals)
          expect(String(url)).toContain('reasoning.encrypted_content');
      }),
  );

  it.effect(
    'preserves grouped completed items, encrypted evidence and original tool IDs through a sparse terminal snapshot',
    () =>
      Effect.gen(function* () {
        const laterReasoning = {
          type: 'reasoning',
          id: 'rs_2',
          status: 'completed',
          summary: [],
          encrypted_content: 'enc_later',
        };
        const output = [...OUTPUT, laterReasoning];
        const frames = events(
          output,
          snapshot(
            [
              {
                type: REASONING.type,
                id: REASONING.id,
                summary: REASONING.summary,
                content: REASONING.content,
              },
              CALLS[0]!,
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
            summary: [],
            content: [],
            encrypted_content: 'enc_partial',
          },
        };
        frames.splice(4, 0, {
          type: 'response.output_text.delta',
          output_index: 1,
          item_id: 'msg_1',
          delta: 'I will check.',
        });
        // The ChatGPT backend's side-channel notice adds nothing to the turn.
        frames.splice(1, 0, {
          type: 'response.metadata',
          metadata: { openai_chatgpt_moderation_metadata: {} },
        });
        const fetch = vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValueOnce(response(frames))
          .mockResolvedValueOnce(response(events([MESSAGE])));
        const model = modelWith(fetch);
        const turn = yield* model.prepareTurn(REQUEST);
        assert(turn.mode === 'foreground');
        const collected = yield* Stream.runCollect(model.streamTurn(turn));
        expect(collected[0]).toMatchObject({
          kind: 'identified',
          providerResponseId: 'resp_1',
          returnedModel: 'returned-model',
        });
        expect(collected.slice(1, -1)).toEqual([
          { kind: 'delta', part: 'text', text: 'I will check.' },
        ]);
        const terminal = collected.at(-1);
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
              argumentsText: '{"path":"a"}',
              evidence: { itemId: 'fc_1' },
            },
            {
              kind: 'local-call',
              providerCallId: 'call_2',
              argumentsText: '{"path":"b"}',
              evidence: { itemId: 'fc_2' },
            },
            {
              kind: 'reasoning',
              summary: [],
              evidence: { itemId: 'rs_2', encryptedContent: 'enc_later' },
            },
          ],
        });
        yield* model
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
              return completedTurn(model.streamTurn(turn));
            }),
          );
        expect(
          JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).input,
        ).toEqual([
          {
            role: 'user',
            content: [{ type: 'input_text', text: 'Compare two files.' }],
          },
          ...output,
          {
            type: 'function_call_output',
            call_id: 'call_1',
            output: 'file text',
          },
          {
            type: 'function_call_output',
            call_id: 'call_2',
            output: 'Error: missing',
          },
        ]);
      }),
  );
});
