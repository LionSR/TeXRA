// Node imports
import { randomUUID } from 'node:crypto';

// Third-party imports
import {
  Cause,
  Clock,
  Effect,
  Exit,
  Result,
  Schema,
  type Scope,
  ScopedRef,
  Semaphore,
  Stream,
} from 'effect';
import { WebSocket, createWebSocketStream } from 'ws';

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
import { rejoin } from './transport.js';
import {
  ResponseAuthenticationSchema,
  prepareResponsesTurn,
  responseAuthentication,
  responseParameters,
} from './openaiResponsesRequest.js';
import type { ClientRequest, IncomingMessage } from 'node:http';

const decodeFrame = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Unknown),
);
const decodeEnvelope = Schema.decodeUnknownResult(WebSocketEnvelopeSchema);
const decodeRejection = Schema.decodeUnknownResult(WebSocketErrorSchema);

/** A connection older than this is replaced before its next turn. */
const MAX_CONNECTION_AGE_MS = 55 * 60_000;

/**
 * One physical connection, which carries one turn at a time and is unusable
 * once a turn fails, the socket closes, or it ages out.
 */
const connect = Effect.fnUntraced(function* (
  config: OpenAIResponsesConfiguration,
  endpoint: URL,
  selected: ReturnType<typeof responseAuthentication>,
  transport: { readonly kind: 'websocket'; readonly connectionId: string },
) {
  const origin = originOf(config);
  const openedAt = yield* Clock.currentTimeMillis;
  const closed = new ModelError({
    kind: 'transport',
    message: 'The Responses connection closed.',
  });
  let invalid: ModelError | undefined;
  let phase: 'idle' | 'reading' | 'draining' = 'idle';
  let pendingRead: Promise<IteratorResult<unknown>> | undefined;
  let latestResponseId: string | undefined;

  const failure = (cause: unknown) =>
    cause instanceof ModelError
      ? cause
      : new ModelError({
          kind: 'transport',
          message: 'The Responses WebSocket failed.',
          cause,
        });
  const join = (pending: Promise<unknown>, exit: Exit.Exit<unknown, unknown>) =>
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
  const resource = yield* Effect.acquireRelease(
    Effect.sync(() => {
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
        invalid ??= failure(cause);
      });
      socket.once('close', () => {
        invalid ??= closed;
      });
      const iterator: AsyncIterator<unknown> = reader[Symbol.asyncIterator]();
      return {
        socket,
        reader,
        iterator,
      };
    }),
    ({ socket, reader, iterator }, exit) =>
      Effect.gen(function* () {
        invalid ??= closed;
        reader.destroy(closed);
        yield* join(
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
  const { socket, reader, iterator } = resource;
  const invalidate = (error: ModelError) => {
    invalid ??= error;
    reader.destroy(invalid);
  };
  // The sole consumer decodes frames; this synchronous guard only invalidates idle traffic.
  socket.on('message', () => {
    if (phase !== 'reading')
      invalidate(
        new ModelError({
          kind: 'malformed-output',
          message:
            'The Responses connection received data without an active turn.',
        }),
      );
  });
  // Opening runs inside the uninterruptible `ScopedRef` acquisition; the
  // handshake wait stays interruptible.
  yield* Effect.callback<void, ModelError>((resume) => {
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
      resume(Effect.fail(invalid ?? failure(cause)));
    };
    const onUnexpected = (
      request: ClientRequest,
      response: IncomingMessage,
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
      invalid = error;
      response.destroy();
      request.destroy();
      reader.destroy();
      resume(Effect.fail(error));
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('unexpected-response', onUnexpected);
    return Effect.sync(remove);
  }).pipe(Effect.interruptible);
  yield* Effect.gen(function* () {
    while (!invalid) {
      yield* Effect.sleep(30_000);
      if (!invalid)
        yield* Effect.callback<void>((resume) => {
          socket.ping((cause: Error | undefined) => {
            if (cause) invalidate(failure(cause));
            resume(Effect.void);
          });
        });
    }
  }).pipe(Effect.forkScoped);

  /** Send one turn and stream its events; the caller's scope holds the turn. */
  const send = (input: Parameters<Model['streamTurn']>[0]) => {
    let responseId: string | undefined;
    let returnedModel: string | undefined;
    let completed = false;
    const enrich = (error: ModelError) =>
      fillModelError(error, {
        responseId,
        model: returnedModel ?? config.requestedModel,
      });
    return Effect.gen(function* () {
      const { turn, parameters } = yield* responseParameters(
        config,
        origin,
        transport,
        input,
        'foreground',
        null,
      );
      yield* Effect.acquireRelease(
        Effect.suspend(() => {
          if (invalid) return Effect.fail(invalid);
          phase = 'reading';
          return Effect.void;
        }),
        (_, exit) =>
          Effect.gen(function* () {
            if (!completed || Exit.isFailure(exit)) invalidate(closed);
            if (pendingRead) yield* join(pendingRead, exit);
            pendingRead = undefined;
            if (!invalid) phase = 'idle';
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
          (cause) => resume(cause ? Effect.fail(failure(cause)) : Effect.void),
        );
      });
      const chunks = Stream.fromPull(
        Effect.succeed(
          Effect.gen(function* () {
            const read = iterator.next();
            pendingRead = read;
            const next = yield* Effect.tryPromise({
              try: () => read,
              catch: failure,
            });
            pendingRead = undefined;
            if (next.done) return yield* closed;
            if (typeof next.value !== 'string')
              return yield* new ModelError({
                kind: 'malformed-output',
                message: 'The Responses connection returned a binary frame.',
              });
            const raw = yield* decodeFrame(next.value).pipe(
              Effect.mapError(
                (cause) =>
                  new ModelError({
                    kind: 'malformed-output',
                    message: 'The Responses connection returned invalid JSON.',
                    cause,
                  }),
              ),
            );
            const envelope = decodeEnvelope(raw);
            if (!Result.isSuccess(envelope))
              return yield* new ModelError({
                kind: 'malformed-output',
                message:
                  'The Responses event does not belong to the implicit lane.',
                cause: envelope.failure,
              });
            if (envelope.success.type === 'error') {
              const rejected = decodeRejection(raw);
              if (!Result.isSuccess(rejected))
                return yield* new ModelError({
                  kind: 'malformed-output',
                  message:
                    'The Responses connection returned a malformed error.',
                  cause: rejected.failure,
                });
              return yield* new ModelError({
                kind: authOrRejectionKind(rejected.success.status),
                message: rejected.success.error.message,
                status: rejected.success.status,
                cause: rejected.success.error,
              });
            }
            return [raw] as const;
          }),
        ),
      );
      return responseEvents(chunks, origin, (result) =>
        withResponsesContinuation(config, turn, result),
      ).pipe(
        Stream.mapEffect((event) =>
          Effect.gen(function* () {
            if (event.kind === 'identified') {
              if (event.providerResponseId === latestResponseId)
                return yield* new ModelError({
                  kind: 'malformed-output',
                  message:
                    'The Responses connection repeated its preceding response identity.',
                });
              responseId = event.providerResponseId;
              returnedModel = event.returnedModel ?? undefined;
            }
            if (event.kind !== 'completed') return event;
            phase = 'draining';
            if (reader.readableLength > 0)
              return yield* new ModelError({
                kind: 'malformed-output',
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
  authentication: typeof ResponseAuthenticationSchema.Type,
): Effect.fn.Return<Model, ModelError, Scope.Scope> {
  const origin = originOf(config);
  const selected = yield* Effect.try({
    try: () => responseAuthentication(authentication),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) =>
      cause instanceof ModelError ? Effect.fail(cause) : Effect.die(cause),
    ),
  );
  const endpoint = new URL(config.deployment.endpoint);
  if (endpoint.username || endpoint.password)
    return yield* new ModelError({
      kind: 'unsupported',
      message:
        'Responses endpoint credentials cannot override the selected authentication.',
    });
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/responses`;
  if (endpoint.protocol === 'https:') endpoint.protocol = 'wss:';
  else if (endpoint.protocol === 'http:') endpoint.protocol = 'ws:';
  else
    return yield* new ModelError({
      kind: 'unsupported',
      message: 'The Responses endpoint must use HTTP or HTTPS.',
    });
  // A turn prepared on this model streams on whichever connection it holds.
  const transport = { kind: 'websocket' as const, connectionId: randomUUID() };
  const open = connect(config, endpoint, selected, transport);
  const connection = yield* ScopedRef.fromAcquire(open);
  const lane = yield* Semaphore.make(1);

  const prepareTurn: Model['prepareTurn'] = (request) =>
    prepareResponsesTurn(config, origin, transport, request, null, undefined);
  const streamTurn: Model['streamTurn'] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* Semaphore.takeScoped(lane, 1);
        if (!(yield* (yield* ScopedRef.get(connection)).usable))
          yield* ScopedRef.set(connection, open);
        return yield* (yield* ScopedRef.get(connection)).send(input);
      }),
    );
  return Object.freeze({
    prepareTurn,
    streamTurn,
  });
});
