// Node imports
import { Buffer } from 'node:buffer';

// Third-party imports
import { Cause, Clock, Effect, Exit, Stream, type Scope } from 'effect';
import OpenAI from 'openai';
import { z } from 'zod';

// Local imports - canonical model contract
import {
  BackgroundSubmissionSchema,
  CancellationEvidenceSchema,
  completedTurn,
  FILE_UPLOAD_LIFETIME_SECONDS,
  ModelConfigurationSchema,
  ObservationPolicySchema,
  type BackgroundEvent,
  type BackgroundSubmission,
  type Model,
  type OpenAIResponsesConfiguration,
  type ResolvedTurn,
  type TurnEvent,
} from '../turn.js';
import {
  ModelError,
  RemoteOperationSchema,
  boundOperation,
  cancellationStatus,
  enrichModelError,
  fillModelError,
  type RemoteOperation,
} from '../errors.js';
import { originOf, sameModelOrigin } from '../protocol.js';
import { ownedAbortSafeRequest } from './transport.js';
import { filesApiUploads } from './uploadCache.js';
import { openaiFailure } from './openaiError.js';
import { admittedFingerprint, canChain } from './prefixFingerprint.js';
import {
  RESPONSES_PREFIX_DOMAIN,
  withResponsesContinuation,
} from './openaiResponsesLower.js';
import {
  ResponseEventSchema,
  ResponseSchema,
  responseEvents,
  responsesWire,
  sdkEvents,
  terminalParts,
} from './openaiResponsesCodec.js';
import { assembleTurn, turnAssembly } from './assembleTurn.js';
import {
  ResponseAuthenticationSchema,
  openaiAbortMatch,
  openaiClient,
  prepareResponsesTurn,
  responseAuthentication,
  responseParameters,
} from './openaiResponsesRequest.js';

/**
 * What a Files API upload must return before its id is cached. The SDK's
 * type is not a check on the JSON, so a missing or empty id, or an expiry
 * that is not whole non-negative Unix seconds (absent means the file does
 * not expire), is a malformed response: the upload counts as failed and the
 * bytes are sent.
 */
const UploadedFileSchema = z
  .object({
    id: z.string().min(1),
    expires_at: z.int().nonnegative().nullish(),
  })
  .transform((file) => ({
    fileId: file.id,
    expiresAtMs: file.expires_at == null ? null : file.expires_at * 1000,
  }));

/** Direct Responses operations, with no application model adapter. */
export function openaiResponsesModel(
  configuration: OpenAIResponsesConfiguration,
  transport: {
    readonly authentication: z.infer<typeof ResponseAuthenticationSchema>;
    readonly fetch?: typeof fetch;
  },
): Model {
  const config = ModelConfigurationSchema.parse(configuration);
  if (config.protocol !== 'openai-responses') {
    throw new ModelError({
      kind: 'unsupported',
      message: 'This model implements the Responses protocol.',
    });
  }
  const origin = originOf(config);
  const authentication = responseAuthentication(transport.authentication);
  const client = openaiClient(
    config.deployment.endpoint,
    authentication,
    transport.fetch,
  );
  // Uploads need a files endpoint and a stable account: an API-key binding.
  // A subscription token rotates and its backend serves no files endpoint.
  const uploads =
    transport.authentication.kind === 'api-key'
      ? filesApiUploads({
          providerName: 'OpenAI',
          model: origin.requestedModel,
          failure: (cause) =>
            enrichModelError(openaiFailure(cause), {
              model: origin.requestedModel,
            }),
          parseUploaded: (raw) => UploadedFileSchema.safeParse(raw),
          create: async (upload, signal) =>
            client.files.create(
              {
                file: await OpenAI.toFile(
                  Buffer.from(upload.base64, 'base64'),
                  upload.filename,
                  { type: upload.mimeType },
                ),
                purpose: 'user_data',
                expires_after: {
                  anchor: 'created_at',
                  seconds: FILE_UPLOAD_LIFETIME_SECONDS,
                },
              },
              { signal },
            ),
          remove: (fileId, signal) => client.files.delete(fileId, { signal }),
        })
      : null;
  const prepareTurn: Model['prepareTurn'] = (request) =>
    prepareResponsesTurn(config, origin, { kind: 'http' }, request, uploads);

  const createResponse = Effect.fn('llm.responses.create')(function* (
    input: ResolvedTurn,
    mode: 'foreground' | 'background',
  ) {
    const { turn, parameters } = yield* responseParameters(
      config,
      origin,
      { kind: 'http' },
      input,
      mode,
      uploads,
    );
    const signal = yield* Effect.abortSignal;
    const opened = yield* Effect.tryPromise({
      try: () =>
        client.responses
          .create(
            {
              ...parameters,
              stream: true,
              ...(mode === 'background' ? { background: true } : {}),
            },
            { signal },
          )
          .withResponse(),
      catch: openaiFailure,
    });
    return { turn, opened };
  });

  const streamTurn: Model['streamTurn'] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const { turn, opened } = yield* createResponse(input, 'foreground');
        const requestId = opened.request_id ?? undefined;
        const enrich = (error: ModelError) =>
          fillModelError(error, { requestId });
        const chunks = yield* sdkEvents(opened.data, enrich);
        return responseEvents(chunks, origin, (result) =>
          withResponsesContinuation(config, turn, result),
        ).pipe(Stream.mapError(enrich));
      }).pipe(
        Effect.mapError((error) =>
          fillModelError(error, { model: config.requestedModel }),
        ),
      ),
    );

  const submit: NonNullable<Model['background']>['submit'] = Effect.fn(
    'llm.responses.submit',
  )(function* (input) {
    let operation: RemoteOperation | undefined;
    let returnedModel: string | undefined;
    let requestId: string | undefined;
    const enrich = (error: ModelError) =>
      fillModelError(error, {
        operation,
        responseId: operation?.providerResponseId,
        requestId,
        model: returnedModel ?? config.requestedModel,
      });
    return yield* Effect.scoped(
      Effect.gen(function* (): Effect.fn.Return<
        BackgroundSubmission,
        ModelError,
        Scope.Scope
      > {
        const { turn, opened } = yield* createResponse(input, 'background');
        requestId = opened.request_id ?? undefined;
        const source = opened.data;
        const iterator = yield* Effect.acquireRelease(
          Effect.sync(() => source[Symbol.asyncIterator]()),
          (iterator, exit) =>
            Effect.gen(function* () {
              const close = iterator.return
                ? Effect.tryPromise({
                    try: () => iterator.return!(),
                    catch: (cause) =>
                      enrich(
                        new ModelError({
                          kind: 'transport',
                          message: 'Background submission cleanup failed.',
                          cause,
                        }),
                      ),
                  })
                : Effect.void;
              if (Exit.isSuccess(exit)) {
                // After the single read, no next() is pending. Let the SDK join
                // its body cancellation before aborting the detached request.
                yield* close.pipe(
                  Effect.orDie,
                  Effect.ensuring(Effect.sync(() => source.controller.abort())),
                );
              } else {
                source.controller.abort();
                yield* close.pipe(Effect.orDie);
              }
            }),
        );
        const first = yield* Effect.tryPromise({
          try: () => iterator.next(),
          catch: (cause) =>
            cause instanceof SyntaxError
              ? new ModelError({
                  kind: 'malformed-output',
                  message: 'The model returned malformed stream data.',
                  cause,
                })
              : openaiFailure(cause),
        });
        if (first.done)
          return yield* new ModelError({
            kind: 'malformed-output',
            message: 'Background submission ended without acceptance evidence.',
          });
        const parsed = ResponseEventSchema.safeParse(first.value);
        if (!parsed.success)
          return yield* new ModelError({
            kind: 'malformed-output',
            message: 'Background acceptance is malformed.',
            cause: parsed.error,
          });
        const { response, type, sequence_number } = parsed.data;
        returnedModel = response.model;
        operation = RemoteOperationSchema.parse({
          origin,
          providerResponseId: response.id,
          afterSequence: sequence_number,
          admittedFingerprint: admittedFingerprint(
            RESPONSES_PREFIX_DOMAIN,
            turn,
          ),
          store: turn.controls.store,
        });
        if (
          (type === 'response.completed' && response.status === 'completed') ||
          (type === 'response.incomplete' && response.status === 'incomplete')
        ) {
          const result = yield* completedTurn(
            assembleTurn(Stream.make(yield* terminalParts(response, type)), {
              origin,
              provider: 'The model',
              finalize: (completed) =>
                withResponsesContinuation(config, turn, completed),
            }),
          );
          return BackgroundSubmissionSchema.parse({
            kind: 'completed',
            result,
          });
        }
        if (
          ![
            'response.created',
            'response.queued',
            'response.in_progress',
          ].includes(type) ||
          !['queued', 'in_progress'].includes(response.status)
        ) {
          return yield* new ModelError({
            kind:
              response.status === 'failed'
                ? 'provider-rejection'
                : 'malformed-output',
            message:
              response.error?.message ??
              'The provider did not acknowledge background work.',
            cause: response.error,
          });
        }
        return BackgroundSubmissionSchema.parse({
          kind: 'accepted',
          operation,
          returnedModel,
        });
      }).pipe(Effect.mapError(enrich)),
    );
  });

  const observe: NonNullable<Model['background']>['observe'] = (
    turn,
    input,
    policy,
  ) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const operation = yield* boundOperation(input, origin);
        if (
          turn.protocol !== 'openai-responses' ||
          turn.mode !== 'background' ||
          !sameModelOrigin(turn, operation.origin)
        )
          return yield* new ModelError({
            kind: 'unsupported',
            message: 'The admitted turn belongs to another model binding.',
          });
        const chains = yield* canChain(
          RESPONSES_PREFIX_DOMAIN,
          turn,
          operation,
        );
        const parsedPolicy = ObservationPolicySchema.safeParse(policy);
        if (!parsedPolicy.success)
          return yield* new ModelError({
            kind: 'invalid-request',
            message: 'The observation deadline is invalid.',
            cause: parsedPolicy.error,
          });
        const remaining =
          parsedPolicy.data.deadlineAtMs - (yield* Clock.currentTimeMillis);
        const deadline = new ModelError({
          kind: 'observation-deadline',
          message: 'The original observation deadline has expired.',
          operation,
          responseId: operation.providerResponseId,
        });
        if (remaining <= 0) return yield* deadline;
        let returnedModel: string | undefined;
        let requestId: string | undefined;
        const enrich = (error: ModelError) =>
          fillModelError(error, {
            operation,
            responseId: operation.providerResponseId,
            requestId,
            model: returnedModel ?? config.requestedModel,
          });
        return Stream.unwrap(
          Effect.gen(function* () {
            const signal = yield* Effect.abortSignal;
            const opened = yield* Effect.tryPromise({
              try: () =>
                client.responses
                  .retrieve(
                    operation.providerResponseId,
                    {
                      stream: true,
                      ...(operation.afterSequence !== null
                        ? { starting_after: operation.afterSequence }
                        : {}),
                      include: ['reasoning.encrypted_content'],
                    },
                    { signal },
                  )
                  .withResponse(),
              catch: openaiFailure,
            }).pipe(
              Effect.timeoutOrElse({
                duration: remaining,
                orElse: () => Effect.fail(enrich(deadline)),
              }),
            );
            requestId = opened.request_id ?? undefined;
            const events = yield* sdkEvents(opened.data, enrich);
            const readTimeRemaining = Math.max(
              0,
              parsedPolicy.data.deadlineAtMs - (yield* Clock.currentTimeMillis),
            );
            // The observation may join mid-item: what it missed, the
            // terminal snapshot supplies.
            const assembly = turnAssembly({
              origin,
              provider: 'The model',
              responseId: operation.providerResponseId,
              partial: true,
            });
            let sequence = operation.afterSequence ?? -1;
            const sequenced = (event: TurnEvent): BackgroundEvent[] => {
              if (event.kind === 'delta')
                return [{ ...event, afterSequence: sequence }];
              if (event.kind !== 'identified') return [];
              returnedModel = event.returnedModel ?? undefined;
              return [
                {
                  ...event,
                  requestedOrigin: origin,
                  afterSequence: sequence,
                },
              ];
            };
            const progress = events.pipe(
              Stream.mapEffect(responsesWire(sequence)),
              Stream.takeUntil((event) => event.terminal),
              Stream.mapEffect((event) =>
                Effect.gen(function* () {
                  sequence = event.sequence;
                  const turnEvents = yield* Effect.forEach(
                    event.parts,
                    assembly.step,
                  );
                  // The terminal cursor is delivered only with its result below.
                  if (event.terminal) return [];
                  const observed = turnEvents.flat().flatMap(sequenced);
                  return observed.length > 0
                    ? observed
                    : [{ kind: 'cursor' as const, afterSequence: sequence }];
                }),
              ),
              Stream.flattenIterable,
            );
            const completion = Effect.gen(function* (): Effect.fn.Return<
              BackgroundEvent,
              ModelError
            > {
              const result = yield* assembly.complete;
              // The same anchor the foreground completion builds: an
              // observed turn chains on `previous_response_id` too.
              return {
                kind: 'completed',
                afterSequence: sequence,
                result: chains
                  ? yield* withResponsesContinuation(config, turn, result)
                  : result,
              };
            });
            return Stream.concat(progress, Stream.fromEffect(completion)).pipe(
              Stream.mapError((error) => enrich(assembly.enrich(error))),
              Stream.interruptWhen(
                Effect.sleep(readTimeRemaining).pipe(
                  Effect.andThen(() => Effect.fail(enrich(deadline))),
                ),
              ),
            );
          }).pipe(Effect.mapError(enrich)),
        );
      }),
    );

  const cancel: NonNullable<Model['background']>['cancel'] = Effect.fn(
    'llm.responses.cancel',
  )(function* (input) {
    const operation = yield* boundOperation(input, origin);
    let requestId: string | undefined;
    const enrich = (error: ModelError) =>
      enrichModelError(error, {
        operation,
        responseId: operation.providerResponseId,
        requestId: error.requestId ?? requestId,
      });
    return yield* Effect.gen(function* () {
      const raw = yield* ownedAbortSafeRequest(
        async (signal) => {
          const response = await client.responses
            .cancel(operation.providerResponseId, { signal })
            .asResponse();
          requestId = response.headers.get('x-request-id') ?? undefined;
          return (await response.json()) as unknown;
        },
        (cause) =>
          enrich(
            cause instanceof SyntaxError
              ? new ModelError({
                  kind: 'malformed-output',
                  message: 'Cancellation returned malformed JSON.',
                  cause,
                })
              : openaiFailure(cause),
          ),
        {
          isAbortMatch: openaiAbortMatch,
          cleanupFailure: (cause) =>
            enrich(
              new ModelError({
                kind: 'transport',
                message: 'Cancellation failed while joining its request.',
                cause,
              }),
            ),
        },
      );
      // Cancellation cannot request encrypted output includes. Report status only.
      const parsed = ResponseSchema.pick({
        id: true,
        object: true,
        model: true,
        status: true,
      }).safeParse(raw);
      if (!parsed.success || parsed.data.id !== operation.providerResponseId)
        return yield* new ModelError({
          kind: 'malformed-output',
          message: 'Cancellation returned invalid response identity or status.',
          requestId,
        });
      const {
        status,
        id: providerResponseId,
        model: returnedModel,
      } = parsed.data;
      return CancellationEvidenceSchema.parse({
        providerResponseId,
        requestedOrigin: origin,
        returnedModel,
        ...cancellationStatus(status),
      });
    }).pipe(
      Effect.catchCause((cause) => Effect.failCause(Cause.map(cause, enrich))),
    );
  });

  return Object.freeze({
    prepareTurn,
    streamTurn,
    ...(uploads !== null
      ? {
          uploadFile: uploads.uploadFile,
          releaseUploads: uploads.releaseUploads,
        }
      : {}),
    ...(config.background === 'supported'
      ? { background: Object.freeze({ submit, observe, cancel }) }
      : {}),
  });
}
