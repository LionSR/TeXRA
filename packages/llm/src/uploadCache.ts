// Node imports
import { createHash } from 'node:crypto';

// Third-party imports
import { Effect } from 'effect';

// Local imports - canonical model contract
import {
  FileUploadSchema,
  ModelError,
  type FileUpload,
  type UnreleasedUpload,
} from './turn.js';

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

/** What one upload left on the provider. */
interface Uploaded {
  readonly fileId: string;
  /** Epoch milliseconds; `null` when the provider stated no expiry. */
  readonly expiresAtMs: number | null;
}

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
  readonly releaseUploads: () => Effect.Effect<readonly UnreleasedUpload[]>;
}

const digestOf = (base64: string): string =>
  createHash('sha256').update(base64).digest('hex');

export function uploadCache(provider: {
  readonly send: (file: FileUpload) => Effect.Effect<Uploaded, ModelError>;
  readonly remove: (fileId: string) => Effect.Effect<void, ModelError>;
}): UploadCache {
  const live = new Map<string, Uploaded>();
  const inFlight = new Set<string>();
  // Every id this binding created, including one a repeated upload replaced
  // in `live`: release deletes them all.
  const owned = new Set<string>();
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
    const parsed = FileUploadSchema.safeParse(file);
    if (!parsed.success)
      return yield* new ModelError({
        kind: 'invalid-request',
        message: 'The file to upload is invalid.',
        cause: parsed.error,
      });
    const digest = digestOf(parsed.data.base64);
    if (released || live.has(digest) || inFlight.has(digest)) return;
    inFlight.add(digest);
    const uploaded = yield* provider
      .send(parsed.data)
      .pipe(Effect.ensuring(Effect.sync(() => inFlight.delete(digest))));
    // `send` can outlive a concurrent release. The check and the cache
    // writes are one synchronous stretch, so a release either already ran
    // (delete this id, do not cache it) or still sees it in `owned`.
    if (released) {
      yield* provider.remove(uploaded.fileId).pipe(
        // The release that would have reported this id already finished, so
        // a refused delete is warned here rather than silently dropped.
        Effect.catchTag('ModelError', (error) =>
          Effect.logWarning(
            `Uploaded file ${uploaded.fileId} could not be deleted after its binding was released; the provider expires it on its own (${error.message}).`,
          ),
        ),
      );
      return;
    }
    owned.add(uploaded.fileId);
    live.set(digest, uploaded);
  });

  const releaseUploads = Effect.fn('llm.uploads.release')(function* () {
    released = true;
    live.clear();
    // IDs stay owned until this attempt confirms a delete or reports a
    // provider error. An interrupt or deadline then leaves the rest for a
    // later release (the run-scope finalizer) instead of dropping them.
    const fileIds = [...owned];
    const confirmed = new Set<string>();
    const failed: UnreleasedUpload[] = [];
    const settled = yield* Effect.forEach(
      fileIds,
      (fileId) =>
        provider.remove(fileId).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              confirmed.add(fileId);
              owned.delete(fileId);
            }),
          ),
          Effect.catchTag('ModelError', (error) =>
            Effect.sync(() => {
              failed.push({ fileId, reason: error.message });
              owned.delete(fileId);
            }),
          ),
        ),
      { concurrency: 'unbounded', discard: true },
    ).pipe(
      Effect.as(true),
      // A release runs as the binding scope's finalizer, in an uninterruptible
      // region. The deadline below only bounds the deletes if it can
      // interrupt them: the pinned Effect already forks each racer
      // interruptible, but that is the race's detail, so the deletes say it
      // here rather than depend on it.
      Effect.interruptible,
      Effect.timeoutOrElse({
        duration: RELEASE_DEADLINE,
        orElse: () => Effect.succeed(false),
      }),
    );
    if (settled) return failed;
    return [
      ...failed,
      ...fileIds
        .filter(
          (fileId) =>
            !confirmed.has(fileId) &&
            !failed.some((entry) => entry.fileId === fileId),
        )
        .map((fileId) => ({
          fileId,
          reason: `no answer within ${RELEASE_DEADLINE}`,
        })),
    ];
  });

  return { fileIdFor, uploadFile, releaseUploads };
}
