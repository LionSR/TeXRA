// Node imports
import { Buffer } from 'node:buffer';

// Third-party imports
import {
  Effect,
  Exit,
  identity,
  Ref,
  Result,
  Schema,
  Stream,
  Struct,
} from 'effect';
import OpenAI from 'openai';

// Local imports - canonical model contract
import {
  completedTurn,
  FILE_UPLOAD_LIFETIME_SECONDS,
  decodeModelConfiguration,
  type BackgroundEvent,
  type Model,
  type OpenAIResponsesConfiguration,
  type ResolvedTurn,
} from '../turn.js';
import {
  ModelError,
  RemoteOperationSchema,
  fillModelError,
} from '../errors.js';
import { backgroundCapable, originOf } from '../protocol.js';
import { backgroundLifecycle } from './background.js';
import { ownedAbortSafeRequest } from './transport.js';
import { filesApiUploads } from './uploadCache.js';
import { openaiFailure } from './openaiError.js';
import { withResponsesContinuation } from './openaiResponsesLower.js';
import {
  responseEvents,
  responsesWire,
  sdkEvents,
  terminalParts,
} from './openaiResponsesCodec.js';
import {
  decodeUploadedFile,
  ResponseEventSchema,
  ResponseSchema,
} from './openaiResponsesWire.js';
import { assembleTurn, turnAssembly } from './assembleTurn.js';
import {
  ResponseAuthenticationSchema,
  openaiAbortMatch,
  openaiClient,
  prepareResponsesTurn,
  responseAuthentication,
  responseParameters,
} from './openaiResponsesRequest.js';

/** Direct Responses operations, with no application model adapter. */
export function openaiResponsesModel(
  configuration: OpenAIResponsesConfiguration,
  transport: {
    readonly authentication: typeof ResponseAuthenticationSchema.Type;
    readonly fetch?: typeof fetch;
  },
): Model {
  const config = decodeModelConfiguration(configuration);
  if (config.protocol !== 'openai-responses') {
    throw new ModelError({
      kind: 'unsupported',
      message: 'This model implements the Responses protocol.',
    });
  }
  const origin = originOf(config);
  const http = { kind: 'http' } as const;
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
            fillModelError(openaiFailure(cause), {
              model: origin.requestedModel,
            }),
          parseUploaded: decodeUploadedFile,
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
    prepareResponsesTurn(config, origin, http, request, uploads, background);

  const createResponse = Effect.fn('llm.responses.create')(function* (
    input: ResolvedTurn,
    mode: 'foreground' | 'background',
  ) {
    const { turn, parameters } = yield* responseParameters(
      config,
      origin,
      http,
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

  const lifecycle = backgroundLifecycle({
    origin,
    submit: (input, learned) =>
      Effect.gen(function* () {
        const { opened } = yield* createResponse(input, 'background');
        yield* Ref.set(learned, { requestId: opened.request_id ?? undefined });
        const source = opened.data;
        const iterator = yield* Effect.acquireRelease(
          Effect.sync(() => source[Symbol.asyncIterator]()),
          (iterator, exit) => {
            const close = iterator.return
              ? Effect.promise(() => iterator.return!())
              : Effect.void;
            const abort = Effect.sync(() => source.controller.abort());
            // After the single read no next() is pending, so an accepted
            // submission lets the SDK join its body cancellation before
            // aborting the detached request; a failed one aborts first.
            return Exit.isSuccess(exit)
              ? close.pipe(Effect.ensuring(abort))
              : abort.pipe(Effect.andThen(close));
          },
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
        const parsed = Schema.decodeUnknownResult(ResponseEventSchema)(
          first.value,
        );
        if (!Result.isSuccess(parsed))
          return yield* new ModelError({
            kind: 'malformed-output',
            message: 'Background acceptance is malformed.',
            cause: parsed.failure,
          });
        const { response, type, sequence_number } = parsed.success;
        yield* Ref.update(learned, (known) => ({
          ...known,
          model: response.model,
          operation: Schema.decodeUnknownSync(RemoteOperationSchema)({
            origin,
            providerResponseId: response.id,
            afterSequence: sequence_number,
          }),
        }));
        if (
          (type === 'response.completed' && response.status === 'completed') ||
          (type === 'response.incomplete' && response.status === 'incomplete')
        )
          return yield* completedTurn(
            assembleTurn(Stream.make(yield* terminalParts(response, type)), {
              origin,
              provider: 'The model',
            }),
          );
        if (
          ![
            'response.created',
            'response.queued',
            'response.in_progress',
          ].includes(type) ||
          !['queued', 'in_progress'].includes(response.status)
        )
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
        return undefined;
      }),
    observe: {
      stream: (operation, learned) =>
        Stream.unwrap(
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
            });
            yield* Ref.update(learned, (known) => ({
              ...known,
              requestId: opened.request_id ?? undefined,
            }));
            const events = yield* sdkEvents(opened.data, identity);
            // The observation may join mid-item: what it missed, the
            // terminal snapshot supplies.
            const assembly = turnAssembly({
              origin,
              provider: 'The model',
              responseId: operation.providerResponseId,
              partial: true,
            });
            let sequence = operation.afterSequence ?? -1;
            const progress = events.pipe(
              Stream.mapEffect(responsesWire(sequence)),
              Stream.takeUntil((event) => event.terminal),
              Stream.mapEffect((event) =>
                Effect.gen(function* () {
                  sequence = event.sequence;
                  const turnEvents = (yield* Effect.forEach(
                    event.parts,
                    assembly.step,
                  )).flat();
                  const identified = turnEvents.find(
                    (turnEvent) => turnEvent.kind === 'identified',
                  );
                  if (identified?.kind === 'identified')
                    yield* Ref.update(learned, (known) => ({
                      ...known,
                      model: identified.returnedModel ?? undefined,
                    }));
                  // The terminal cursor is delivered only with its result below.
                  if (event.terminal) return [];
                  const observed = turnEvents.flatMap(
                    (turnEvent): BackgroundEvent[] => {
                      if (turnEvent.kind === 'delta')
                        return [{ ...turnEvent, afterSequence: sequence }];
                      if (turnEvent.kind !== 'identified') return [];
                      return [
                        {
                          ...turnEvent,
                          requestedOrigin: origin,
                          afterSequence: sequence,
                        },
                      ];
                    },
                  );
                  return observed.length > 0
                    ? observed
                    : [{ kind: 'cursor' as const, afterSequence: sequence }];
                }),
              ),
              Stream.flattenIterable,
            );
            const completion = Effect.map(
              assembly.complete,
              (result): BackgroundEvent => ({
                kind: 'completed',
                afterSequence: sequence,
                result,
              }),
            );
            return Stream.concat(progress, Stream.fromEffect(completion)).pipe(
              Stream.mapError(assembly.enrich),
            );
          }),
        ),
    },
    cancel: (operation, learned) =>
      Effect.gen(function* () {
        const reply = yield* ownedAbortSafeRequest(
          async (signal) => {
            const response = await client.responses
              .cancel(operation.providerResponseId, { signal })
              .asResponse();
            return {
              requestId: response.headers.get('x-request-id') ?? undefined,
              body: await response.text(),
            };
          },
          openaiFailure,
          { isAbortMatch: openaiAbortMatch },
        );
        yield* Ref.update(learned, (known) => ({
          ...known,
          requestId: reply.requestId,
        }));
        // Cancellation cannot request encrypted output includes. Report status only.
        const parsed = Schema.decodeUnknownResult(
          Schema.fromJsonString(
            ResponseSchema.mapFields(
              Struct.pick(['id', 'object', 'model', 'status']),
            ),
          ),
        )(reply.body);
        if (
          !Result.isSuccess(parsed) ||
          parsed.success.id !== operation.providerResponseId
        )
          return yield* new ModelError({
            kind: 'malformed-output',
            message:
              'Cancellation returned invalid response identity or status.',
            cause: Result.isSuccess(parsed) ? undefined : parsed.failure,
          });
        return parsed.success.status;
      }),
    // The same anchor the foreground completion builds: an observed or
    // submitted turn chains on `previous_response_id` too.
    finalize: (turn, result) => withResponsesContinuation(config, turn, result),
  });
  const background = backgroundCapable(config) ? lifecycle : undefined;

  return Object.freeze({
    prepareTurn,
    streamTurn,
    ...(uploads !== null
      ? {
          uploadFile: uploads.uploadFile,
          releaseUploads: uploads.releaseUploads,
        }
      : {}),
    ...(background === undefined ? {} : { background }),
  });
}
