import * as path from 'node:path';
import { createGunzip } from 'node:zlib';
import {
  randomizedExponentialBackoff,
  isTransientHttpStatus,
} from '@texra-ai/harness/plugins';
import {
  readDirectoryTypedTolerant,
  entryTypeIn,
} from '@texra-ai/harness/node';

import * as NodeStream from '@effect/platform-node/NodeStream';
import { parse as parseContentDisposition } from 'content-disposition';
import {
  Cause,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  PlatformError,
  Schedule,
  Schema,
  Stream,
} from 'effect';
import { Headers, HttpClient } from 'effect/http';
import { StatusCodes } from 'http-status-codes';
import * as tar from 'tar';

import { withLogChannel, hasExtension } from '@texra-ai/harness';
import { ensureError, toErrorMessage } from '@texra-ai/harness/schemas';
import { normaliseArxivIdentifier } from './arxivIdentifier';
import {
  indentLatexFilesInDirectory,
  type IndentLatexResult,
} from './formatter/indentDirectory';
import type { LatexFormatter } from './formatter/texFormatter';

// Cover the entire request, including body streaming, while allowing large
// tarballs to complete on a slow link.
const DOWNLOAD_TIMEOUT_MS = 120_000; // 2 min

/** Retries after the first download attempt. */
const DOWNLOAD_RETRIES = 2;

/** How long a tar extraction may run before it is abandoned. */
const EXTRACT_TIMEOUT_MS = 30_000;

/**
 * A source-download failure that ends the retry loop immediately — a PDF-only
 * submission, a 404, or another non-transient HTTP status, the failures the
 * old p-retry `AbortError` marked permanent. `downloadSource` also fails with
 * it for the non-download errors (invalid input, no open workspace,
 * extraction or placement failure), which never had a retry loop to abort.
 */
class ArxivSourcePermanentError extends Schema.TaggedError<ArxivSourcePermanentError>()(
  'ArxivSourcePermanentError',
  {
    message: Schema.String,
  },
) {}

/**
 * A failed download attempt worth retrying: a network-level failure, the
 * per-attempt deadline, or a transient HTTP status (408/429/5xx, see
 * {@link isTransientHttpStatus}). Once the retries are exhausted it is the
 * program's failure.
 */
class ArxivSourceTransientError extends Schema.TaggedError<ArxivSourceTransientError>()(
  'ArxivSourceTransientError',
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** The typed failures of an arXiv source download. */
export type ArxivSourceError =
  ArxivSourcePermanentError | ArxivSourceTransientError;

/** What one download attempt reads: the file it writes and the client. */
type DownloadServices = FileSystem.FileSystem | HttpClient.HttpClient;

/**
 * Classify a step outside the download attempt as a permanent failure: only
 * the attempt itself is retried, so nothing else has a retry loop to abort.
 * A failed read, write, rename or format run ends the run, in errno words.
 */
const permanentFsError = (error: PlatformError.PlatformError) =>
  new ArxivSourcePermanentError({
    message: toErrorMessage(error.reason.cause ?? error),
  });

const permanentFs = <T, R>(
  effect: Effect.Effect<T, PlatformError.PlatformError, R>,
): Effect.Effect<T, ArxivSourcePermanentError, R> =>
  effect.pipe(Effect.mapError(permanentFsError));

export type ArxivDownloadDestination = 'root' | 'references';

interface DownloadSourceOptions {
  workspaceRoot: string;
  formatter: LatexFormatter | null;
  progressCallback?: (msg: string, increment?: number) => void;
  autoIndent?: boolean;
  destination?: ArxivDownloadDestination;
}

const INVALID_ARXIV_INPUT_ERROR =
  'Invalid arXiv ID or URL. Please provide a valid arXiv ID (e.g., 2404.12175) or URL (e.g., https://arxiv.org/abs/2404.12175)';

const PDF_ONLY_SUBMISSION_ERROR =
  'This arXiv paper only has a PDF submission — no LaTeX source is available for download';

/** What auto-indent did to a downloaded source, every outcome named. */
function describeIndent(result: IndentLatexResult): string {
  switch (result.status) {
    case 'formatted':
      return result.failed.length === 0
        ? `Formatted ${result.count} LaTeX files`
        : `Formatted ${result.count} LaTeX files; ${result.failed.length} could not be formatted: ${result.failed.map((file) => path.basename(file)).join(', ')}`;
    case 'disabled':
      return 'LaTeX formatting is disabled; the source is left as downloaded';
    case 'missing-config':
      return `LaTeX formatting skipped: its config ${result.configPath} was not found`;
    case 'error':
      return `LaTeX formatting failed: ${toErrorMessage(result.error)}`;
  }
}

/**
 * Determine file extension from content-type header.
 * Handles tar, gzip, and tex content types. The caller rejects a PDF content
 * type first (no LaTeX source available), so a PDF never reaches here.
 */
function getExtensionFromContentType(contentType: string): string {
  const isTar = contentType.includes('tar');
  const isGzip = contentType.includes('gz');
  const isTex = contentType.includes('tex') || contentType.includes('plain');

  if (isTar && isGzip) return '.tar.gz';
  if (isTar) return '.tar';
  if (isGzip) return '.gz';
  if (isTex) return '.tex';
  return '';
}

/**
 * NOTE: The channel string stays 'arxivProcessor' (lowercase) even though the
 * exported singleton was renamed to PascalCase in #7347. It is used directly as
 * the logger channel and prefixes every log line as `[arxivProcessor] ...`, so
 * keep it stable for anything filtering on the channel name — a class-identifier
 * rename must not change this value.
 */
const ARXIV_CHANNEL = 'arxivProcessor';

class ArxivSourceProcessor {
  /**
   * Best-effort delete that logs failures at debug level instead of failing.
   * `force` mirrors the facade's `delete`, which swallowed a missing target
   * (`ENOENT`) rather than reporting it; every other failure still reaches
   * the debug log below.
   */
  private cleanUpBestEffort(
    target: string,
    description: string,
    options?: { recursive?: boolean },
  ): Effect.Effect<void, never, FileSystem.FileSystem> {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(target, {
        recursive: options?.recursive ?? false,
        force: true,
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.logDebug(`Failed to clean up ${description} ${target}`).pipe(
          Effect.annotateLogs({ data: error }),
        ),
      ),
      withLogChannel(ARXIV_CHANNEL),
    );
  }

  /** @returns Error message if invalid, null if valid */
  public validateId(input: string): string | null {
    if (!input) return 'arXiv ID or URL is required';
    return normaliseArxivIdentifier(input) ? null : INVALID_ARXIV_INPUT_ERROR;
  }

  /** Sanitized directory name for a paper (e.g. `2404.12175` or `cs_0501072`). */
  public getPaperDirName(input: string): string {
    const id = normaliseArxivIdentifier(input);
    return id ? id.replaceAll('/', '_') : input;
  }

  /**
   * Download `url` to disk, retrying transient failures — network errors,
   * the per-attempt deadline, or 408/429/5xx (see
   * {@link isTransientHttpStatus}) — with exponential backoff. Permanent
   * failures — other 4xx statuses or a PDF-only submission — end the retry
   * loop immediately. Interruption stops both the active attempt and the
   * backoff sleep.
   */
  public downloadFile(
    url: string,
    destBasePath: string,
    timeout = 30000,
  ): Effect.Effect<string, ArxivSourceError, DownloadServices> {
    return this.downloadFileOnce(url, destBasePath, timeout).pipe(
      // Retry the whole ordinary failure, never a mixed cleanup cause. Effect's
      // typed-error retry otherwise selects one failure and drops its siblings.
      Effect.catchCause((cause) => Effect.fail(cause)),
      Effect.tapError((cause) =>
        Effect.gen(function* () {
          // A permanent failure ends the retry unobserved, since it never had
          // retries left to report.
          const reason = cause.reasons[0];
          if (
            cause.reasons.length !== 1 ||
            reason?._tag !== 'Fail' ||
            reason.error._tag !== 'ArxivSourceTransientError'
          )
            return;
          const { attempt } = yield* Schedule.CurrentMetadata;
          yield* Effect.logDebug(
            `Download attempt failed (${DOWNLOAD_RETRIES - attempt} retries left): ${reason.error.message}`,
          );
        }),
      ),
      Effect.retry({
        // 1 s doubling, scaled by a uniform factor in [1, 2) so concurrent
        // clients don't retry in lockstep: the window the download had under
        // p-retry's `minTimeout: 1000, randomize: true`.
        schedule: randomizedExponentialBackoff(Duration.seconds(1)),
        times: DOWNLOAD_RETRIES,
        while: (cause) =>
          cause.reasons.length === 1 &&
          cause.reasons[0]?._tag === 'Fail' &&
          cause.reasons[0].error._tag === 'ArxivSourceTransientError',
      }),
      Effect.catch((cause) => Effect.failCause(cause)),
      withLogChannel(ARXIV_CHANNEL),
    );
  }

  private downloadFileOnce(
    url: string,
    destBasePath: string,
    timeout: number,
  ): Effect.Effect<string, ArxivSourceError, DownloadServices> {
    let destPath = destBasePath;
    // The request, the deadline and the file writes all fail as `Error`s.
    const downloadError = (cause: Error) => {
      const timedOut = Cause.isTimeoutError(cause);
      return Effect.fail(
        new ArxivSourceTransientError({
          message: timedOut
            ? `Download timed out after ${timeout} ms`
            : cause.message,
          cause: timedOut ? undefined : cause,
        }),
      );
    };
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const client = yield* HttpClient.HttpClient;
      // The request scope aborts the request however the attempt ends,
      // covering connection establishment and body streaming.
      const response = yield* HttpClient.withScope(client).get(url);

      if (response.status === StatusCodes.NOT_FOUND) {
        return yield* Effect.fail(
          new ArxivSourcePermanentError({
            message: 'Source not available for this arXiv ID',
          }),
        );
      }

      if (response.status !== StatusCodes.OK) {
        const message = `Failed to download: HTTP ${response.status}`;
        return yield* Effect.fail(
          isTransientHttpStatus(response.status)
            ? new ArxivSourceTransientError({ message, cause: response.status })
            : new ArxivSourcePermanentError({ message }),
        );
      }

      // Extract filename from Content-Disposition header if available.
      // Uses content-disposition package for full RFC 6266 / RFC 5987 compliance,
      // which handles both `filename=` and `filename*=UTF-8''...` (percent-encoded
      // Unicode names that the old regex silently dropped).
      const disposition = Headers.get(response.headers, 'content-disposition');
      let filename: string | undefined;
      if (Option.isSome(disposition)) {
        filename = yield* Effect.try({
          try: () =>
            parseContentDisposition(disposition.value).parameters.filename,
          catch: ensureError,
        }).pipe(
          Effect.catch((error) =>
            // Malformed header; the content-type fallback below handles it.
            Effect.logDebug(
              'Ignoring malformed Content-Disposition header from arXiv source download',
            ).pipe(
              Effect.annotateLogs({
                data: {
                  header: disposition.value,
                  error: toErrorMessage(error),
                },
              }),
              Effect.as(undefined),
            ),
          ),
        );
      }
      if (filename) {
        // basename prevents path traversal from a crafted header value.
        destPath = path.join(
          path.dirname(destBasePath),
          path.basename(filename),
        );
      } else {
        const contentType = Option.getOrElse(
          Headers.get(response.headers, 'content-type'),
          () => '',
        );
        if (contentType.includes('pdf')) {
          // No LaTeX source available: a permanent failure, not retried.
          return yield* Effect.fail(
            new ArxivSourcePermanentError({
              message: PDF_ONLY_SUBMISSION_ERROR,
            }),
          );
        }
        destPath = destBasePath + getExtensionFromContentType(contentType);
      }

      const file = yield* fs.open(destPath, { flag: 'w' });
      yield* Stream.runForEach(response.stream, (chunk) =>
        file.writeAll(chunk),
      );
      return destPath;
    }).pipe(
      // One deadline spans the headers and the body. Closing the scope closes
      // the file handle, then aborts the request.
      Effect.scoped,
      Effect.timeout(Duration.millis(timeout)),
      Effect.catchTags({
        HttpClientError: downloadError,
        TimeoutError: downloadError,
        PlatformError: downloadError,
      }),
      // Failure and interruption both clean up after the scope closed the
      // file handle, so neither cleanup nor a retry can race its writes (and
      // Windows does not refuse to unlink an open file).
      Effect.onError(() =>
        this.cleanUpBestEffort(destPath, 'partial download'),
      ),
    );
  }

  /**
   * Extract `tarPath` into `destDir`. tar has no abort option, so
   * interruption (the deadline's included) stops admitting entries, and tar's
   * own promise is joined outside the timeout race so a distinct late
   * rejection stays observable. The join is unbounded; a rejection need not
   * mean every write closed.
   */
  private extractTarFile(
    tarPath: string,
    destDir: string,
  ): Effect.Effect<void, ArxivSourcePermanentError> {
    return Effect.gen(function* () {
      yield* Effect.logDebug(`Extracting tar file: ${tarPath} to ${destDir}`);
      let pending: Promise<void> | undefined;
      let signal: AbortSignal | undefined;
      let primary: { error: unknown } | undefined;
      yield* Effect.tryPromise({
        try: (requestSignal) => {
          signal = requestSignal;
          pending = tar.x({
            file: tarPath,
            cwd: destDir,
            filter: () => !requestSignal.aborted,
          });
          return pending;
        },
        catch: (error) => error,
      }).pipe(
        Effect.timeout(Duration.millis(EXTRACT_TIMEOUT_MS)),
        Effect.catch((cause) => {
          primary = { error: cause };
          const error = Cause.isTimeoutError(cause)
            ? 'Extraction timed out'
            : toErrorMessage(cause);
          return Effect.logError(`Failed to extract tar file: ${error}`).pipe(
            Effect.andThen(
              Effect.fail(
                new ArxivSourcePermanentError({
                  message: `Failed to extract arXiv source: ${error}`,
                }),
              ),
            ),
          );
        }),
        Effect.onExit(() =>
          Effect.promise(
            () =>
              pending?.then(
                () => {},
                (error: unknown) => {
                  if (primary !== undefined && primary.error === error) return;
                  if (
                    signal?.aborted &&
                    (error === signal.reason ||
                      (error instanceof Error &&
                        error.name === 'AbortError' &&
                        error.cause === signal.reason))
                  )
                    return;
                  // A distinct late tar failure must survive interruption.
                  throw error;
                },
              ) ?? Promise.resolve(),
          ),
        ),
      );
    }).pipe(withLogChannel(ARXIV_CHANNEL));
  }

  public readonly downloadSource = Effect.fn('arxivProcessor.downloadSource')(
    { self: this },
    function* (
      this: ArxivSourceProcessor,
      input: string,
      options: DownloadSourceOptions,
    ) {
      const {
        workspaceRoot,
        formatter,
        progressCallback,
        autoIndent = true,
        destination = 'references',
      } = options;
      // Normalize input (URL or ID) to plain arXiv ID
      const id = normaliseArxivIdentifier(input);
      if (!id) {
        return yield* Effect.fail(
          new ArxivSourcePermanentError({ message: INVALID_ARXIV_INPUT_ERROR }),
        );
      }

      yield* Effect.logInfo(`Downloading arXiv source for ID: ${id}`);

      if (!workspaceRoot) {
        return yield* Effect.fail(
          new ArxivSourcePermanentError({
            message: 'No workspace folder is open',
          }),
        );
      }

      // An old-style ID ('math/0501234') carries a slash, which would nest
      // the paper under an extra directory level; flatten it into the name.
      const isRoot = destination === 'root';
      const paperDirFull = path.join(
        workspaceRoot,
        isRoot ? '.' : `References/${id.replaceAll('/', '_')}`,
      );

      const needsDownload = !(yield* this.hasExistingSource(
        isRoot,
        paperDirFull,
      ));
      if (needsDownload) {
        yield* this.fetchAndPlaceSource(
          id,
          paperDirFull,
          isRoot,
          progressCallback,
        );
      }

      // Skip auto-indent for root destination to avoid reformatting existing workspace files
      if (autoIndent && !isRoot) {
        progressCallback?.('Formatting LaTeX files...', 85);

        const indentResult = yield* permanentFs(
          indentLatexFilesInDirectory(
            workspaceRoot,
            formatter,
            paperDirFull,
            progressCallback,
          ),
        );

        // Formatting is post-processing on a source that has landed, so its
        // failure does not fail the download; it is said, never a bare count.
        const indented = describeIndent(indentResult);
        if (indentResult.status !== 'formatted' || indentResult.failed.length)
          yield* Effect.logWarning(indented);
        progressCallback?.(indented, 95);
      }

      progressCallback?.('arXiv source downloaded successfully!', 100);

      yield* Effect.logInfo(`arXiv source downloaded to: ${paperDirFull}`);

      return { path: paperDirFull, alreadyExisted: !needsDownload };
    },
    withLogChannel(ARXIV_CHANNEL),
  );

  /**
   * Whether a previously-downloaded source already exists at the paper directory.
   * Skipped for the workspace root, where stray .tex files would be a false
   * positive.
   */
  private hasExistingSource(
    isRoot: boolean,
    paperDirFull: string,
  ): Effect.Effect<
    boolean,
    ArxivSourceError,
    FileSystem.FileSystem | Path.Path
  > {
    return Effect.gen(function* () {
      if (isRoot) {
        return false;
      }
      const fs = yield* FileSystem.FileSystem;
      if ((yield* permanentFs(entryTypeIn(fs, paperDirFull))) === undefined) {
        return false;
      }
      // The tolerant listing is the facade's `readDir`: the provider typed
      // ordinary entries from the `readdir` dirent, but a *symlink* dirent
      // still ran one `stat` (`fileTypeFor` → `resolveSymlinkType`). The
      // strict form lstats every entry, and its EACCES would abort the
      // download -- turning "the source is already here" into a failure.
      const entries = yield* permanentFs(
        readDirectoryTypedTolerant(paperDirFull),
      );
      const hasTexFiles = entries.some(([name]) => hasExtension(name, '.tex'));
      if (hasTexFiles) {
        yield* Effect.logInfo(
          `arXiv source already exists at: ${paperDirFull}`,
        );
      }
      return hasTexFiles;
    }).pipe(withLogChannel(ARXIV_CHANNEL));
  }

  /**
   * Remove the paper directory an unfinished download created: a partial
   * tree holding one `.tex` would pass `hasExistingSource` on the next
   * download, which would then report an incomplete source as downloaded.
   * A removal that fails is a warning, and its message is what the
   * download's own failure carries, so the user knows to remove the tree.
   * @returns null once removed, else the message naming what is left.
   */
  private removeUnfinishedPaperDir(
    paperDirFull: string,
  ): Effect.Effect<string | null, never, FileSystem.FileSystem> {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.remove(paperDirFull, { recursive: true, force: true });
    }).pipe(
      Effect.as(null),
      Effect.catch((error) => {
        const message = `A partial source was left at ${paperDirFull} (${toErrorMessage(error.reason.cause ?? error)}); remove it before downloading again.`;
        return Effect.logWarning(message).pipe(Effect.as(message));
      }),
      withLogChannel(ARXIV_CHANNEL),
    );
  }

  /**
   * Download the arXiv source and place it into the paper directory
   * (`stageAndPlaceSource`). A paper directory this download creates is its
   * own until the source is fully placed: any other exit -- a PDF-only
   * submission, a failed extraction, or Cancel mid-extraction -- removes it
   * (`removeUnfinishedPaperDir`), and a failure whose directory could not be
   * removed says so. A directory that was already there, and the workspace
   * root, belong to the user and stay.
   */
  private readonly fetchAndPlaceSource = Effect.fn(
    'arxivProcessor.fetchAndPlaceSource',
  )(
    { self: this },
    function* (
      this: ArxivSourceProcessor,
      id: string,
      paperDirFull: string,
      isRoot: boolean,
      progressCallback: DownloadSourceOptions['progressCallback'],
    ) {
      const fs = yield* FileSystem.FileSystem;
      // The claim is the create itself: a non-recursive `makeDirectory` either
      // makes the directory, and this download owns it, or fails
      // `AlreadyExists`, and it is the user's or a concurrent download's. An
      // existence probe before the create let two downloads of one id (two
      // runs, or a run and the host command) both pass it, both believe they
      // owned the directory, and the loser's cleanup remove the winner's
      // placed source.
      const ownsPaperDir = isRoot
        ? false
        : yield* permanentFs(
            fs
              .makeDirectory(path.dirname(paperDirFull), { recursive: true })
              .pipe(
                Effect.andThen(fs.makeDirectory(paperDirFull)),
                Effect.as(true),
                Effect.catchIf(
                  (error) => error.reason._tag === 'AlreadyExists',
                  () => Effect.succeed(false),
                ),
              ),
          );
      // `Effect.scoped` closes the staging directory's finalizer here, on
      // success, failure and interruption alike, before the paper directory
      // that holds it is removed.
      const placed = Effect.scoped(
        this.stageAndPlaceSource(id, paperDirFull, progressCallback),
      );
      if (!ownsPaperDir) return yield* placed;
      const removeUnfinished = this.removeUnfinishedPaperDir(paperDirFull);
      return yield* placed.pipe(
        // Cancel or a defect reads no failure message: the warning is all.
        Effect.onExit((exit) =>
          Exit.isFailure(exit) &&
          (Cause.hasInterrupts(exit.cause) || !Cause.hasFails(exit.cause))
            ? Effect.asVoid(removeUnfinished)
            : Effect.void,
        ),
        // A failure carries what its cleanup left behind; with a partial
        // tree in place, trying again cannot help, so it is permanent.
        Effect.catch((error) =>
          Effect.flatMap(removeUnfinished, (left) =>
            Effect.fail(
              left === null
                ? error
                : new ArxivSourcePermanentError({
                    message: `${error.message} ${left}`,
                  }),
            ),
          ),
        ),
      );
    },
  );

  /**
   * Download the arXiv source tarball into a unique staging directory in the
   * paper directory, reject PDF-only submissions, and place the source files
   * into the paper root. The staging directory is removed by a scope
   * finalizer, so the caller must run this inside `Effect.scoped`.
   */
  private readonly stageAndPlaceSource = Effect.fn(
    'arxivProcessor.stageAndPlaceSource',
  )(
    { self: this },
    function* (
      this: ArxivSourceProcessor,
      id: string,
      paperDirFull: string,
      progressCallback: DownloadSourceOptions['progressCallback'],
    ) {
      const fs = yield* FileSystem.FileSystem;
      // A staging directory of this download's own: a fixed name derived from
      // the id would be shared by two downloads of the same paper, which
      // would then stream into one archive file and remove each other's
      // staging. The prefix keeps it clear of a user's `download/` folder.
      const downloadDirFull = yield* permanentFs(
        fs.makeTempDirectory({
          directory: paperDirFull,
          prefix: `.arxiv-download-${id.replaceAll('/', '_')}-`,
        }),
      );
      // The staging directory belongs to this scope, so removing it is a scope
      // finalizer rather than a step on the happy path. Every non-success exit
      // used to leave `.arxiv-download-<id>/` behind in the paper directory: a
      // download that ran out of retries, a PDF-only submission detected from
      // the content type, a failed extraction, and interruption.
      yield* Effect.addFinalizer(() =>
        this.cleanUpBestEffort(downloadDirFull, 'staging download dir', {
          recursive: true,
        }),
      );
      const downloadBasePath = path.join(downloadDirFull, 'source');

      progressCallback?.(`Downloading arXiv source for ${id}...`, 20);

      const downloadUrl = `https://arxiv.org/src/${id}`;
      const downloadedPath = yield* this.downloadFile(
        downloadUrl,
        downloadBasePath,
        DOWNLOAD_TIMEOUT_MS,
      );

      // Detect PDF-only submissions (no LaTeX source available)
      if (hasExtension(downloadedPath, '.pdf')) {
        return yield* Effect.fail(
          new ArxivSourcePermanentError({ message: PDF_ONLY_SUBMISSION_ERROR }),
        );
      }

      yield* this.placeSourceFiles(
        downloadedPath,
        downloadDirFull,
        paperDirFull,
        progressCallback,
      );
    },
  );

  /**
   * Place the downloaded source into the paper directory: extract a tar/tgz
   * archive in staging and move its entries in, or decompress (gzip) and
   * rename a single source file to main.tex; nothing existing is overwritten.
   */
  private readonly placeSourceFiles = Effect.fn(
    'arxivProcessor.placeSourceFiles',
  )(
    { self: this },
    function* (
      this: ArxivSourceProcessor,
      downloadedPath: string,
      downloadDirFull: string,
      paperDirFull: string,
      progressCallback: DownloadSourceOptions['progressCallback'],
    ) {
      const fs = yield* FileSystem.FileSystem;
      const isArchive =
        hasExtension(downloadedPath, '.tar') ||
        downloadedPath.endsWith('.tar.gz') ||
        hasExtension(downloadedPath, '.tgz');
      const isGzipOnly = !isArchive && hasExtension(downloadedPath, '.gz');

      if (isArchive) {
        progressCallback?.('Extracting source files...', 60);
        // Staged fresh (a killed run's leftover never collides): no entry
        // overwrites the workspace; Cancel cannot split the moves.
        const extractedDir = yield* permanentFs(
          fs.makeTempDirectory({ directory: downloadDirFull, prefix: 'x-' }),
        );
        const staged = (entry: string) => path.join(extractedDir, entry);
        const placed = (entry: string) => path.join(paperDirFull, entry);
        yield* this.extractTarFile(downloadedPath, extractedDir);
        const entries = yield* permanentFs(fs.readDirectory(extractedDir));
        const collisions = yield* Effect.filter(entries, (entry) =>
          permanentFs(
            Effect.map(
              entryTypeIn(fs, placed(entry)),
              (type) => type !== undefined,
            ),
          ),
        );
        if (collisions.length > 0) {
          const message = `Target already exists: ${collisions.map(placed).join(', ')}`;
          return yield* Effect.fail(new ArxivSourcePermanentError({ message }));
        }
        progressCallback?.('Placing source files...', 80);
        yield* permanentFs(
          Effect.forEach(entries, (e) => fs.rename(staged(e), placed(e)), {
            discard: true,
          }),
        ).pipe(Effect.uninterruptible);
        return;
      }

      // For gzip-compressed single files, decompress first
      let sourceFilePath = downloadedPath;
      if (isGzipOnly) {
        progressCallback?.('Decompressing source file...', 60);
        const decompressedPath = downloadedPath.replace(/\.gz$/, '');
        // Chunk by chunk, never whole; interruption closes gunzip and both handles.
        yield* fs.stream(downloadedPath).pipe(
          NodeStream.pipeThroughDuplex({
            evaluate: () => createGunzip(),
            onError: (cause) =>
              new ArxivSourcePermanentError({
                message: toErrorMessage(cause),
              }),
          }),
          Stream.run(fs.sink(decompressedPath)),
          Effect.catchTag('PlatformError', (error) =>
            Effect.fail(permanentFsError(error)),
          ),
        );
        yield* permanentFs(fs.remove(downloadedPath, { force: true }));
        sourceFilePath = decompressedPath;
      }

      // Rename to main.tex and move to paper root. The facade's `rename`
      // refused to clobber an existing target (its platform provider threw
      // `EEXIST`), while the standard library's `rename` is node's, which
      // overwrites silently — so the refusal is spelled out here. A dangling
      // `main.tex` symlink names an entry too, and must block the rename
      // rather than be replaced by a regular file.
      const targetPath = path.join(paperDirFull, 'main.tex');
      if (sourceFilePath !== targetPath) {
        if ((yield* permanentFs(entryTypeIn(fs, targetPath))) !== undefined) {
          return yield* Effect.fail(
            new ArxivSourcePermanentError({
              message: `Target already exists: ${targetPath}`,
            }),
          );
        }
        yield* permanentFs(fs.rename(sourceFilePath, targetPath));
      }
    },
  );
}

export const ArxivProcessor = new ArxivSourceProcessor();
