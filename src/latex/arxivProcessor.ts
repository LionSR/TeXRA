import * as path from 'node:path';
import { createGunzip } from 'node:zlib';

import * as NodeStream from '@effect/platform-node/NodeStream';
import { parse as parseContentDisposition } from 'content-disposition';
import {
  Cause,
  Data,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  PlatformError,
  Schedule,
  Stream,
} from 'effect';
import { Headers, HttpClient } from 'effect/unstable/http';
import { StatusCodes } from 'http-status-codes';
import * as tar from 'tar';

import { withLogChannel } from '@logger/effectLog';
import { randomizedExponentialBackoff } from '@utils/core/backoffSchedule';
import { isTransientHttpStatus } from '@utils/core/httpStatus';
import { readDirectoryTypedTolerant } from '@utils/files/fsDurability';
import { entryExists } from '@utils/files/fsEntryExists';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { hasExtension } from '@utils/core/pathCore';
import { normaliseArxivIdentifier } from './arxivIdentifier';
import { indentLatexFilesInDirectory } from './formatter/indentDirectory';
import type { LatexFormatter } from './formatter/texFormatter';

interface ExtractResult {
  success: boolean;
  error?: string;
}

interface ExtractOptions {
  timeout?: number;
}

// Cover the entire request, including body streaming, while allowing large
// tarballs to complete on a slow link.
const DOWNLOAD_TIMEOUT_MS = 120_000; // 2 min

/** Retries after the first download attempt. */
const DOWNLOAD_RETRIES = 2;

/**
 * A source-download failure that ends the retry loop immediately — a PDF-only
 * submission, a 404, or another non-transient HTTP status, the failures the
 * old p-retry `AbortError` marked permanent. `downloadSource` also fails with
 * it for the non-download errors (invalid input, no open workspace,
 * extraction or placement failure), which never had a retry loop to abort.
 */
class ArxivSourcePermanentError extends Data.TaggedError(
  'ArxivSourcePermanentError',
)<{ readonly message: string }> {}

/**
 * A failed download attempt worth retrying: a network-level failure, the
 * per-attempt deadline, or a transient HTTP status (408/429/5xx, see
 * {@link isTransientHttpStatus}). Once the retries are exhausted it is the
 * program's failure.
 */
class ArxivSourceTransientError extends Data.TaggedError(
  'ArxivSourceTransientError',
)<{ readonly message: string; readonly cause: unknown }> {}

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

/**
 * Abort foreign stream work on interruption, then join its actual promise.
 * Join outside the timeout race so a late rejection remains observable.
 */
function joinedStream<T, A, E>(
  start: (signal: AbortSignal) => Promise<T>,
  onError: (error: unknown) => Effect.Effect<A, E>,
  timeout?: number,
): Effect.Effect<T | A, E> {
  return Effect.suspend(() => {
    let pending: Promise<T> | undefined;
    let signal: AbortSignal | undefined;
    let primary: { error: unknown } | undefined;
    const operation = Effect.tryPromise({
      try: (requestSignal) => {
        signal = requestSignal;
        pending = start(requestSignal);
        return pending;
      },
      catch: (error) => error,
    });
    return (
      timeout == null
        ? operation
        : operation.pipe(Effect.timeout(Duration.millis(timeout)))
    ).pipe(
      Effect.catch((error) => {
        primary = { error };
        return onError(error);
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
                // A distinct late stream failure must survive interruption.
                throw error;
              },
            ) ?? Promise.resolve(),
        ),
      ),
    );
  });
}

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

/**
 * Normalize input that may be a URL or plain ID into a valid arXiv ID.
 * Accepts formats like:
 * - Plain ID: 2404.12175, 2404.12175v2, cs/0501072
 * - URLs: https://arxiv.org/abs/2404.12175, https://arxiv.org/pdf/2404.12175.pdf
 * @returns The normalized arXiv ID, or null if extraction fails
 */
function normalizeArxivInput(input: string): string | null {
  return normaliseArxivIdentifier(input.trim());
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
    return normalizeArxivInput(input) ? null : INVALID_ARXIV_INPUT_ERROR;
  }

  /** Sanitized directory name for a paper (e.g. `2404.12175` or `cs_0501072`). */
  public getPaperDirName(input: string): string {
    const id = normalizeArxivInput(input);
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

  public extractTarFile(
    tarPath: string,
    destDir: string,
    options: ExtractOptions = {},
  ): Effect.Effect<ExtractResult> {
    return Effect.gen(function* () {
      yield* Effect.logDebug(`Extracting tar file: ${tarPath} to ${destDir}`);
      const result = yield* joinedStream(
        (signal) =>
          // tar has no abort option. Stop admitting entries and join its
          // public promise. This is unbounded; rejection need not mean all
          // writes closed.
          tar.x({ file: tarPath, cwd: destDir, filter: () => !signal.aborted }),
        (cause) =>
          Effect.suspend((): Effect.Effect<ExtractResult> => {
            const error = Cause.isTimeoutError(cause)
              ? 'Extraction timed out'
              : toErrorMessage(cause);
            return Effect.logError(`Failed to extract tar file: ${error}`).pipe(
              Effect.as({ success: false, error }),
            );
          }),
        options.timeout,
      );
      return result ?? { success: true };
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
      const id = normalizeArxivInput(input);
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
      const paperDirRelative =
        destination === 'root' ? '.' : `References/${id.replaceAll('/', '_')}`;
      const isRoot = paperDirRelative === '.';
      const paperDirFull = path.join(workspaceRoot, paperDirRelative);

      const needsDownload = !(yield* this.hasExistingSource(
        isRoot,
        paperDirFull,
      ));
      if (needsDownload) {
        // `Effect.scoped` closes the staging directory's finalizer here, on
        // success, failure and interruption alike.
        yield* Effect.scoped(
          this.fetchAndPlaceSource(id, paperDirFull, isRoot, progressCallback),
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

        progressCallback?.(`Formatted ${indentResult.count} LaTeX files`, 95);
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
      if (!(yield* permanentFs(entryExists(fs, paperDirFull)))) {
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
   * Download the arXiv source tarball into a unique staging directory, reject
   * PDF-only submissions, and place the source files into the paper root. The
   * staging directory, and a paper directory this call created but did not
   * finish, are removed by scope finalizers, so the caller must run this
   * inside `Effect.scoped`.
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
      // A paper directory this download creates is its own until the source is
      // fully placed. Any other exit -- a PDF-only submission, a failed
      // extraction, or Cancel mid-extraction -- removes it, because tar writes
      // straight into it and a partial tree holding one `.tex` would pass
      // `hasExistingSource` on the next Download. A directory that was already
      // there, and the workspace root, belong to the user and stay.
      const ownsPaperDir =
        !isRoot && !(yield* permanentFs(entryExists(fs, paperDirFull)));
      yield* permanentFs(fs.makeDirectory(paperDirFull, { recursive: true }));
      yield* Effect.addFinalizer((exit) =>
        ownsPaperDir && !Exit.isSuccess(exit)
          ? this.cleanUpBestEffort(paperDirFull, 'paper dir', {
              recursive: true,
            })
          : Effect.void,
      );

      // Use a unique staging directory name to avoid clobbering an existing 'download/' folder at root
      const stagingDirName = `.arxiv-download-${id.replaceAll('/', '_')}`;
      const downloadDirFull = path.join(paperDirFull, stagingDirName);
      yield* permanentFs(
        fs.makeDirectory(downloadDirFull, { recursive: true }),
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
        const extractResult = yield* this.extractTarFile(
          downloadedPath,
          extractedDir,
          { timeout: 30000 },
        );
        if (!extractResult.success) {
          return yield* Effect.fail(
            new ArxivSourcePermanentError({
              message: `Failed to extract arXiv source: ${extractResult.error}`,
            }),
          );
        }
        const entries = yield* permanentFs(fs.readDirectory(extractedDir));
        const collisions = yield* Effect.filter(entries, (entry) =>
          permanentFs(entryExists(fs, placed(entry))),
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
        if (yield* permanentFs(entryExists(fs, targetPath))) {
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
