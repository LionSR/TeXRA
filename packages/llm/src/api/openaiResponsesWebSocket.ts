// Third-party imports
import {
  Clock,
  Duration,
  Effect,
  Exit,
  Fiber,
  Schema,
  type Scope,
  ScopedRef,
  Semaphore,
  Stream,
} from 'effect';
import { Socket } from 'effect/socket';
import { WebSocket } from 'ws';

// Local imports - canonical model contract
import { type Model, type OpenAIResponsesConfiguration } from '../turn.js';
import { ModelError, authOrRejectionKind, fillModelError } from '../errors.js';
import { withResponsesContinuation } from './openaiResponsesLower.js';
import { responseEvents } from './openaiResponsesCodec.js';
import {
  WebSocketEnvelopeSchema,
  WebSocketErrorSchema,
} from './openaiResponsesWire.js';
import { originOf } from '../protocol.js';
import {
  decodeWireOrFail,
  refuseAmbientHeaders,
  wireFail,
} from './transport.js';
import {
  authorized,
  bearerHeaders,
  prepareResponsesTurn,
  responseParameters,
} from './openaiResponsesRequest.js';
import type { SessionToken } from '../node.js';

const JsonFrameSchema = Schema.fromJsonString(Schema.Unknown);

/** A connection older than this is replaced before its next turn. */
const MAX_CONNECTION_AGE_MS = 55 * 60_000;

const closed = (cause?: unknown) =>
  new ModelError({
    kind: 'transport',
    message: 'The Responses connection closed.',
    cause,
  });

const transportFailure = (cause: unknown) =>
  new ModelError({
    kind: 'transport',
    message: 'The Responses WebSocket failed.',
    cause,
  });

const socketFailure = (error: Socket.SocketError) =>
  error.reason._tag === 'SocketCloseError'
    ? closed(error)
    : transportFailure(error);

/**
 * One physical connection, which carries one turn at a time and is unusable
 * once a turn fails, the socket closes, data arrives with no turn reading, or
 * it ages out.
 */
const connect = Effect.fnUntraced(function* (
  config: OpenAIResponsesConfiguration,
  endpoint: URL,
  token: string,
) {
  const origin = originOf(config);
  const openedAt = yield* Clock.currentTimeMillis;
  const scope = yield* Effect.scope;
  let invalid: ModelError | undefined;
  let rejected: ModelError | undefined;
  let reading = false;
  let latestResponseId: string | undefined;

  const ws = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const socket = new WebSocket(endpoint, {
        headers: bearerHeaders(token),
        followRedirects: false,
      });
      // A refused handshake's status says whether the token is handed back;
      // the socket's own open error carries only a message.
      socket.once('unexpected-response', (_request, response) => {
        const status = response.statusCode;
        rejected = new ModelError({
          kind: authOrRejectionKind(status),
          message: `The Responses WebSocket handshake was rejected${status === undefined ? '' : ` (${status})`}.`,
          status,
          requestId:
            typeof response.headers['x-request-id'] === 'string'
              ? response.headers['x-request-id']
              : undefined,
        });
        response.destroy();
        socket.terminate();
      });
      return socket;
    }),
    (socket) =>
      Effect.callback<void>((resume) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resume(Effect.void);
          return;
        }
        socket.once('close', () => resume(Effect.void));
        socket.terminate();
      }),
  );
  const invalidate = (error: ModelError) => {
    invalid ??= error;
    ws.terminate();
  };
  const socket = yield* Socket.fromWebSocket(Effect.succeed(ws), {
    openTimeout: Duration.infinity,
  });
  // Opening runs inside the uninterruptible `ScopedRef` acquisition; the
  // handshake wait stays interruptible.
  const { pull } = yield* socket.reader.pipe(
    Effect.mapError((error) => rejected ?? socketFailure(error)),
    Effect.interruptible,
  );
  const { write } = yield* socket.writer;

  // Between turns one read waits on the socket. A frame or a close it gets
  // before a turn claims it makes the connection unusable; a turn that
  // claims it takes its result as the turn's first frames. The read starts
  // at once, so a frame already buffered when a turn ends is seen then and
  // not taken by the next turn.
  const watch = Effect.gen(function* () {
    const fiber = yield* Effect.forkIn(pull, scope, {
      startImmediately: true,
    });
    fiber.addObserver((exit) => {
      if (reading) return;
      invalidate(
        Exit.isSuccess(exit)
          ? new ModelError({
              kind: 'provider-rejection',
              message:
                'The Responses connection received data without an active turn.',
            })
          : closed(exit.cause),
      );
    });
    return fiber;
  });
  let waiting = yield* watch;

  const ping = Effect.callback<void>((resume) => {
    ws.ping((cause: Error | undefined) => {
      if (cause) invalidate(transportFailure(cause));
      resume(Effect.void);
    });
  });
  yield* Effect.suspend(() => (invalid ? Effect.void : ping)).pipe(
    Effect.delay('30 seconds'),
    Effect.repeat({ while: () => !invalid }),
    Effect.forkScoped,
  );

  /** Send one turn and stream its events; the caller's scope holds the turn. */
  const send = (input: Parameters<Model['streamTurn']>[0]) => {
    let responseId: string | undefined;
    let returnedModel: string | undefined;
    let completed = false;
    // The frames a read returned that the turn has not decoded yet.
    const frames: Array<Uint8Array | string> = [];
    let claimed: typeof waiting | undefined;
    const enrich = (error: ModelError) =>
      fillModelError(error, {
        responseId,
        model: returnedModel ?? config.requestedModel,
      });
    return Effect.gen(function* () {
      const { turn, parameters } = yield* responseParameters(
        config,
        origin,
        input,
        'foreground',
        null,
      );
      yield* Effect.acquireRelease(
        Effect.suspend(() => {
          if (invalid) return Effect.fail(invalid);
          reading = true;
          claimed = waiting;
          return Effect.void;
        }),
        Effect.fnUntraced(function* (_, exit) {
          if (!completed || Exit.isFailure(exit)) return invalidate(closed());
          reading = false;
          waiting = yield* watch;
        }),
      );
      yield* write(
        JSON.stringify({
          type: 'response.create',
          ...parameters,
        }),
      ).pipe(Effect.mapError(socketFailure));
      const chunks = Stream.fromPull(
        Effect.succeed(
          Effect.gen(function* () {
            if (frames.length === 0) {
              const read = claimed === undefined ? pull : Fiber.join(claimed);
              claimed = undefined;
              frames.push(...(yield* Effect.mapError(read, socketFailure)));
            }
            const frame = frames.shift();
            if (typeof frame !== 'string')
              return yield* wireFail(
                'The Responses connection returned a binary frame.',
              );
            const raw = yield* decodeWireOrFail(
              JsonFrameSchema,
              'The Responses connection returned invalid JSON.',
              frame,
            );
            const envelope = yield* decodeWireOrFail(
              WebSocketEnvelopeSchema,
              'The Responses event does not belong to the implicit lane.',
              raw,
            );
            if (envelope.type === 'error') {
              const rejected = yield* decodeWireOrFail(
                WebSocketErrorSchema,
                'The Responses connection returned a malformed error.',
                raw,
              );
              return yield* new ModelError({
                kind: authOrRejectionKind(rejected.status),
                message: rejected.error.message,
                status: rejected.status,
                cause: rejected.error,
              });
            }
            return [raw] as const;
          }),
        ),
      );
      return responseEvents(chunks, origin, (result) =>
        withResponsesContinuation(turn, result),
      ).pipe(
        Stream.mapEffect(
          Effect.fnUntraced(function* (event) {
            if (event.kind === 'identified') {
              if (event.providerResponseId === latestResponseId)
                return yield* new ModelError({
                  kind: 'provider-rejection',
                  message:
                    'The Responses connection repeated its preceding response identity.',
                });
              responseId = event.providerResponseId;
              returnedModel = event.returnedModel ?? undefined;
            }
            if (event.kind !== 'completed') return event;
            if (frames.length > 0)
              return yield* new ModelError({
                kind: 'provider-rejection',
                message:
                  'The Responses connection buffered data beyond its terminal event.',
              });
            latestResponseId = event.result.providerResponseId ?? undefined;
            completed = true;
            return event;
          }),
        ),
        Stream.mapError(enrich),
      );
    }).pipe(Effect.mapError(enrich));
  };

  return {
    usable: Effect.map(
      Clock.currentTimeMillis,
      (now) => invalid === undefined && now - openedAt < MAX_CONNECTION_AGE_MS,
    ),
    send,
    /** The token the connection opened with. */
    token,
  };
});

/**
 * A Responses model over WebSocket. Its turns take the connection one after
 * another, and a turn that finds it unusable opens the next one first, so a
 * failed turn or a dropped socket never reaches the caller's next turn.
 */
export const openaiResponsesWebSocketModel = Effect.fn(
  'llm.responses.webSocketModel',
)(function* (
  config: OpenAIResponsesConfiguration,
  bearer: string | SessionToken,
): Effect.fn.Return<Model, ModelError, Scope.Scope> {
  const origin = originOf(config);
  yield* refuseAmbientHeaders(
    'OPENAI_CUSTOM_HEADERS',
    'Ambient OpenAI headers cannot override the selected deployment.',
  );
  const endpoint = new URL(config.deployment.endpoint);
  if (endpoint.username || endpoint.password)
    return yield* new ModelError({
      kind: 'invalid-request',
      message:
        'Responses endpoint credentials cannot override the selected authentication.',
    });
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/responses`;
  if (endpoint.protocol === 'https:') endpoint.protocol = 'wss:';
  else if (endpoint.protocol === 'http:') endpoint.protocol = 'ws:';
  else
    return yield* new ModelError({
      kind: 'invalid-request',
      message: 'The Responses endpoint must use HTTP or HTTPS.',
    });
  // Each connection opens on the token current then; one the handshake
  // rejects is handed back and the next tried once.
  const open = authorized(bearer, (token) => connect(config, endpoint, token));
  const connection = yield* ScopedRef.fromAcquire(open);
  const lane = yield* Semaphore.make(1);

  const prepareTurn: Model['prepareTurn'] = (request) =>
    prepareResponsesTurn(config, origin, request, null, undefined);
  const streamTurn: Model['streamTurn'] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* Semaphore.takeScoped(lane, 1);
        if (!(yield* (yield* ScopedRef.get(connection)).usable))
          yield* ScopedRef.set(connection, open);
        const current = yield* ScopedRef.get(connection);
        const turn = yield* current.send(input);
        if (typeof bearer === 'string') return turn;
        // A session token the provider rejects on an open connection, before
        // the turn streamed anything, is handed back once and the turn sent
        // again on a new connection; the rejected request was not billed.
        let streamed = false;
        return turn.pipe(
          Stream.tap(() =>
            Effect.sync(() => {
              streamed = true;
            }),
          ),
          Stream.catchIf(
            (error) => !streamed && error.kind === 'authentication',
            () =>
              Stream.unwrap(
                Effect.gen(function* () {
                  yield* bearer.rejected(current.token);
                  yield* ScopedRef.set(connection, open);
                  return yield* (yield* ScopedRef.get(connection)).send(input);
                }),
              ),
          ),
        );
      }),
    );
  return Object.freeze({
    prepareTurn,
    streamTurn,
  });
});
