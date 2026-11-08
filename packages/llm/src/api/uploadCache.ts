// Node imports
import { hash } from 'node:crypto';

// Third-party imports
import { Effect, Result, Schema, type Scope } from 'effect';

// Local imports - canonical model contract
import { FileUploadSchema, type FileUpload } from '../turn.js';
import { ModelError } from '../errors.js';

/**
 * Time allowed between lowering a turn and the provider resolving its file
 * ids, so an upload that would expire while the request is in flight lowers
 * from bytes instead. A TeXRA margin, not a provider figure.
 */
const EXPIRY_MARGIN_MS = 60_000;

/**
 * How long a binding's release waits, in all, for the provider to delete the
 * files it uploaded. The deletes run concurrently, so this bounds the whole
 * release rather than each file; a release runs as the run's scope closes and
 * must not hold that close open.
 */
const RELEASE_DEADLINE = '10 seconds';

/** What one upload left on the provider: its id and, in epoch
 *  milliseconds, when the provider will drop it (`null` for never). Each
 *  files endpoint's own response schema decodes to this shape. */
export const UploadedSchema = Schema.Struct({
  fileId: Schema.String,
  expiresAtMs: Schema.NullOr(Schema.Number),
});
type Uploaded = typeof UploadedSchema.Type;

/**
 * One binding's uploads, held in memory and nowhere else. The key is a
 * SHA-256 digest of the bytes, so a document sent again in a later round
 * finds its id; the binding is the cache itself, so an id is only ever sent
 * on the model that uploaded it, and a new binding starts empty.
 */
export interface UploadCache {
  /** The live file id for these bytes, or `null` to send the bytes. */
  readonly fileIdFor: (base64: string, nowMs: number) => string | null;
  readonly uploadFile: (file: FileUpload) => Effect.Effect<void, ModelError>;
}

/** Digests one binding keeps, so a document lowered on every turn (and
 *  twice in one, to check then to send) is hashed once. */
const DIGEST_MEMO_SIZE = 64;

/**
 * A binding's SHA-256 of base64 bytes, memoized by the string itself: the
 * history holds the same string turn after turn, and comparing it is far
 * cheaper than hashing it. The memo belongs to the binding, so the strings
 * it holds go when the binding does, not with the process.
 */
const digestMemo = (): ((base64: string) => string) => {
  const digests = new Map<string, string>();
  return (base64) => {
    const known = digests.get(base64);
    if (known !== undefined) return known;
    const digest = hash('sha256', base64, 'hex');
    const [oldest] = digests.keys();
    if (digests.size >= DIGEST_MEMO_SIZE && oldest !== undefined)
      digests.delete(oldest);
    digests.set(base64, digest);
    return digest;
  };
};

/** What a binding supplies of its provider's Files API. */
interface FilesApi {
  /** Names the provider in the malformed-response message. */
  readonly providerName: string;
  readonly model: string;
  /**
   * How this binding sends one Files request: the headers it carries (a
   * session's token) and its rejection as this binding's enriched
   * `ModelError`.
   */
  readonly request: <A>(
    call: (
      signal: AbortSignal,
      headers: Readonly<Record<string, string>>,
    ) => Promise<A>,
  ) => Effect.Effect<A, ModelError>;
  /**
   * The create response's id and expiry, in canonical form. Each provider
   * states its expiry differently (RFC 3339 against whole Unix seconds), so
   * the schema that reads it is the binding's, not this helper's.
   */
  readonly parseUploaded: (
    raw: unknown,
  ) => Result.Result<Uploaded, Schema.SchemaError>;
  readonly create: (
    file: FileUpload,
    signal: AbortSignal,
    headers: Readonly<Record<string, string>>,
  ) => Promise<unknown>;
  readonly remove: (
    fileId: string,
    signal: AbortSignal,
    headers: Readonly<Record<string, string>>,
  ) => Promise<unknown>;
}

/**
 * One binding's Files API cache. Its scope deletes every uploaded id under
 * one deadline and reports anything the provider did not confirm deleted.
 * The providers supply their SDK calls and expiry decoding; malformed
 * replies and an already-absent file on deletion are handled here.
 */
export const filesApiUploads = Effect.fn('llm.uploads')(function* (
  provider: FilesApi,
): Effect.fn.Return<UploadCache, never, Scope.Scope> {
  const send = Effect.fnUntraced(function* (upload: FileUpload) {
    const created = yield* provider.request((signal, headers) =>
      provider.create(upload, signal, headers),
    );
    const parsed = provider.parseUploaded(created);
    if (!Result.isSuccess(parsed))
      return yield* new ModelError({
        kind: 'provider-rejection',
        message: `${provider.providerName} returned an upload without a usable file id.`,
        model: provider.model,
        cause: parsed.failure,
      });
    return parsed.success;
  });
  const remove = (fileId: string) =>
    provider
      .request((signal, headers) => provider.remove(fileId, signal, headers))
      .pipe(
        Effect.asVoid,
        Effect.catchTag('ModelError', (error) =>
          error.status === 404 ? Effect.void : Effect.fail(error),
        ),
      );

  const digestOf = digestMemo();
  const live = new Map<string, Uploaded>();
  const inFlight = new Set<string>();
  let released = false;

  const fileIdFor = (base64: string, nowMs: number): string | null => {
    const entry = live.get(digestOf(base64));
    if (entry === undefined) return null;
    return entry.expiresAtMs === null ||
      entry.expiresAtMs - EXPIRY_MARGIN_MS > nowMs
      ? entry.fileId
      : null;
  };

  const uploadFile = Effect.fn('llm.uploads.uploadFile')(function* (
    file: FileUpload,
  ) {
    const parsed = Schema.decodeUnknownResult(FileUploadSchema)(file);
    if (!Result.isSuccess(parsed))
      return yield* new ModelError({
        kind: 'invalid-request',
        message: 'The file to upload is invalid.',
        cause: parsed.failure,
      });
    const digest = digestOf(parsed.success.base64);
    // Only the request is interruptible: once it answers, the id has one
    // owner at every instant: the cache, or this fiber after scope close.
    yield* Effect.uninterruptibleMask((restore) => {
      if (released || live.has(digest) || inFlight.has(digest))
        return Effect.void;
      inFlight.add(digest);
      return Effect.gen(function* () {
        const uploaded = yield* restore(send(parsed.success));
        if (!released) {
          live.set(digest, uploaded);
          return;
        }
        // The release that would have reported this id already finished, so
        // a delete refused or cut short is warned here, never dropped.
        const unreleased = (why: string) =>
          Effect.logWarning(
            `Uploaded file ${uploaded.fileId} could not be deleted after its binding was released; the provider expires it on its own (${why}).`,
          );
        yield* restore(remove(uploaded.fileId)).pipe(
          Effect.catchTag('ModelError', (error) => unreleased(error.message)),
          Effect.onInterrupt(() => unreleased('interrupted')),
        );
      }).pipe(
        // Keep the claim until the id is published: an uninterruptible
        // fiber can still yield to another uploader before that write.
        Effect.ensuring(Effect.sync(() => inFlight.delete(digest))),
      );
    });
  });

  yield* Effect.addFinalizer(
    Effect.fn('llm.uploads.release')(function* () {
      released = true;
      // A digest is uploaded once. Derive unique ids before clearing the
      // cache, since a provider may return the same id for different bytes.
      const pending = new Map(
        [...live.values()].map(({ fileId }) => [
          fileId,
          `no answer within ${RELEASE_DEADLINE}`,
        ]),
      );
      live.clear();
      yield* Effect.forEach(
        [...pending.keys()],
        (fileId) =>
          remove(fileId).pipe(
            Effect.match({
              onSuccess: () => {
                pending.delete(fileId);
              },
              onFailure: (error) => {
                pending.set(fileId, error.message);
              },
            }),
          ),
        { concurrency: 'unbounded', discard: true },
      ).pipe(
        // Scope finalizers are uninterruptible; the deadline must be able
        // to interrupt the deletes it bounds.
        Effect.interruptible,
        Effect.timeoutOrElse({
          duration: RELEASE_DEADLINE,
          orElse: () => Effect.void,
        }),
      );
      if (pending.size > 0)
        yield* Effect.logWarning(
          `Could not delete ${pending.size} uploaded file(s) when the ${provider.model} binding closed; the provider expires them on its own.`,
        ).pipe(
          Effect.annotateLogs({
            unreleased: [...pending].map(([fileId, reason]) => ({
              fileId,
              reason,
            })),
          }),
        );
    }),
  );
  return { fileIdFor, uploadFile };
});
