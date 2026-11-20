// Node imports
import { Buffer } from 'node:buffer';

// Third-party imports
import {
  Effect,
  Exit,
  identity,
  Ref,
  type Scope,
  Stream,
  Struct,
} from 'effect';
import OpenAI from 'openai';

// Local imports - canonical model contract
import {
  completedTurn,
  FILE_UPLOAD_LIFETIME_SECONDS,
  type Model,
  type OpenAIResponsesConfiguration,
  type ResolvedTurn,
  type TurnEvent,
  backgroundCapable,
} from '../turn.js';
import { ModelError, fillModelError, remoteOperation } from '../errors.js';
import { originOf } from '../protocol.js';
import { backgroundLifecycle } from './background.js';
import {
  decodeWireOrFail,
  ownedAbortSafeRequest,
  refuseAmbientHeaders,
  wireFail,
} from './transport.js';
import { filesApiUploads } from './uploadCache.js';
import { withResponsesContinuation } from './openaiResponsesLower.js';
import {
  openaiFailure,
  responseEvents,
  responsesWire,
  isRunningSnapshotEvent,
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
  authorized,
  bearerHeaders,
  openaiClient,
  prepareResponsesTurn,
  responseParameters,
} from './openaiResponsesRequest.js';
import type { SessionToken } from '../node.js';

/** Direct Responses operations, with no application model adapter; its
 *  uploads live in the caller's scope. */
export const openaiResponsesModel = Effect.fn('llm.responses.model')(function* (
  config: OpenAIResponsesConfiguration,
  transport: {
    readonly bearer: string | SessionToken;
    readonly fetch?: typeof fetch;
  },
): Effect.fn.Return<Model, ModelError, Scope.Scope> {
  const origin = originOf(config);
  yield* refuseAmbientHeaders(
    'OPENAI_CUSTOM_HEADERS',
    'Ambient OpenAI headers cannot override the selected deployment.',
  );
  const { bearer } = transport;
  const client = openaiClient(
    config.deployment.endpoint,
    bearer,
    transport.fetch,
  );
  // Uploads serve the documents a turn sends, so they exist exactly where
  // the route takes one; the ChatGPT plan's backend and the vendor routes
  // take none.
  const uploads = config.supportsDocumentInput
    ? yield* filesApiUploads({
        providerName: 'OpenAI',
        model: origin.requestedModel,
        request: (call) =>
          authorized(bearer, (token) =>
            Effect.tryPromise({
              try: (signal) => call(signal, bearerHeaders(token)),
              catch: (cause) =>
                fillModelError(openaiFailure(cause), {
                  model: origin.requestedModel,
                }),
            }),
          ),
        parseUploaded: decodeUploadedFile,
        create: async (upload, signal, headers) =>
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
            { signal, headers },
          ),
        remove: (fileId, signal, headers) =>
          client.files.delete(fileId, { signal, headers }),
      })
    : null;
  const prepareTurn: Model['prepareTurn'] = (request) =>
    prepareResponsesTurn(config, origin, request, uploads, background);

  const createResponse = Effect.fn('llm.responses.create')(function* (
    input: ResolvedTurn,
    mode: ResolvedTurn['mode'],
  ) {
    const { turn, parameters } = yield* responseParameters(
      config,
      origin,
      input,
      mode,
      uploads,
    );
    const signal = yield* Effect.abortSignal;
    const opened = yield* authorized(bearer, (token) =>
      Effect.tryPromise({
        try: () =>
          client.responses
            .create(
              {
                ...parameters,
                stream: true,
                ...(mode === 'background' ? { background: true } : {}),
              },
              { signal, headers: bearerHeaders(token) },
            )
            .withResponse(),
        catch: openaiFailure,
      }),
    );
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
          withResponsesContinuation(turn, result),
        ).pipe(Stream.mapError(enrich));
      }).pipe(
        Effect.mapError((error) =>
          fillModelError(error, { model: config.requestedModel }),
        ),
      ),
    );

  const lifecycle = backgroundLifecycle({
    origin,
    submit: Effect.fnUntraced(function* (input, learned) {
      const { opened } = yield* createResponse(input, 'background');
      yield* Ref.set(learned, { requestId: opened.request_id ?? undefined });
      const source = opened.data;
      const iterator = yield* Effect.acquireRelease(
        Effect.sync(() => source[Symbol.asyncIterator]()),
        (iterator, exit) => {
          const returnIterator = iterator.return?.bind(iterator);
          const close = returnIterator
            ? Effect.promise(() => returnIterator())
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
        catch: openaiFailure,
      });
      if (first.done)
        return yield* wireFail(
          'Background submission ended without acceptance evidence.',
        );
      const { response, type } = yield* decodeWireOrFail(
        ResponseEventSchema,
        'Background acceptance is malformed.',
        first.value,
      );
      yield* Ref.update(learned, (known) => ({
        ...known,
        model: response.model,
        operation: remoteOperation(origin, response.id),
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
        !isRunningSnapshotEvent(type) ||
        !['queued', 'in_progress'].includes(response.status)
      )
        return yield* new ModelError({
          kind: 'provider-rejection',
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
            const opened = yield* authorized(bearer, (token) =>
              Effect.tryPromise({
                try: () =>
                  client.responses
                    .retrieve(
                      operation.providerResponseId,
                      // From the stream's start: the operation records no
                      // position, and the replayed opening events only
                      // restate the identity.
                      {
                        stream: true,
                        include: ['reasoning.encrypted_content'],
                      },
                      { signal, headers: bearerHeaders(token) },
                    )
                    .withResponse(),
                catch: openaiFailure,
              }),
            );
            yield* Ref.update(learned, (known) => ({
              ...known,
              requestId: opened.request_id ?? undefined,
            }));
            const events = yield* sdkEvents(opened.data, identity);
            // The terminal snapshot supplies any item the replay did not
            // show whole.
            const assembly = turnAssembly({
              origin,
              provider: 'The model',
              responseId: operation.providerResponseId,
              partial: true,
            });
            const progress = events.pipe(
              Stream.mapEffect(responsesWire()),
              Stream.takeUntil((event) => event.terminal),
              Stream.mapEffect(
                Effect.fnUntraced(function* (event) {
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
                  // The result is delivered once, by the completion below.
                  if (event.terminal) return [];
                  return turnEvents.filter(
                    (turnEvent) => turnEvent.kind !== 'completed',
                  );
                }),
              ),
              Stream.flattenIterable,
            );
            const completion = Effect.map(
              assembly.complete,
              (result): TurnEvent => ({ kind: 'completed', result }),
            );
            return Stream.concat(progress, Stream.fromEffect(completion)).pipe(
              Stream.mapError(assembly.enrich),
            );
          }),
        ),
    },
    cancel: Effect.fnUntraced(function* (operation, learned) {
      const reply = yield* authorized(bearer, (token) =>
        ownedAbortSafeRequest(
          (signal) =>
            client.responses
              .cancel(operation.providerResponseId, {
                signal,
                headers: bearerHeaders(token),
              })
              .withResponse(),
          openaiFailure,
        ),
      );
      yield* Ref.update(learned, (known) => ({
        ...known,
        requestId: reply.request_id ?? undefined,
      }));
      // Cancellation cannot request encrypted output includes. Report status only.
      const invalid =
        'Cancellation returned invalid response identity or status.';
      const parsed = yield* decodeWireOrFail(
        ResponseSchema.mapFields(
          Struct.pick(['id', 'object', 'model', 'status']),
        ),
        invalid,
        reply.data,
      );
      if (parsed.id !== operation.providerResponseId)
        return yield* wireFail(invalid);
      return parsed.status;
    }),
    // The same anchor the foreground completion builds: an observed or
    // submitted turn chains on `previous_response_id` too.
    finalize: (turn, result) => withResponsesContinuation(turn, result),
  });
  const background = backgroundCapable(config) ? lifecycle : undefined;

  return Object.freeze({
    prepareTurn,
    streamTurn,
    ...(uploads !== null ? { uploadFile: uploads.uploadFile } : {}),
    ...(background === undefined ? {} : { background }),
  });
});
