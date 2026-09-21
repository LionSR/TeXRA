// Node imports
import { randomUUID } from 'node:crypto';

// Third-party imports
import { Cause, Clock, Effect, Exit, Stream, type Scope } from 'effect';
import OpenAI from 'openai';
import { WebSocket, createWebSocketStream } from 'ws';
import { z } from 'zod';

// Local imports - canonical model contract
import {
  ModelConfigurationSchema,
  TurnResultSchema,
  type Model,
  type OpenAIResponsesConfiguration,
  type ResolvedTurn,
  completedTurn,
} from './turn.js';
import {
  ModelError,
  authOrRejectionKind,
  enrichModelError,
  parseJsonOrModelError,
} from './errors.js';
import { openaiResponsesContinuation } from './openaiResponsesLower.js';
import { responseEvents, type ResponseOrigin } from './openaiResponsesCodec.js';
import {
  ResponseAuthenticationSchema,
  estimateResponseInput,
  prepareResponsesTurn,
  responseAuthentication,
  responseParameters,
} from './openaiResponsesRequest.js';

const WebSocketEnvelopeSchema = z.object({
  type: z.string(),
  // This acquisition owns the implicit lane, not a multiplexed connection.
  stream_id: z.never().optional(),
});
const WebSocketErrorSchema = z.union([
  z.object({
    type: z.literal('error'),
    status: z.int().optional(),
    error: z.object({
      type: z.string(),
      code: z.string().nullable(),
      message: z.string(),
      param: z.string().nullish(),
    }),
  }),
  z
    .object({
      type: z.literal('error'),
      sequence_number: z.int().nonnegative(),
      code: z.string().nullable(),
      message: z.string(),
      param: z.string().nullable(),
    })
    .transform((error) => ({ error, status: undefined })),
]);

/** Acquires one physical connection; invalidation requires explicit reacquisition. */
export const openaiResponsesWebSocketModel = Effect.fn(
  'llm.responses.webSocketModel',
)(function* (
  configuration: OpenAIResponsesConfiguration,
  authentication: z.infer<typeof ResponseAuthenticationSchema>,
): Effect.fn.Return<Model, ModelError, Scope.Scope> {
  const config = ModelConfigurationSchema.parse(configuration);
  if (config.protocol !== 'openai-responses')
    return yield* new ModelError({
      kind: 'unsupported',
      message: 'This model implements the Responses protocol.',
    });
  const origin = Object.freeze({
    protocol: config.protocol,
    requestedModel: config.requestedModel,
    deployment: config.deployment,
    codecVersion: 1,
  } satisfies ResponseOrigin);
  const selected = yield* Effect.try({
    try: () => responseAuthentication(authentication),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) =>
      cause instanceof ModelError ? Effect.fail(cause) : Effect.die(cause),
    ),
  );
  const countClient = config.supportsInputTokenEstimation
    ? new OpenAI({
        apiKey: selected.token,
        defaultHeaders: selected.headers,
        baseURL: config.deployment.endpoint,
        maxRetries: 0,
        organization: null,
        project: null,
        logLevel: 'off',
      })
    : undefined;
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
  const transport = { kind: 'websocket' as const, connectionId: randomUUID() };
  const openedAt = yield* Clock.currentTimeMillis;
  const closed = new ModelError({
    kind: 'transport',
    message:
      'The Responses connection is no longer usable; reacquire and admit a new turn.',
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
    Effect.tryPromise({ try: () => pending, catch: (cause) => cause }).pipe(
      Effect.catch((cause) => {
        const repeated =
          Exit.isFailure(exit) &&
          exit.cause.reasons.some(
            (reason) =>
              (Cause.isFailReason(reason) &&
                (reason.error === cause ||
                  (reason.error instanceof ModelError &&
                    reason.error.cause === cause))) ||
              (Cause.isDieReason(reason) && reason.defect === cause),
          );
        return cause === closed || repeated ? Effect.void : Effect.die(cause);
      }),
      Effect.asVoid,
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
      return {
        socket,
        reader,
        iterator: reader[Symbol.asyncIterator]() as AsyncIterator<unknown>,
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
  });
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

  const prepareTurn: Model['prepareTurn'] = (request) =>
    prepareResponsesTurn(config, origin, transport, request, null);
  const streamTurn: Model['streamTurn'] = (input) =>
    Stream.suspend(() => {
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
              if (invalid) return Effect.fail(invalid);
              if (phase !== 'idle')
                return Effect.fail(
                  new ModelError({
                    kind: 'unsupported',
                    message:
                      'This Responses connection already has an active turn.',
                  }),
                );
              if (now - openedAt >= 55 * 60_000) {
                invalidate(closed);
                return Effect.fail(closed);
              }
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
              (cause) =>
                resume(cause ? Effect.fail(failure(cause)) : Effect.void),
            );
          });
          const chunks = Stream.fromPull(
            Effect.succeed(
              Effect.gen(function* () {
                pendingRead = iterator.next();
                const next = yield* Effect.tryPromise({
                  try: () => pendingRead!,
                  catch: failure,
                });
                pendingRead = undefined;
                if (next.done) return yield* closed;
                if (typeof next.value !== 'string')
                  return yield* new ModelError({
                    kind: 'malformed-output',
                    message:
                      'The Responses connection returned a binary frame.',
                  });
                const raw = yield* parseJsonOrModelError(
                  next.value as string,
                  (cause) =>
                    new ModelError({
                      kind: 'malformed-output',
                      message:
                        'The Responses connection returned invalid JSON.',
                      cause,
                    }),
                );
                const envelope = WebSocketEnvelopeSchema.safeParse(raw);
                if (!envelope.success)
                  return yield* new ModelError({
                    kind: 'malformed-output',
                    message:
                      'The Responses event does not belong to the implicit lane.',
                    cause: envelope.error,
                  });
                if (envelope.data.type === 'error') {
                  const rejected = WebSocketErrorSchema.safeParse(raw);
                  if (!rejected.success)
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message:
                        'The Responses connection returned a malformed error.',
                      cause: rejected.error,
                    });
                  return yield* new ModelError({
                    kind: authOrRejectionKind(rejected.data.status),
                    message: rejected.data.error.message,
                    status: rejected.data.status,
                    cause: rejected.data.error,
                  });
                }
                return [raw] as const;
              }),
            ),
          );
          return responseEvents(chunks, origin).pipe(
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
                const continuation = yield* openaiResponsesContinuation(
                  config,
                  turn,
                  event.result,
                );
                completed = true;
                return {
                  ...event,
                  result: continuation
                    ? TurnResultSchema.parse({ ...event.result, continuation })
                    : event.result,
                };
              }),
            ),
            Stream.mapError(enrich),
          );
        }).pipe(Effect.mapError(enrich)),
      );
    });
  const generateTurn: Model['generateTurn'] = (turn) =>
    completedTurn(streamTurn(turn));
  return Object.freeze({
    prepareTurn,
    streamTurn,
    generateTurn,
    ...(countClient
      ? {
          estimateInputTokens: Effect.fn(
            'llm.responses.webSocketEstimateInputTokens',
          )(function* (input: Extract<ResolvedTurn, { mode: 'foreground' }>) {
            if (invalid) return yield* invalid;
            if ((yield* Clock.currentTimeMillis) - openedAt >= 55 * 60_000)
              return yield* closed;
            return yield* estimateResponseInput(
              config,
              origin,
              transport,
              countClient,
              input,
            );
          }),
        }
      : {}),
  });
});
