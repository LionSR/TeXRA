// Node imports
import assert from 'node:assert/strict';
import { once } from 'node:events';

// Third-party imports
import { it } from '@effect/vitest';
import { Cause, Deferred, Effect, Fiber, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { afterEach, describe, expect, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  ContinuationSchema,
  RemoteOperationSchema,
  completedTurn,
} from '@texra-ai/llm/turn';
import {
  RESPONSES_PREFIX_DOMAIN,
  openaiResponsesContinuation,
  openaiResponsesModel,
  openaiResponsesWebSocketModel,
} from '@texra-ai/llm/openai-responses';
import { admittedFingerprint } from '@texra-ai/llm/prefix-fingerprint';
import { createDeferred } from '@test/support/asyncTestUtils';
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
const SUBSCRIPTION_CONFIG: OpenAIResponsesConfiguration = {
  ...CONFIG,
  supportsTemperature: false,
  supportsMaxOutputTokens: false,
  supportsStorage: false,
  supportsDocumentInput: false,
  allowedReasoningEfforts: ['low', 'medium'],
  instructions: {
    kind: 'required',
    fallback: "Follow the user's instructions.",
  },
  webSocketStreamParameter: 'required',
  defaults: {
    ...CONFIG.defaults,
    temperature: null,
    maxOutputTokens: null,
    store: false,
    reasoning: { effort: 'medium', mode: null, summary: 'auto' },
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
  // A handle only: cancellation never reads the digest, and every case that
  // observes takes the operation `backgroundTurn` derives from its own
  // admitted turn.
  admittedFingerprint: 'f'.repeat(64),
  store: false,
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

/** The admitted turn an observation anchors to, with the handle a submission
 *  of it would leave: the operation records the digest of what it admitted.
 *  Unstored by default, so it leaves no continuation unless a case asks. */
function backgroundTurn(model: ReturnType<typeof modelWith>) {
  return Effect.map(
    model.prepareTurn({ ...REQUEST, mode: 'background' }),
    (turn) => {
      assert(
        turn.mode === 'background' && turn.protocol === 'openai-responses',
      );
      return {
        admitted: turn,
        operation: {
          ...OPERATION,
          admittedFingerprint: admittedFingerprint(
            RESPONSES_PREFIX_DOMAIN,
            turn,
          ),
          store: turn.controls.store,
        },
      };
    },
  );
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

  it.live.each(['stop', 'length'] as const)(
    'owns one WebSocket reader across a second %s turn without a chaining anchor',
    (outcome) =>
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
              const limited = requests.length === 2 && outcome === 'length';
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
            expect(turn.transport.kind).toBe('websocket');
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
            assert(second.providerResponseId !== null);
            expect(second.providerResponseId).toBe('resp_2');
            expect(second.finishReason).toBe(outcome);
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

  it.live(
    'invalidates and joins an interrupted WebSocket before explicit reacquisition',
    () =>
      Effect.gen(function* () {
        let connections = 0;
        let requests = 0;
        let closes = 0;
        const configuration = yield* Effect.promise(() =>
          socketServer((socket) => {
            connections += 1;
            socket.once('close', () => {
              closes += 1;
            });
            socket.on('message', () => {
              requests += 1;
              const frames =
                connections === 1
                  ? [
                      {
                        type: 'response.created',
                        response: snapshot([], { status: 'in_progress' }),
                      },
                    ]
                  : events([MESSAGE]);
              for (const [sequence_number, frame] of frames.entries())
                socket.send(JSON.stringify({ ...frame, sequence_number }));
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
            assert(turn.mode === 'foreground');
            const fiber = yield* completedTurn(model.streamTurn(turn)).pipe(
              Effect.forkChild,
            );
            yield* Effect.promise(() =>
              vi.waitFor(() => expect(requests).toBe(1)),
            );
            expect(
              yield* Effect.flip(completedTurn(model.streamTurn(turn))),
            ).toMatchObject({
              kind: 'unsupported',
            });
            yield* Fiber.interrupt(fiber);
            const exit = yield* Fiber.await(fiber);
            assert(exit._tag === 'Failure');
            expect(Cause.hasInterrupts(exit.cause)).toBe(true);
            yield* Effect.promise(() =>
              vi.waitFor(() => expect(closes).toBe(1)),
            );
            expect(
              yield* Effect.flip(completedTurn(model.streamTurn(turn))),
            ).toMatchObject({
              kind: 'transport',
            });
            expect(connections).toBe(1);
            const fresh = yield* openaiResponsesWebSocketModel(configuration, {
              kind: 'api-key',
              apiKey: 'synthetic-not-a-secret',
            });
            expect(
              yield* Effect.flip(completedTurn(fresh.streamTurn(turn))),
            ).toMatchObject({
              kind: 'unsupported',
            });
            const admitted = yield* fresh.prepareTurn(REQUEST);
            assert(admitted.mode === 'foreground');
            expect(
              (yield* completedTurn(fresh.streamTurn(admitted))).finishReason,
            ).toBe('stop');
            expect(connections).toBe(2);
            expect(requests).toBe(2);
          }),
        );
        yield* Effect.promise(() => vi.waitFor(() => expect(closes).toBe(2)));
      }),
  );

  it.live.each([
    'binary',
    'malformed-json',
    'foreign-lane',
    'post-terminal',
    'rejection',
    'streaming-rejection',
    'connection-limit',
  ] as const)(
    'rejects %s WebSocket traffic and does not reuse that connection',
    (variant) =>
      Effect.gen(function* () {
        let requests = 0;
        let closed = false;
        const configuration = yield* Effect.promise(() =>
          socketServer((socket) => {
            socket.once('close', () => {
              closed = true;
            });
            socket.on('message', () => {
              requests += 1;
              if (variant === 'binary') socket.send(Buffer.from('{}'));
              else if (variant === 'malformed-json') socket.send('{');
              else if (variant === 'foreign-lane')
                socket.send(
                  JSON.stringify({
                    type: 'response.created',
                    stream_id: 'other',
                    sequence_number: 0,
                    response: snapshot([], { status: 'in_progress' }),
                  }),
                );
              else if (variant === 'connection-limit')
                socket.send(
                  JSON.stringify({
                    type: 'error',
                    status: 400,
                    error: {
                      type: 'invalid_request_error',
                      code: 'websocket_connection_limit_reached',
                      message:
                        'Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue.',
                    },
                  }),
                );
              else if (variant === 'streaming-rejection')
                socket.send(
                  JSON.stringify({
                    type: 'error',
                    sequence_number: 0,
                    code: 'server_error',
                    message: 'Synthetic streaming rejection',
                    param: null,
                  }),
                );
              else if (variant === 'rejection')
                socket.send(
                  JSON.stringify({
                    type: 'error',
                    status: 429,
                    error: {
                      type: 'rate_limit_error',
                      code: 'rate_limit_exceeded',
                      message: 'Synthetic request rejection',
                      param: null,
                    },
                  }),
                );
              else {
                for (const [sequence_number, frame] of events([
                  MESSAGE,
                ]).entries())
                  socket.send(JSON.stringify({ ...frame, sequence_number }));
                socket.send(
                  JSON.stringify({
                    type: 'response.created',
                    sequence_number: 0,
                    response: snapshot([], {
                      id: 'unrequested',
                      status: 'in_progress',
                    }),
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
            assert(turn.mode === 'foreground');
            // Separate frames may arrive before or after the terminal is consumed.
            const first = yield* Effect.result(
              completedTurn(model.streamTurn(turn)),
            );
            if (first._tag === 'Success') {
              expect(variant).toBe('post-terminal');
              expect(first.success).toMatchObject({
                providerResponseId: 'resp_1',
                finishReason: 'stop',
              });
            } else {
              const error = first.failure;
              expect(error.kind).toBe(
                variant === 'rejection' ||
                  variant === 'streaming-rejection' ||
                  variant === 'connection-limit'
                  ? 'provider-rejection'
                  : 'malformed-output',
              );
              if (variant === 'rejection')
                expect(error).toMatchObject({
                  status: 429,
                  message: 'Synthetic request rejection',
                });
              if (variant === 'connection-limit')
                expect(error).toMatchObject({
                  status: 400,
                  cause: { code: 'websocket_connection_limit_reached' },
                  message:
                    'Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue.',
                });
            }
            // Closure must occur while acquisition is still alive, not at scope exit.
            yield* Effect.promise(() =>
              vi.waitFor(() => expect(closed).toBe(true)),
            );
            yield* Effect.flip(completedTurn(model.streamTurn(turn)));
            expect(requests).toBe(1);
          }),
        );
      }),
  );

  it.live(
    'retains handshake rejection evidence and sends the selected Codex account headers',
    () =>
      Effect.gen(function* () {
        let headers: import('node:http').IncomingHttpHeaders | undefined;
        const configuration = yield* Effect.promise(() =>
          socketServer(() => {}, {
            verifyClient(info, done) {
              headers = info.req.headers;
              done(false, 401, 'Unauthorized', {
                'x-request-id': 'handshake_1',
              });
            },
          }),
        );
        vi.stubEnv('OPENAI_CUSTOM_HEADERS', 'X-Synthetic: ambient');
        expect(
          yield* Effect.scoped(
            Effect.flip(
              openaiResponsesWebSocketModel(configuration, {
                kind: 'codex',
                accessToken: 'selected-token',
                accountId: 'selected-account',
              }),
            ),
          ),
        ).toMatchObject({ kind: 'unsupported' });
        expect(headers).toBeUndefined();
        vi.stubEnv('OPENAI_CUSTOM_HEADERS', '');
        const error = yield* Effect.scoped(
          Effect.flip(
            openaiResponsesWebSocketModel(configuration, {
              kind: 'codex',
              accessToken: 'selected-token',
              accountId: 'selected-account',
            }),
          ),
        );
        expect(error).toMatchObject({
          kind: 'authentication',
          status: 401,
          requestId: 'handshake_1',
        });
        expect(headers).toMatchObject({
          authorization: 'Bearer selected-token',
          'chatgpt-account-id': 'selected-account',
          originator: 'texra',
          'openai-beta': 'responses=experimental',
        });
      }),
  );

  it.live(
    'sends the selected subscription WebSocket policy without rewriting admitted controls',
    () =>
      Effect.gen(function* () {
        const requests: Record<string, unknown>[] = [];
        let headers: import('node:http').IncomingHttpHeaders | undefined;
        const local = yield* Effect.promise(() =>
          socketServer((socket, request) => {
            headers = request.headers;
            socket.on('message', (data) => {
              requests.push(JSON.parse(data.toString()));
              for (const [sequence_number, frame] of events([
                MESSAGE,
              ]).entries())
                socket.send(JSON.stringify({ ...frame, sequence_number }));
            });
          }),
        );
        const selected = {
          ...SUBSCRIPTION_CONFIG,
          deployment: local.deployment,
        };
        yield* Effect.scoped(
          Effect.gen(function* () {
            const model = yield* openaiResponsesWebSocketModel(selected, {
              kind: 'codex',
              accessToken: 'selected-token',
              accountId: 'selected-account',
            });
            const turn = yield* model.prepareTurn({ ...REQUEST, system: ' ' });
            assert(turn.mode === 'foreground');
            const result = yield* completedTurn(model.streamTurn(turn));
            assert(result.providerResponseId !== null);
            expect(result.continuation).toBeUndefined();
            expect(
              yield* Effect.flip(
                model.prepareTurn({ ...REQUEST, mode: 'background' }),
              ),
            ).toMatchObject({ kind: 'unsupported' });
            expect(model.background).toBeUndefined();
          }),
        );
        expect(headers).toMatchObject({
          authorization: 'Bearer selected-token',
          'chatgpt-account-id': 'selected-account',
          originator: 'texra',
          'openai-beta': 'responses=experimental',
        });
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
          type: 'response.create',
          stream: true,
          store: false,
          instructions: "Follow the user's instructions.",
          reasoning: { effort: 'medium' },
        });
        expect(requests[0]).not.toHaveProperty('background');
        expect(requests[0]).not.toHaveProperty('max_output_tokens');
        expect(requests[0]).not.toHaveProperty('temperature');
      }),
  );

  it.live(
    'invalidates genuinely idle traffic before another turn can be sent',
    () =>
      Effect.gen(function* () {
        let requests = 0;
        let peer: WebSocket | undefined;
        let closed = false;
        const configuration = yield* Effect.promise(() =>
          socketServer((socket) => {
            peer = socket;
            socket.once('close', () => {
              closed = true;
            });
            socket.on('message', () => {
              requests += 1;
              for (const [sequence_number, frame] of events([
                MESSAGE,
              ]).entries())
                socket.send(JSON.stringify({ ...frame, sequence_number }));
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
            assert(turn.mode === 'foreground');
            yield* completedTurn(model.streamTurn(turn));
            peer!.send(
              JSON.stringify({
                type: 'response.created',
                sequence_number: 0,
                response: snapshot([], {
                  id: 'unrequested',
                  status: 'in_progress',
                }),
              }),
            );
            yield* Effect.promise(() =>
              vi.waitFor(() => expect(closed).toBe(true)),
            );
            expect(
              yield* Effect.flip(completedTurn(model.streamTurn(turn))),
            ).toMatchObject({
              kind: 'malformed-output',
            });
            expect(requests).toBe(1);
          }),
        );
      }),
  );

  it.live(
    'owns keepalive timing and rejects an expired connection without reconnecting',
    () =>
      Effect.gen(function* () {
        let pings = 0;
        let connections = 0;
        let requests = 0;
        const configuration = yield* Effect.promise(() =>
          socketServer((socket) => {
            connections += 1;
            socket.on('ping', () => {
              pings += 1;
            });
            socket.on('message', () => {
              requests += 1;
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
            assert(turn.mode === 'foreground');
            yield* TestClock.adjust(30_000);
            yield* Effect.promise(() =>
              vi.waitFor(() => expect(pings).toBeGreaterThan(0)),
            );
            yield* TestClock.adjust(55 * 60_000 - 30_000);
            expect(
              yield* Effect.flip(completedTurn(model.streamTurn(turn))),
            ).toMatchObject({
              kind: 'transport',
            });
            expect(connections).toBe(1);
            expect(requests).toBe(0);
          }),
        ).pipe(Effect.provide(TestClock.layer()));
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
        expect(fetch).toHaveBeenCalledTimes(1);
        for (const log of logs) expect(log).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    "sends a context update as a developer message on OpenAI's endpoint, as user text elsewhere",
    () =>
      Effect.gen(function* () {
        const sent = (openaiEndpoint: boolean) =>
          Effect.gen(function* () {
            const fetch = vi
              .fn<typeof globalThis.fetch>()
              .mockImplementation(async () => response(events([MESSAGE])));
            const model = modelWith(fetch, { ...CONFIG, openaiEndpoint });
            const turn = yield* model.prepareTurn({
              ...REQUEST,
              messages: [
                ...REQUEST.messages,
                { role: 'system', text: 'Skills changed.' },
              ],
            });
            assert(turn.mode === 'foreground');
            yield* completedTurn(model.streamTurn(turn));
            return JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).input.at(
              -1,
            );
          });
        expect(yield* sent(true)).toEqual({
          role: 'developer',
          content: 'Skills changed.',
        });
        expect(yield* sent(false)).toEqual({
          role: 'user',
          content: '<system-update>\nSkills changed.\n</system-update>',
        });
      }),
  );

  it.effect(
    'refuses a document locally on a route that takes no input files',
    () =>
      Effect.gen(function* () {
        const fetch = vi.fn<typeof globalThis.fetch>();
        const model = modelWith(fetch, SUBSCRIPTION_CONFIG);
        const refused = yield* Effect.flip(
          model.prepareTurn({
            messages: [
              {
                role: 'user',
                content: [
                  {
                    kind: 'document',
                    mimeType: 'application/pdf',
                    base64: Buffer.from('%PDF-1.7').toString('base64'),
                  },
                ],
              },
            ],
          }),
        );
        expect(refused).toMatchObject({ kind: 'unsupported' });
        expect(fetch).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'sends a settlement document by its cached file id beside the result text, and by bytes once released',
    () =>
      Effect.gen(function* () {
        const fetch = vi
          .fn<typeof globalThis.fetch>()
          .mockImplementation(async (url, init) => {
            const target = String(url);
            if (target.startsWith('data:')) return new Response('%PDF-1.7');
            if (target.endsWith('/files'))
              return new Response(
                JSON.stringify({ id: 'file_uploaded', expires_at: 86_400 }),
                { headers: { 'content-type': 'application/json' } },
              );
            if (init?.method === 'DELETE')
              return new Response(
                JSON.stringify({
                  id: 'file_uploaded',
                  object: 'file',
                  deleted: true,
                }),
                { headers: { 'content-type': 'application/json' } },
              );
            return response(events([MESSAGE]));
          });
        const model = modelWith(fetch);
        assert(model.uploadFile && model.releaseUploads);
        const pdf = Buffer.from('%PDF-1.7').toString('base64');
        yield* model.uploadFile({
          mimeType: 'application/pdf',
          filename: 'paper.pdf',
          base64: pdf,
        });
        const turn = yield* model.prepareTurn({
          ...REQUEST,
          messages: [
            ...REQUEST.messages,
            {
              role: 'assistant',
              origin: OPERATION.origin,
              content: [
                {
                  kind: 'local-call',
                  providerCallId: 'call_1',
                  name: 'read_file',
                  argumentsText: '{}',
                },
              ],
            },
            {
              role: 'tool',
              results: [
                {
                  callOrdinal: 0,
                  status: 'success',
                  content: [
                    { kind: 'text', text: 'Downloaded paper.pdf' },
                    {
                      kind: 'document',
                      mimeType: 'application/pdf',
                      base64: pdf,
                    },
                  ],
                },
              ],
            },
          ],
        });
        assert(turn.mode === 'foreground');
        const sentOutput = Effect.gen(function* () {
          yield* completedTurn(model.streamTurn(turn));
          const request = fetch.mock.calls.findLast(([url]) =>
            String(url).endsWith('/responses'),
          );
          assert(request);
          return JSON.parse(String(request[1]?.body)).input.at(-1).output;
        });
        expect(yield* sentOutput).toStrictEqual([
          { type: 'input_text', text: 'Downloaded paper.pdf' },
          { type: 'input_file', file_id: 'file_uploaded' },
        ]);
        expect(yield* model.releaseUploads()).toStrictEqual([]);
        expect(yield* sentOutput).toStrictEqual([
          { type: 'input_text', text: 'Downloaded paper.pdf' },
          {
            type: 'input_file',
            filename: 'document.pdf',
            file_data: `data:application/pdf;base64,${pdf}`,
          },
        ]);
      }),
  );

  it.effect(
    'joins submission detach, resumes only the accepted job and constructs continuation from admitted input',
    () =>
      Effect.gen(function* () {
        let finishCancellation!: () => void;
        const cancellation = new Promise<void>((resolve) => {
          finishCancellation = resolve;
        });
        // Completed when the acceptance body is cancelled, the fact the
        // submission detach used to be polled for.
        const cancelling = yield* Deferred.make<void>();
        const cancelBody = vi.fn(() => {
          Deferred.doneUnsafe(cancelling, Effect.void);
          return cancellation;
        });
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
        expect(cancelBody).toHaveBeenCalledTimes(1);
        expect(submissionFinished).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledTimes(1);
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
          // Recorded at admission, so the resumed observation below can tell
          // that this turn is still the one the provider answered.
          admittedFingerprint: admittedFingerprint(
            RESPONSES_PREFIX_DOMAIN,
            turn,
          ),
          // The storage mode the provider admitted, which a resumed
          // observation re-prepares with instead of the current setting.
          store: true,
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
          {
            kind: 'phase',
            part: 'reasoning',
            boundary: 'start',
            providerItemIndex: 0,
            afterSequence: 2,
          },
          {
            kind: 'phase',
            part: 'reasoning',
            boundary: 'end',
            providerItemIndex: 0,
            afterSequence: 3,
          },
        ]);
        const resumed = yield* Stream.runCollect(
          model.background.observe(
            turn,
            RemoteOperationSchema.parse({
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
          ['phase', 5],
          ['completed', 6],
        ]);
        expect(resumed.slice(0, 2)).toEqual([
          {
            kind: 'delta',
            part: 'text',
            text: 'Progress only',
            providerItemIndex: 1,
            afterSequence: 4,
          },
          {
            kind: 'phase',
            part: 'text',
            boundary: 'end',
            providerItemIndex: 1,
            afterSequence: 5,
          },
        ]);
        const terminal = resumed.at(-1);
        assert(terminal?.kind === 'completed');
        const continuation = yield* openaiResponsesContinuation(
          configuration,
          turn,
          terminal.result,
        );
        assert(continuation && 'responseId' in continuation.anchor);
        // An observed background turn anchors exactly as a foreground one does.
        expect(terminal.result.continuation).toEqual(continuation);
        expect(continuation).toMatchObject({
          coveredMessages: 2,
          anchor: { kind: 'stored', responseId: 'resp_1', coveredItems: 5 },
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
        const next = yield* model.prepareTurn(nextRequest);
        assert(next.mode === 'foreground');
        yield* completedTurn(model.streamTurn(next));
        expect(
          JSON.parse(String(fetch.mock.calls.at(-1)?.[1]?.body)),
        ).toMatchObject({
          previous_response_id: 'resp_1',
          instructions: 'policy',
          input: [
            { type: 'function_call_output', call_id: 'call_1', output: 'a' },
            {
              type: 'function_call_output',
              call_id: 'call_2',
              output: 'Error: b',
            },
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
          expect((yield* Effect.flip(model.prepareTurn(request))).kind).toBe(
            'invalid-request',
          );
        const retrievals = fetch.mock.calls.filter(
          ([, init]) => init?.method === 'GET',
        );
        expect(retrievals).toHaveLength(2);
        expect(
          retrievals.map(([url]) =>
            new URL(String(url)).searchParams.get('starting_after'),
          ),
        ).toEqual(['0', '3']);
        for (const [url] of retrievals)
          expect(String(url)).toContain('reasoning.encrypted_content');
        expect(fetch).toHaveBeenCalledTimes(4);
      }),
  );

  it.effect(
    'reads an xAI receipt and chains without resending instructions',
    () =>
      Effect.gen(function* () {
        const message = {
          ...MESSAGE,
          phase: undefined,
          content: [
            {
              type: 'output_text',
              text: 'Done.',
              annotations: [],
              logprobs: null,
            },
          ],
        };
        const fetch = vi
          .fn<typeof globalThis.fetch>()
          .mockImplementation(async () =>
            response(
              events(
                [message],
                snapshot([message], {
                  usage: {
                    input_tokens: 32,
                    output_tokens: 9,
                    total_tokens: 151,
                    input_tokens_details: { cached_tokens: 8 },
                    output_tokens_details: { reasoning_tokens: 110 },
                    cost_in_usd_ticks: 70,
                  },
                }),
              ),
            ),
          );
        const model = modelWith(fetch, {
          ...CONFIG,
          continuationInheritsInstructions: true,
          defaults: { ...CONFIG.defaults, store: true },
        });
        const first = yield* model.prepareTurn({
          ...REQUEST,
          system: 'policy',
        });
        assert(first.mode === 'foreground');
        const result = yield* completedTurn(model.streamTurn(first));
        assert(result.kind === 'http');
        expect(result.usage?.providerUsage).toEqual({
          kind: 'xai',
          costInUsdTicks: 70,
        });
        assert(result.continuation !== undefined);
        const next = yield* model.prepareTurn({
          ...REQUEST,
          system: 'policy',
          continuation: result.continuation,
          messages: [
            ...first.messages,
            {
              role: 'assistant',
              origin: result.requestedOrigin,
              content: result.content,
            },
            { role: 'user', content: [{ kind: 'text', text: 'Continue.' }] },
          ],
        });
        assert(next.mode === 'foreground');
        yield* completedTurn(model.streamTurn(next));
        const [opening, chained] = fetch.mock.calls.map(([, init]) =>
          JSON.parse(String(init?.body)),
        );
        expect(opening).toMatchObject({ instructions: 'policy' });
        expect(chained).toMatchObject({ previous_response_id: 'resp_1' });
        expect(chained).not.toHaveProperty('instructions');
      }),
  );

  it.effect(
    'sends a compatible route only its documented fields and reads Zhipu output',
    () =>
      Effect.gen(function* () {
        const reasoning = {
          type: 'reasoning',
          id: 'rs_1',
          content: { type: 'reasoning_text', text: 'think' },
        };
        const message = {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Done.' }],
        };
        const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
          response(
            events(
              [reasoning, message],
              snapshot([reasoning, message], {
                usage: { input_tokens: 5, output_tokens: 3 },
              }),
            ),
          ),
        );
        const model = modelWith(fetch, {
          ...CONFIG,
          supportsForcedToolChoice: false,
          requestDialect: 'compatible',
        });
        expect(
          (yield* Effect.flip(
            model.prepareTurn({
              ...REQUEST,
              toolChoice: { name: 'read_file' },
            }),
          )).kind,
        ).toBe('unsupported');
        const turn = yield* model.prepareTurn(REQUEST);
        assert(turn.mode === 'foreground');
        const result = yield* completedTurn(model.streamTurn(turn));
        const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
        expect(body).not.toHaveProperty('include');
        expect(body).not.toHaveProperty('store');
        expect(body.tools[0]).not.toHaveProperty('strict');
        expect(result.content[0]).toMatchObject({
          kind: 'reasoning',
          summary: [],
          content: [{ kind: 'text', text: 'think' }],
        });
        expect(result.usage).toMatchObject({
          inputTokens: 5,
          outputTokens: 3,
          totalTokens: null,
        });
      }),
  );

  it.effect('retains learned acceptance in an unexpected cleanup defect', () =>
    Effect.gen(function* () {
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
      const turn = yield* model.prepareTurn({
        ...REQUEST,
        mode: 'background',
      });
      assert(turn.mode === 'background');
      const exit = yield* Effect.exit(model.background.submit(turn));
      assert(exit._tag === 'Failure');
      const defect = exit.cause.reasons.find(Cause.isDieReason);
      expect(defect?.defect).toMatchObject({
        operation: { providerResponseId: 'resp_1', afterSequence: 0 },
        cause: cleanupFailure,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect.each([
    ['completed', 'stop'],
    ['incomplete', 'length'],
  ])(
    'returns immediate %s output without requiring stored history',
    ([status, finishReason]) =>
      Effect.gen(function* () {
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
        const turn = yield* model.prepareTurn({
          ...REQUEST,
          mode: 'background',
          store: false,
        });
        assert(turn.mode === 'background');
        const submitted = yield* model.background.submit(turn);
        assert(submitted.kind === 'completed');
        expect(submitted.result).toMatchObject({
          finishReason,
          providerResponseId: 'resp_1',
        });
        expect(submitted.result).not.toHaveProperty('continuation');
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(
          JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)),
        ).toMatchObject({
          background: true,
          stream: true,
          store: false,
        });
      }),
  );

  it.effect.each(['submit', 'cancel'] as const)(
    'interrupts a pending %s HTTP read without reporting acceptance or cancellation',
    (operationName) =>
      Effect.gen(function* () {
        let signal: AbortSignal | null | undefined;
        const cancelBody = vi.fn();
        let bodyController!: ReadableStreamDefaultController<Uint8Array>;
        // Completed by the first read, which only happens once the reader
        // holds the body lock.
        const reading = yield* Deferred.make<void>();
        const body = new ReadableStream<Uint8Array>(
          {
            start(controller) {
              bodyController = controller;
            },
            pull() {
              Deferred.doneUnsafe(reading, Effect.void);
            },
            cancel: cancelBody,
          },
          { highWaterMark: 0 },
        );
        const fetch = vi
          .fn<typeof globalThis.fetch>()
          .mockImplementation(async (_url, init) => {
            signal = init?.signal;
            if (operationName === 'cancel') {
              signal?.addEventListener(
                'abort',
                () => bodyController.error(signal?.reason),
                { once: true },
              );
            }
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
        const turn = yield* model.prepareTurn({
          ...REQUEST,
          mode: 'background',
        });
        assert(turn.mode === 'background');
        const completed = vi.fn();
        const task =
          operationName === 'submit'
            ? model.background.submit(turn).pipe(Effect.asVoid)
            : model.background.cancel(OPERATION).pipe(Effect.asVoid);
        const fiber = yield* Effect.forkChild(
          task.pipe(Effect.tap(() => Effect.sync(completed))),
        );
        yield* Deferred.await(reading);
        expect(body.locked).toBe(true);
        yield* Fiber.interrupt(fiber);
        expect(signal?.aborted).toBe(true);
        expect(completed).not.toHaveBeenCalled();
        if (operationName === 'submit')
          expect(cancelBody).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledTimes(1);
      }),
  );

  it.effect.each(['missing', 'failed', 'not-found'] as const)(
    'does not recreate work or advance a terminal cursor after %s observation',
    (outcome) =>
      Effect.gen(function* () {
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
        const { admitted, operation } = yield* backgroundTurn(model);
        const observed: BackgroundEvent[] = [];
        const failure = yield* Effect.flip(
          Stream.runForEach(
            model.background.observe(admitted, operation, {
              deadlineAtMs: Date.now() + 60_000,
            }),
            (event) =>
              Effect.sync(() => {
                observed.push(event);
              }),
          ),
        );
        expect(failure).toMatchObject({
          kind:
            outcome === 'missing' ? 'malformed-output' : 'provider-rejection',
          operation,
          responseId: 'resp_1',
        });
        if (outcome === 'failed')
          expect(failure.message).toBe('Original job failure');
        expect(observed.map((event) => event.afterSequence)).toEqual(
          outcome === 'not-found' ? [] : [0],
        );
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch.mock.calls[0]?.[1]?.method).toBe('GET');
      }),
  );

  it.effect.each(['same', 'omitted', 'changed', 'sparse'] as const)(
    'preserves observed completed evidence against a %s terminal snapshot',
    (variant) =>
      Effect.gen(function* () {
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
          output = [
            { ...REASONING, encrypted_content: 'contradictory_opaque' },
          ];
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
        const { admitted, operation } = yield* backgroundTurn(model);
        const seen: BackgroundEvent[] = [];
        const exit = yield* Effect.exit(
          Stream.runForEach(
            model.background.observe(admitted, operation, {
              deadlineAtMs: Date.now() + 60_000,
            }),
            (event) =>
              Effect.sync(() => {
                seen.push(event);
              }),
          ),
        );
        if (variant === 'sparse') {
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
      }),
  );

  it.effect.each(['foreground', 'observation'] as const)(
    'settles %s at the semantic terminal event while the HTTP body remains open',
    (mode) =>
      Effect.gen(function* () {
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
        const turn = yield* model.prepareTurn(REQUEST);
        assert(turn.mode === 'foreground');
        const { admitted, operation } = yield* backgroundTurn(model);
        const stream: Stream.Stream<TurnEvent | BackgroundEvent, ModelError> =
          mode === 'foreground'
            ? model.streamTurn(turn)
            : model.background.observe(admitted, operation, {
                deadlineAtMs: Date.now() + 60_000,
              });
        const seen = yield* Stream.runCollect(stream);
        const completed = seen.at(-1);
        expect(seen.some((event) => event.kind === 'phase')).toBe(false);
        assert(completed?.kind === 'completed');
        expect(completed).toMatchObject({
          kind: 'completed',
          result: { providerResponseId: 'resp_1', finishReason: 'stop' },
        });
        // Admitted unstored, either way: a temporary response is not there for
        // a next round to chain on, so neither completion leaves an anchor.
        expect(completed.result).not.toHaveProperty('continuation');
        if (mode === 'observation')
          expect(completed).toHaveProperty('afterSequence', 0);
        expect(cancelBody).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledTimes(1);
      }),
  );

  it.effect.each(['headers', 'body'] as const)(
    'keeps the original deadline while waiting for %s and before another request',
    (phase) =>
      Effect.gen(function* () {
        // Completed when the request is issued.
        const started = yield* Deferred.make<void>();
        const cancelled = vi.fn();
        // Completed by the first read, which implies the body lock.
        const reading = yield* Deferred.make<void>();
        const body = new ReadableStream<Uint8Array>(
          {
            pull() {
              Deferred.doneUnsafe(reading, Effect.void);
            },
            cancel: cancelled,
          },
          { highWaterMark: 0 },
        );
        let sendHeaders!: () => void;
        const headers = new Promise<void>((resolve) => {
          sendHeaders = resolve;
        });
        let signal: AbortSignal | null | undefined;
        const fetch = vi
          .fn<typeof globalThis.fetch>()
          .mockImplementation(async (_url, init) => {
            signal = init?.signal;
            Deferred.doneUnsafe(started, Effect.void);
            await headers;
            return new Response(body, {
              headers: { 'content-type': 'text/event-stream' },
            });
          });
        const model = modelWith(fetch, { ...CONFIG, background: 'supported' });
        assert(model.background);
        const background = model.background;
        const { admitted, operation } = yield* backgroundTurn(model);
        const observation = Stream.runDrain(
          background.observe(admitted, operation, { deadlineAtMs: 100 }),
        );
        const fiber = yield* Effect.forkChild(Effect.flip(observation));
        yield* Deferred.await(started);
        yield* TestClock.adjust('40 millis');
        if (phase === 'body') {
          sendHeaders();
          yield* Deferred.await(reading);
          expect(body.locked).toBe(true);
        }
        yield* TestClock.adjust('60 millis');
        expect((yield* Fiber.join(fiber)).kind).toBe('observation-deadline');
        expect(signal?.aborted).toBe(true);
        expect(cancelled).toHaveBeenCalledTimes(phase === 'body' ? 1 : 0);
        expect((yield* Effect.flip(observation)).kind).toBe(
          'observation-deadline',
        );
        expect(fetch).toHaveBeenCalledTimes(1);
        sendHeaders();
        expect(String(fetch.mock.calls[0]?.[0])).not.toContain(
          'starting_after',
        );
      }),
  );

  it.effect(
    'joins an interrupted cancellation body and retains its cleanup failure',
    () =>
      Effect.gen(function* () {
        const entered = createDeferred();
        const aborted = createDeferred();
        const released = createDeferred();
        const failure = new Error('Late cancellation body failure');
        const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
          async (_url, init) =>
            new Response(
              new ReadableStream<Uint8Array>(
                {
                  start(controller) {
                    init!.signal!.addEventListener(
                      'abort',
                      () => {
                        aborted.resolve();
                        void released.promise.then(() =>
                          controller.error(failure),
                        );
                      },
                      { once: true },
                    );
                  },
                  pull() {
                    entered.resolve();
                  },
                },
                { highWaterMark: 0 },
              ),
              {
                headers: {
                  'content-type': 'application/json',
                  'x-request-id': 'cancel_request',
                },
              },
            ),
        );
        const model = modelWith(fetch, { ...CONFIG, background: 'supported' });
        assert(model.background);
        let finished = false;
        const fiber = yield* model.background.cancel(OPERATION).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              finished = true;
            }),
          ),
          Effect.forkChild,
        );
        yield* Effect.promise(() => entered.promise);
        const interruption = yield* Fiber.interrupt(fiber).pipe(
          Effect.forkChild,
        );
        yield* Effect.promise(() => aborted.promise);
        const finishedBeforeRelease = finished;
        released.resolve();
        yield* Fiber.join(interruption);
        const exit = yield* Fiber.await(fiber);
        expect(finishedBeforeRelease).toBe(false);
        assert(exit._tag === 'Failure');
        expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        expect(
          exit.cause.reasons.find(Cause.isDieReason)?.defect,
        ).toMatchObject({
          cause: failure,
          operation: OPERATION,
          responseId: 'resp_1',
          requestId: 'cancel_request',
        });
        expect(fetch).toHaveBeenCalledTimes(1);
      }),
  );

  it.effect.each([
    ['cancelled', 'confirmed-cancelled'],
    ['completed', 'observed-terminal'],
    ['failed', 'observed-terminal'],
    ['incomplete', 'observed-terminal'],
    ['queued', 'unconfirmed'],
    ['in_progress', 'unconfirmed'],
  ])(
    'reports cancellation status %s as %s without claiming ordering',
    ([status, kind]) =>
      Effect.gen(function* () {
        const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
          new Response(JSON.stringify(snapshot([], { status })), {
            headers: { 'content-type': 'application/json' },
          }),
        );
        const model = modelWith(fetch, { ...CONFIG, background: 'supported' });
        assert(model.background);
        const result = yield* model.background.cancel({
          ...OPERATION,
          afterSequence: 0,
        });
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
        const fetch = vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValueOnce(response(frames))
          .mockResolvedValueOnce(
            response(
              events([{ ...MESSAGE, id: 'msg_2', phase: 'final_answer' }]),
            ),
          );
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
          {
            kind: 'phase',
            part: 'reasoning',
            boundary: 'start',
            providerItemIndex: 0,
          },
          {
            kind: 'phase',
            part: 'reasoning',
            boundary: 'end',
            providerItemIndex: 0,
          },
          {
            kind: 'phase',
            part: 'text',
            boundary: 'start',
            providerItemIndex: 1,
          },
          {
            kind: 'delta',
            part: 'text',
            text: 'I will check.',
            providerItemIndex: 1,
          },
          {
            kind: 'phase',
            part: 'text',
            boundary: 'end',
            providerItemIndex: 1,
          },
          {
            kind: 'phase',
            part: 'reasoning',
            boundary: 'start',
            providerItemIndex: 4,
          },
          {
            kind: 'phase',
            part: 'reasoning',
            boundary: 'end',
            providerItemIndex: 4,
          },
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
        const next = yield* model
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
        expect(next.content[0]).toMatchObject({
          kind: 'message',
          evidence: { itemId: 'msg_2', phase: 'final_answer' },
        });
        expect(fetch).toHaveBeenCalledTimes(2);
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

  it.effect(
    "replays another model's history as plain content after a model switch",
    () =>
      Effect.gen(function* () {
        const fetch = vi
          .fn<typeof globalThis.fetch>()
          .mockImplementationOnce(async () => response(events(OUTPUT)))
          .mockImplementation(async () => response(events([MESSAGE])));
        const first = yield* modelWith(fetch)
          .prepareTurn(REQUEST)
          .pipe(
            Effect.flatMap((turn) => {
              assert(turn.mode === 'foreground');
              return completedTurn(modelWith(fetch).streamTurn(turn));
            }),
          );
        // The same route, another model: the run switched after this turn.
        const switched = modelWith(fetch, {
          ...CONFIG,
          requestedModel: 'switched-model',
        });
        const next = yield* switched.prepareTurn({
          ...REQUEST,
          messages: [
            ...REQUEST.messages,
            {
              role: 'assistant',
              origin: first.requestedOrigin,
              content: first.content,
            },
            {
              role: 'tool',
              results: [0, 1].map((callOrdinal) => ({
                callOrdinal,
                status: 'success' as const,
                content: [{ kind: 'text' as const, text: 'ok' }],
              })),
            },
          ],
        });
        assert(next.mode === 'foreground');
        yield* completedTurn(switched.streamTurn(next));
        // No reasoning item, item id, status or encrypted content of the
        // model that wrote the history reaches the one it switched to.
        expect(
          JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).input.slice(1),
        ).toEqual([
          { role: 'assistant', content: 'I will check.Then compare.' },
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'read_file',
            arguments: '{"path":"a"}',
          },
          {
            type: 'function_call',
            call_id: 'call_2',
            name: 'read_file',
            arguments: '{"path":"b"}',
          },
          { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
          { type: 'function_call_output', call_id: 'call_2', output: 'ok' },
        ]);
      }),
  );

  it.effect(
    'sends configured controls, distinguishing explicit null from numeric zero',
    () =>
      Effect.gen(function* () {
        const fetch = vi
          .fn<typeof globalThis.fetch>()
          .mockImplementation(async () => response(events([MESSAGE])));
        const config = {
          ...CONFIG,
          defaults: {
            ...CONFIG.defaults,
            temperature: 0,
            parallelToolCalls: false,
          },
        };
        const model = modelWith(fetch, config);
        const turn = yield* model.prepareTurn({
          ...REQUEST,
          toolChoice: { name: 'read_file' },
        });
        assert(turn.mode === 'foreground');
        yield* completedTurn(model.streamTurn(turn));
        expect(
          JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)),
        ).toMatchObject({
          temperature: 0,
          parallel_tool_calls: false,
          tool_choice: { type: 'function', name: 'read_file' },
          reasoning: { effort: 'high', mode: 'pro', summary: 'auto' },
          service_tier: 'fast',
          store: false,
          include: ['reasoning.encrypted_content'],
        });
        const withoutReasoning = modelWith(fetch, {
          ...config,
          defaults: { ...config.defaults, reasoning: null, serviceTier: null },
        });
        yield* withoutReasoning.prepareTurn(REQUEST).pipe(
          Effect.flatMap((turn) => {
            assert(turn.mode === 'foreground');
            return completedTurn(withoutReasoning.streamTurn(turn));
          }),
        );
        const omitted = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
        expect(omitted.reasoning).toBeUndefined();
        expect(omitted.service_tier).toBeUndefined();
        const withoutTemperature = modelWith(fetch, {
          ...CONFIG,
          supportsTemperature: false,
          defaults: { ...CONFIG.defaults, temperature: null },
        });
        yield* withoutTemperature.prepareTurn(REQUEST).pipe(
          Effect.flatMap((turn) => {
            assert(turn.mode === 'foreground');
            return completedTurn(withoutTemperature.streamTurn(turn));
          }),
        );
        expect(
          JSON.parse(String(fetch.mock.calls[2]?.[1]?.body)).temperature,
        ).toBeUndefined();
        expect(fetch).toHaveBeenCalledTimes(3);
        for (const request of [
          {
            ...REQUEST,
            continuation: {
              origin: { ...OPERATION.origin, protocol: 'google-interactions' },
              coveredMessages: 1,
              prefixFingerprint: 'a'.repeat(64),
              anchor: { interactionId: 'int_1', coveredSteps: 1 },
            },
          },
          ...(
            [
              {
                kind: 'reasoning',
                summary: [],
                evidence: { kind: 'openrouter-reasoning', details: [] },
              },
            ] as const
          ).map((part) => ({
            ...REQUEST,
            messages: [
              ...REQUEST.messages,
              {
                role: 'assistant' as const,
                origin: {
                  ...OPERATION.origin,
                  protocol: 'openrouter-chat' as const,
                },
                content: [part],
              },
            ],
          })),
        ] satisfies readonly TurnRequest[])
          expect(yield* Effect.flip(model.prepareTurn(request))).toMatchObject({
            kind: 'unsupported',
          });
        expect(fetch).toHaveBeenCalledTimes(3);
      }),
  );

  it.effect(
    'resolves selected subscription request policy before admission and rejects altered bindings',
    () =>
      Effect.gen(function* () {
        const fetch = vi
          .fn<typeof globalThis.fetch>()
          .mockImplementation(async () => response(events([MESSAGE])));
        const configuration = SUBSCRIPTION_CONFIG;
        const authentication = {
          kind: 'codex' as const,
          accessToken: 'selected-token',
          accountId: 'selected-account',
        };
        const model = openaiResponsesModel(configuration, {
          authentication,
          fetch,
        });
        authentication.accessToken = 'later-token';
        authentication.accountId = 'later-account';
        const turn = yield* model.prepareTurn({
          ...REQUEST,
          system: '  selected instructions  ',
        });
        assert(
          turn.protocol === 'openai-responses' && turn.mode === 'foreground',
        );
        expect(turn.system).toBe('selected instructions');
        expect(turn.transport).toEqual({ kind: 'http' });
        expect(turn.controls.maxOutputTokens).toBeNull();
        const result = yield* completedTurn(model.streamTurn(turn));
        const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
        const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
        expect(headers.get('authorization')).toBe('Bearer selected-token');
        expect(headers.get('chatgpt-account-id')).toBe('selected-account');
        expect(headers.get('originator')).toBe('texra');
        expect(headers.get('openai-beta')).toBe('responses=experimental');
        expect(body.instructions).toBe('selected instructions');
        expect(body.reasoning.effort).toBe('medium');
        expect(body.stream).toBe(true);
        expect(body.store).toBe(false);
        expect(body).not.toHaveProperty('background');
        expect(body).not.toHaveProperty('max_output_tokens');
        expect(body).not.toHaveProperty('temperature');
        assert(result.providerResponseId !== null);
        expect(result.continuation).toBeUndefined();
        expect(
          yield* openaiResponsesContinuation(configuration, turn, result),
        ).toBeUndefined();
        expect(
          (yield* model.prepareTurn({ ...REQUEST, system: '  ' })).system,
        ).toBe("Follow the user's instructions.");
        for (const control of [
          { maxOutputTokens: 100 },
          { store: true },
        ] satisfies readonly Partial<TurnRequest>[])
          expect(
            yield* Effect.flip(model.prepareTurn({ ...REQUEST, ...control })),
          ).toMatchObject({ kind: 'unsupported' });
        for (const altered of [
          { ...turn, controls: { ...turn.controls, maxOutputTokens: 100 } },
          { ...turn, controls: { ...turn.controls, store: true } },
          { ...turn, system: '  ' },
          {
            ...turn,
            transport: {
              kind: 'websocket' as const,
              connectionId: '7bdca3ee-ae2a-4551-a7a5-4895b613b40b',
            },
          },
        ])
          expect(
            yield* Effect.flip(completedTurn(model.streamTurn(altered))),
          ).toMatchObject({ kind: 'unsupported' });
        expect(fetch).toHaveBeenCalledTimes(1);
      }),
  );

  it.effect(
    'returns explicit length-limited text without dispatchable unfinished calls',
    () =>
      Effect.gen(function* () {
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
        const result = yield* model.prepareTurn(REQUEST).pipe(
          Effect.flatMap((turn) => {
            assert(turn.mode === 'foreground');
            return completedTurn(model.streamTurn(turn));
          }),
        );
        expect(result).toMatchObject({
          finishReason: 'length',
          usage: null,
          content: [{ kind: 'message', evidence: { status: 'incomplete' } }],
        });
      }),
  );

  it.effect.each([
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
      // Reconciliation compares the provider's exact bytes, so a terminal
      // snapshot that re-spaces the same arguments is a conflict, not a match.
      name: 'respaced local-call arguments',
      final: snapshot([{ ...CALLS[0], arguments: '{ "path" : "a" }' }]),
      output: [CALLS[0]!],
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
    ({ final, output, added, progress }) =>
      Effect.gen(function* () {
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
        const failure = yield* Effect.flip(
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
        );
        expect(failure).toMatchObject({
          kind: 'malformed-output',
          responseId: 'resp_1',
          requestId: 'request_1',
        });
        expect(completed).not.toHaveBeenCalled();
        expect(delta).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledTimes(1);
      }),
  );

  it.effect(
    'preserves a terminal provider failure even when output remains unfinished',
    () =>
      Effect.gen(function* () {
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
        const failure = yield* Effect.flip(
          model.prepareTurn(REQUEST).pipe(
            Effect.flatMap((turn) => {
              assert(turn.mode === 'foreground');
              return completedTurn(model.streamTurn(turn));
            }),
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
      }),
  );

  it.effect(
    'interrupts a pending body read after publishing identity and joins cleanup',
    () =>
      Effect.gen(function* () {
        let signal: AbortSignal | null | undefined;
        const cancel = vi.fn();
        const identified = vi.fn();
        // Completed by the identity event the spy above also records.
        const identifiedSeen = yield* Deferred.make<void>();
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
        const turn = yield* model.prepareTurn(REQUEST);
        assert(turn.mode === 'foreground');
        const fiber = yield* Effect.forkChild(
          Stream.runForEach(model.streamTurn(turn), (event) => {
            if (event.kind === 'identified') {
              identified();
              return Deferred.succeed(identifiedSeen, undefined);
            }
            if (event.kind === 'completed') completed();
            return Effect.void;
          }),
        );
        yield* Deferred.await(identifiedSeen);
        expect(identified).toHaveBeenCalledTimes(1);
        yield* Fiber.interrupt(fiber);
        expect(signal?.aborted).toBe(true);
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(completed).not.toHaveBeenCalled();
      }),
  );
});
