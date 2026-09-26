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
  FILE_UPLOAD_LIFETIME_SECONDS,
  ModelConfigurationSchema,
  ObservationPolicySchema,
  TurnResultSchema,
  type BackgroundEvent,
  type BackgroundSubmission,
  type Model,
  type OpenAIResponsesConfiguration,
  type ResolvedTurn,
  completedTurn,
} from './turn.js';
import {
  ModelError,
  RemoteOperationSchema,
  boundOperation,
  cancellationStatus,
  enrichModelError,
  type RemoteOperation,
} from './errors.js';
import { sameModelOrigin } from './protocol.js';
import { ownedAbortSafeRequest } from './transport.js';
import { filesApiUploads } from './uploadCache.js';
import { openaiFailure } from './openaiError.js';
import { admittedFingerprint, canChain } from './prefixFingerprint.js';
import {
  RESPONSES_PREFIX_DOMAIN,
  openaiResponsesContinuation,
} from './openaiResponsesLower.js';
import {
  DeltaEventSchema,
  EventSchema,
  ItemEventSchema,
  ResponseEventSchema,
  ResponseSchema,
  agreesWithCompleted,
  normalizeItem,
  normalizeResponse,
  responseEvents,
  sdkEvents,
  type HttpTurnResult,
  type ResponseOrigin,
} from './openaiResponsesCodec.js';
import {
  ResponseAuthenticationSchema,
  estimateResponseInput,
  openaiAbortMatch,
  prepareResponsesTurn,
  responseAuthentication,
  responseParameters,
} from './openaiResponsesRequest.js';

// The modules this protocol was split into, re-exported so that
// `@texra-ai/llm/openai-responses` keeps the four names it exported before the
// split: this entry is the subpath's surface, and the modules behind it define
// the symbols they own.
export {
  RESPONSES_PREFIX_DOMAIN,
  openaiResponsesContinuation,
} from './openaiResponsesLower.js';
export { openaiResponsesWebSocketModel } from './openaiResponsesWebSocket.js';

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
  const origin = Object.freeze({
    protocol: config.protocol,
    requestedModel: config.requestedModel,
    deployment: config.deployment,
    codecVersion: 1,
  } satisfies ResponseOrigin);
  const authentication = responseAuthentication(transport.authentication);
  const client = new OpenAI({
    apiKey: authentication.token,
    defaultHeaders: authentication.headers,
    baseURL: config.deployment.endpoint,
    fetch: transport.fetch,
    maxRetries: 0,
    organization: null,
    project: null,
    logLevel: 'off',
  });
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
    Stream.suspend(() => {
      let requestId: string | undefined;
      let responseId: string | undefined;
      let returnedModel: string | undefined;
      const enrich = (error: ModelError) =>
        enrichModelError(error, {
          requestId: error.requestId ?? requestId,
          responseId: error.responseId ?? responseId,
          model: error.model ?? returnedModel ?? config.requestedModel,
        });
      return Stream.unwrap(
        Effect.gen(function* () {
          const { turn, opened } = yield* createResponse(input, 'foreground');
          requestId = opened.request_id ?? undefined;
          const chunks = yield* sdkEvents(opened.data, enrich);
          return responseEvents(chunks, origin).pipe(
            Stream.mapEffect((event) =>
              Effect.gen(function* () {
                if (event.kind === 'identified') {
                  responseId = event.providerResponseId;
                  returnedModel = event.returnedModel ?? undefined;
                }
                if (event.kind !== 'completed') return event;
                const continuation = yield* openaiResponsesContinuation(
                  config,
                  turn,
                  event.result,
                );
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

  const submit: NonNullable<Model['background']>['submit'] = Effect.fn(
    'llm.responses.submit',
  )(function* (input) {
    let operation: RemoteOperation | undefined;
    let returnedModel: string | undefined;
    let requestId: string | undefined;
    const enrich = (error: ModelError) =>
      enrichModelError(error, {
        operation,
        responseId: operation?.providerResponseId,
        requestId: error.requestId ?? requestId,
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
          const content = yield* Effect.forEach(response.output, normalizeItem);
          const result = yield* normalizeResponse(response, origin, content);
          const continuation = yield* openaiResponsesContinuation(
            config,
            turn,
            result,
          );
          return BackgroundSubmissionSchema.parse({
            kind: 'completed',
            result: continuation ? { ...result, continuation } : result,
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
          enrichModelError(error, {
            operation,
            responseId: operation.providerResponseId,
            requestId: error.requestId ?? requestId,
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
            let sequence = operation.afterSequence ?? -1;
            const completedItems = new Map<
              number,
              HttpTurnResult['content'][number]
            >();
            let terminal:
              | {
                  readonly result: HttpTurnResult;
                  readonly afterSequence: number;
                }
              | undefined;
            const progress = events.pipe(
              Stream.mapEffect((raw) =>
                Effect.gen(function* (): Effect.fn.Return<
                  readonly BackgroundEvent[],
                  ModelError
                > {
                  const header = EventSchema.safeParse(raw);
                  if (
                    !header.success ||
                    header.data.sequence_number <= sequence
                  )
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message:
                        'Observation emitted invalid or out-of-order events.',
                    });
                  const { type, sequence_number: afterSequence } = header.data;
                  sequence = afterSequence;
                  if (
                    [
                      'response.created',
                      'response.queued',
                      'response.in_progress',
                      'response.completed',
                      'response.incomplete',
                      'response.failed',
                    ].includes(type)
                  ) {
                    const parsed = ResponseEventSchema.safeParse(raw);
                    if (!parsed.success)
                      return yield* new ModelError({
                        kind: 'malformed-output',
                        message: 'The observed response is malformed.',
                        cause: parsed.error,
                      });
                    const response = parsed.data.response;
                    if (
                      response.id !== operation.providerResponseId ||
                      (returnedModel !== undefined &&
                        returnedModel !== response.model)
                    )
                      return yield* new ModelError({
                        kind: 'malformed-output',
                        message:
                          'Observation changed the remote response identity.',
                      });
                    const firstIdentity = returnedModel === undefined;
                    returnedModel = response.model;
                    if (
                      [
                        'response.completed',
                        'response.incomplete',
                        'response.failed',
                      ].includes(type)
                    ) {
                      if (response.status !== type.slice('response.'.length))
                        return yield* new ModelError({
                          kind: 'malformed-output',
                          message:
                            'The observed terminal event and status disagree.',
                        });
                      if (response.status === 'failed')
                        return yield* new ModelError({
                          kind: 'provider-rejection',
                          message:
                            response.error?.message ??
                            'The background response failed.',
                          cause: response.error,
                        });
                      const content = yield* Effect.forEach(
                        response.output,
                        normalizeItem,
                      );
                      for (const [index, completed] of completedItems) {
                        const observed = content[index];
                        if (
                          !observed ||
                          !agreesWithCompleted(completed, observed)
                        )
                          return yield* new ModelError({
                            kind: 'malformed-output',
                            message:
                              'The full observed terminal snapshot omits or contradicts completed output.',
                          });
                        content[index] = completed;
                      }
                      terminal = {
                        result: yield* normalizeResponse(
                          response,
                          origin,
                          content,
                        ),
                        afterSequence,
                      };
                      // The terminal cursor is delivered only with its authoritative result below.
                      return [];
                    }
                    return firstIdentity
                      ? [
                          {
                            kind: 'identified',
                            providerResponseId: response.id,
                            requestedOrigin: origin,
                            returnedModel,
                            afterSequence,
                          },
                        ]
                      : [{ kind: 'cursor', afterSequence }];
                  }
                  if (
                    [
                      'response.output_text.delta',
                      'response.refusal.delta',
                      'response.reasoning_summary_text.delta',
                      'response.reasoning_text.delta',
                    ].includes(type)
                  ) {
                    const parsed = DeltaEventSchema.safeParse(raw);
                    if (!parsed.success)
                      return yield* new ModelError({
                        kind: 'malformed-output',
                        message: 'Observed progress is malformed.',
                        cause: parsed.error,
                      });
                    let part: 'text' | 'refusal' | 'reasoning' = 'reasoning';
                    if (type === 'response.output_text.delta') part = 'text';
                    if (type === 'response.refusal.delta') part = 'refusal';
                    return [
                      {
                        kind: 'delta',
                        part,
                        text: parsed.data.delta,
                        providerItemIndex: parsed.data.output_index,
                        afterSequence,
                      },
                    ];
                  }
                  if (
                    type === 'response.output_item.added' ||
                    type === 'response.output_item.done'
                  ) {
                    const parsed = ItemEventSchema.safeParse(raw);
                    if (!parsed.success)
                      return yield* new ModelError({
                        kind: 'malformed-output',
                        message: 'Observed output content is unsupported.',
                        cause: parsed.error,
                      });
                    if (type === 'response.output_item.done') {
                      const index = parsed.data.output_index;
                      if (completedItems.has(index))
                        return yield* new ModelError({
                          kind: 'malformed-output',
                          message:
                            'Observation completed the same output position twice.',
                        });
                      completedItems.set(
                        index,
                        yield* normalizeItem(parsed.data.item),
                      );
                    }
                    return parsed.data.item.type === 'function_call'
                      ? [{ kind: 'cursor', afterSequence }]
                      : [
                          {
                            kind: 'phase',
                            part:
                              parsed.data.item.type === 'reasoning'
                                ? 'reasoning'
                                : 'text',
                            boundary:
                              type === 'response.output_item.added'
                                ? 'start'
                                : 'end',
                            providerItemIndex: parsed.data.output_index,
                            afterSequence,
                          },
                        ];
                  }
                  if (
                    [
                      'response.content_part.added',
                      'response.content_part.done',
                      'response.output_text.done',
                      'response.refusal.done',
                      'response.reasoning_summary_part.added',
                      'response.reasoning_summary_part.done',
                      'response.reasoning_summary_text.done',
                      'response.reasoning_text.done',
                      'response.function_call_arguments.delta',
                      'response.function_call_arguments.done',
                    ].includes(type)
                  )
                    return [{ kind: 'cursor', afterSequence }];
                  return yield* new ModelError({
                    kind: 'malformed-output',
                    message: `Unsupported observation event: ${type}.`,
                  });
                }),
              ),
              Stream.takeUntil(() => terminal !== undefined),
              Stream.flattenIterable,
            );
            return Stream.concat(
              progress,
              Stream.fromEffect(
                Effect.gen(function* (): Effect.fn.Return<
                  BackgroundEvent,
                  ModelError
                > {
                  if (!terminal)
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message: 'Observation ended without a terminal response.',
                    });
                  // The same anchor the foreground completion builds: an
                  // observed turn chains on `previous_response_id` too.
                  const continuation = chains
                    ? yield* openaiResponsesContinuation(
                        config,
                        turn,
                        terminal.result,
                      )
                    : undefined;
                  return {
                    kind: 'completed',
                    afterSequence: terminal.afterSequence,
                    result: continuation
                      ? { ...terminal.result, continuation }
                      : terminal.result,
                  };
                }),
              ),
            ).pipe(
              Stream.mapError(enrich),
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
    generateTurn,
    ...(uploads !== null
      ? {
          uploadFile: uploads.uploadFile,
          releaseUploads: uploads.releaseUploads,
        }
      : {}),
    ...(config.supportsInputTokenEstimation
      ? {
          estimateInputTokens: (
            input: Extract<ResolvedTurn, { mode: 'foreground' }>,
          ) =>
            estimateResponseInput(
              config,
              origin,
              { kind: 'http' },
              client,
              input,
            ),
        }
      : {}),
    ...(config.background === 'supported'
      ? { background: Object.freeze({ submit, observe, cancel }) }
      : {}),
  });
}
