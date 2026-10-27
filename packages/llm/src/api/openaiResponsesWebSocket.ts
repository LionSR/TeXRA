// Node imports
import { randomUUID } from 'node:crypto';

// Third-party imports
import { Cause, Clock, Effect, Exit, type Scope, Stream } from 'effect';
import { WebSocket, createWebSocketStream } from 'ws';

// Local imports - canonical model contract
import {
  decodeModelConfiguration,
  type Model,
  type OpenAIResponsesConfiguration,
  type ResolvedTurn,
  type TurnEvent,
} from '../turn.js';
import {
  ModelError,
  authOrRejectionKind,
  enrichModelError,
} from '../errors.js';
import { withResponsesContinuation } from './openaiResponsesLower.js';
import { responseEvents } from './openaiResponsesCodec.js';
import { socketFrameEvent } from './openaiResponsesWire.js';
import { originOf } from '../protocol.js';
import { rejoin } from './transport.js';
import {
  ResponseAuthenticationSchema,
  prepareResponsesTurn,
  responseAuthentication,
  responseParameters,
  type ResponsesBinding,
} from './openaiResponsesRequest.js';
import type { Duplex } from 'node:stream';

/** One acquired socket, the binding its turns run on, and what they share. */
interface Connection {
  readonly config: OpenAIResponsesConfiguration;
  readonly origin: ResponsesBinding['origin'];
  readonly transport: {
    readonly kind: 'websocket';
    readonly connectionId: string;
  };
  readonly openedAt: number;
  /** What a closed connection reports; cleanup recognizes it by identity. */
  readonly closed: ModelError;
  readonly socket: WebSocket;
  readonly reader: Duplex;
  readonly iterator: AsyncIterator<unknown>;
  /** The first failure that made the connection unusable. */
  invalid: ModelError | undefined;
  /** Whether a turn reads its response, or drains after its terminal event. */
  phase: 'idle' | 'reading' | 'draining';
  /** The frame read a turn waits on, which its cleanup rejoins. */
  pendingRead: Promise<IteratorResult<unknown>> | undefined;
  /** The last completed response, which the next turn must not repeat. */
  latestResponseId: string | undefined;
}

const socketFailure = (cause: unknown): ModelError =>
  cause instanceof ModelError
    ? cause
    : new ModelError({
        kind: 'transport',
        message: 'The Responses WebSocket failed.',
        cause,
      });

/**
 * Waits out `pending` at cleanup, dropping only a rejection that repeats the
 * closed connection's error or a failure `exit` already carries.
 */
const join = (
  closed: ModelError,
  pending: Promise<unknown>,
  exit: Exit.Exit<unknown, unknown>,
) =>
  rejoin(
    pending,
    exit,
    (cause) =>
      cause === closed ||
      (Exit.isFailure(exit) &&
        exit.cause.reasons.some((reason) =>
          Cause.isFailReason(reason)
            ? reason.error === cause
            : Cause.isDieReason(reason) && reason.defect === cause,
        )),
  );

/** Marks the connection unusable with its first failure and stops its reader. */
function invalidate(connection: Connection, error: ModelError): void {
  connection.invalid ??= error;
  connection.reader.destroy(connection.invalid);
}

/** The deployment's `/responses` endpoint as a socket URL. */
function socketEndpoint(deployment: string): Effect.Effect<URL, ModelError> {
  const endpoint = new URL(deployment);
  if (endpoint.username || endpoint.password)
    return Effect.fail(
      new ModelError({
        kind: 'unsupported',
        message:
          'Responses endpoint credentials cannot override the selected authentication.',
      }),
    );
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/responses`;
  if (endpoint.protocol === 'https:') endpoint.protocol = 'wss:';
  else if (endpoint.protocol === 'http:') endpoint.protocol = 'ws:';
  else
    return Effect.fail(
      new ModelError({
        kind: 'unsupported',
        message: 'The Responses endpoint must use HTTP or HTTPS.',
      }),
    );
  return Effect.succeed(endpoint);
}

/** Waits for the socket to open; a failed or rejected handshake fails it. */
const handshake = (connection: Connection) =>
  Effect.callback<void, ModelError>((resume) => {
    const { socket, reader } = connection;
    const remove = () => {
      socket.off('open', onOpen);
      socket.off('error', onError);
      socket.off('unexpected-response', onUnexpected);
    };
    const onOpen = () => {
      remove();
      resume(Effect.void);
    };
    const onError = (cause: Error) => {
      remove();
      resume(Effect.fail(connection.invalid ?? socketFailure(cause)));
    };
    const onUnexpected = (
      request: import('node:http').ClientRequest,
      response: import('node:http').IncomingMessage,
    ) => {
      const status = response.statusCode;
      const error = new ModelError({
        kind: authOrRejectionKind(status),
        message: `The Responses WebSocket handshake was rejected${status === undefined ? '' : ` (${status})`}.`,
        status,
        requestId:
          typeof response.headers['x-request-id'] === 'string'
            ? response.headers['x-request-id']
            : undefined,
      });
      remove();
      connection.invalid = error;
      response.destroy();
      request.destroy();
      reader.destroy();
      resume(Effect.fail(error));
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('unexpected-response', onUnexpected);
    return Effect.sync(remove);
  });

/** Pings the open socket every 30 seconds until it is invalid. */
const keepAlive = (connection: Connection) =>
  Effect.gen(function* () {
    while (!connection.invalid) {
      yield* Effect.sleep(30_000);
      if (!connection.invalid)
        yield* Effect.callback<void>((resume) => {
          connection.socket.ping((cause: Error | undefined) => {
            if (cause) invalidate(connection, socketFailure(cause));
            resume(Effect.void);
          });
        });
    }
  });

/** One turn over the connection, which it holds until the turn settles. */
const streamSocketTurn = (
  connection: Connection,
  input: Extract<ResolvedTurn, { mode: 'foreground' }>,
): Stream.Stream<TurnEvent, ModelError> =>
  Stream.suspend(() => {
    const { config, origin, transport, socket, reader, closed } = connection;
    let responseId: string | undefined;
    let returnedModel: string | undefined;
    let completed = false;
    const enrich = (error: ModelError) =>
      enrichModelError(error, {
        responseId: error.responseId ?? responseId,
        model: error.model ?? returnedModel ?? config.requestedModel,
      });
    return Stream.unwrap(
      Effect.gen(function* () {
        const { turn, parameters } = yield* responseParameters(
          config,
          origin,
          transport,
          input,
          'foreground',
          null,
        );
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.acquireRelease(
          Effect.suspend(() => {
            if (connection.invalid) return Effect.fail(connection.invalid);
            if (connection.phase !== 'idle')
              return Effect.fail(
                new ModelError({
                  kind: 'unsupported',
                  message:
                    'This Responses connection already has an active turn.',
                }),
              );
            if (now - connection.openedAt >= 55 * 60_000) {
              invalidate(connection, closed);
              return Effect.fail(closed);
            }
            connection.phase = 'reading';
            return Effect.void;
          }),
          (_, exit) =>
            Effect.gen(function* () {
              if (!completed || Exit.isFailure(exit))
                invalidate(connection, closed);
              if (connection.pendingRead)
                yield* join(closed, connection.pendingRead, exit);
              connection.pendingRead = undefined;
              if (!connection.invalid) connection.phase = 'idle';
            }),
        );
        yield* Effect.callback<void, ModelError>((resume) => {
          socket.send(
            JSON.stringify({
              type: 'response.create',
              ...parameters,
              ...(config.webSocketStreamParameter === 'required'
                ? { stream: true }
                : {}),
            }),
            (cause) =>
              resume(cause ? Effect.fail(socketFailure(cause)) : Effect.void),
          );
        });
        const chunks = Stream.fromPull(
          Effect.succeed(
            Effect.gen(function* () {
              const read = connection.iterator.next();
              connection.pendingRead = read;
              const next = yield* Effect.tryPromise({
                try: () => read,
                catch: socketFailure,
              });
              connection.pendingRead = undefined;
              if (next.done) return yield* closed;
              return [yield* socketFrameEvent(next.value)] as const;
            }),
          ),
        );
        return responseEvents(chunks, origin, (result) =>
          withResponsesContinuation(config, turn, result),
        ).pipe(
          Stream.mapEffect((event) =>
            Effect.gen(function* () {
              if (event.kind === 'identified') {
                if (event.providerResponseId === connection.latestResponseId)
                  return yield* new ModelError({
                    kind: 'malformed-output',
                    message:
                      'The Responses connection repeated its preceding response identity.',
                  });
                responseId = event.providerResponseId;
                returnedModel = event.returnedModel ?? undefined;
              }
              if (event.kind !== 'completed') return event;
              connection.phase = 'draining';
              if (reader.readableLength > 0)
                return yield* new ModelError({
                  kind: 'malformed-output',
                  message:
                    'The Responses connection buffered data beyond its terminal event.',
                });
              connection.latestResponseId =
                event.result.providerResponseId ?? undefined;
              completed = true;
              return event;
            }),
          ),
          Stream.mapError(enrich),
        );
      }).pipe(Effect.mapError(enrich)),
    );
  });

/** Acquires one physical connection; invalidation requires explicit reacquisition. */
export const openaiResponsesWebSocketModel = Effect.fn(
  'llm.responses.webSocketModel',
)(function* (
  configuration: OpenAIResponsesConfiguration,
  authentication: typeof ResponseAuthenticationSchema.Type,
): Effect.fn.Return<Model, ModelError, Scope.Scope> {
  const config = decodeModelConfiguration(configuration);
  if (config.protocol !== 'openai-responses')
    return yield* new ModelError({
      kind: 'unsupported',
      message: 'This model implements the Responses protocol.',
    });
  const origin = originOf(config);
  const selected = yield* Effect.try({
    try: () => responseAuthentication(authentication),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) =>
      cause instanceof ModelError ? Effect.fail(cause) : Effect.die(cause),
    ),
  );
  const endpoint = yield* socketEndpoint(config.deployment.endpoint);
  const transport = { kind: 'websocket' as const, connectionId: randomUUID() };
  const openedAt = yield* Clock.currentTimeMillis;
  const closed = new ModelError({
    kind: 'transport',
    message:
      'The Responses connection is no longer usable; reacquire and admit a new turn.',
  });
  const connection = yield* Effect.acquireRelease(
    Effect.sync((): Connection => {
      const socket = new WebSocket(endpoint, {
        headers: {
          Authorization: `Bearer ${selected.token}`,
          ...selected.headers,
        },
        followRedirects: false,
      });
      const reader = createWebSocketStream(socket, {
        readableObjectMode: true,
      });
      // This listener records failures while idle as well as during a pending read.
      reader.on('error', (cause) => {
        opened.invalid ??= socketFailure(cause);
      });
      socket.once('close', () => {
        opened.invalid ??= closed;
      });
      const opened: Connection = {
        config,
        origin,
        transport,
        openedAt,
        closed,
        socket,
        reader,
        iterator: reader[Symbol.asyncIterator](),
        invalid: undefined,
        phase: 'idle',
        pendingRead: undefined,
        latestResponseId: undefined,
      };
      return opened;
    }),
    (connection, exit) =>
      Effect.gen(function* () {
        const { socket, reader, iterator } = connection;
        connection.invalid ??= closed;
        reader.destroy(closed);
        yield* join(
          closed,
          iterator.return ? iterator.return() : Promise.resolve(),
          exit,
        ).pipe(
          Effect.ensuring(
            Effect.callback<void>((resume) => {
              if (socket.readyState === WebSocket.CLOSED) resume(Effect.void);
              else socket.once('close', () => resume(Effect.void));
            }),
          ),
        );
      }),
  );
  // The sole consumer decodes frames; this synchronous guard only invalidates idle traffic.
  connection.socket.on('message', () => {
    if (connection.phase !== 'reading')
      invalidate(
        connection,
        new ModelError({
          kind: 'malformed-output',
          message:
            'The Responses connection received data without an active turn.',
        }),
      );
  });
  yield* handshake(connection);
  yield* keepAlive(connection).pipe(Effect.forkScoped);

  const prepareTurn: Model['prepareTurn'] = (request) =>
    prepareResponsesTurn(config, origin, transport, request, null);
  const streamTurn: Model['streamTurn'] = (input) =>
    streamSocketTurn(connection, input);
  return Object.freeze({ prepareTurn, streamTurn });
});
