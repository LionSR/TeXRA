import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

import { parse as parseContentDisposition } from 'content-disposition';
import { Data, Duration, Effect, Random, Schedule } from 'effect';
import { StatusCodes } from 'http-status-codes';
import * as tar from 'tar';

import { createLog } from '@logger/logUtils';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { isTransientHttpStatus } from '@utils/core/httpStatus';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { hasExtension } from '@utils/core/pathCore';
import { normaliseArxivIdentifier } from './arxivIdentifier';
import { indentLatexFilesInDirectory } from './formatter/indentDirectory';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';

interface ExtractResult {
  success: boolean;
  error?: string;
}

interface ExtractOptions {
  timeout?: number;
}

// The per-attempt deadline covers the entire request including body
// streaming, unlike the old axios timeout which only covered header receipt.
// Use a generous deadline so large tarballs (10s+ on a slow link) can
// complete.
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

/**
 * Backoff before retry `n` (1-based): 1 s doubling, scaled by a uniform
 * factor in [1, 2) so concurrent clients don't retry in lockstep — the window
 * the download had under p-retry's `minTimeout: 1000, randomize: true`, the
 * same tuning the tool fetch retry in `@tools/timeouts` uses.
 */
const downloadBackoff = Schedule.exponential(Duration.seconds(1)).pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.map(Random.next, (random) =>
      Duration.millis(Duration.toMillis(duration) * (1 + random)),
    ),
  ),
);

/**
 * Wrap a foreign Promise edge (filesystem, tar, the formatter) as a permanent
 * failure: only the download attempt itself is retried, so nothing else has a
 * retry loop to abort.
 */
const permanent = <T>(
  run: () => Promise<T>,
): Effect.Effect<T, ArxivSourcePermanentError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new ArxivSourcePermanentError({ message: toErrorMessage(cause) }),
  });

export type ArxivDownloadDestination = 'root' | 'references';

export interface DownloadSourceOptions {
  progressCallback?: (msg: string, increment?: number) => void;
  autoIndent?: boolean;
  destination?: ArxivDownloadDestination;
}

const INVALID_ARXIV_INPUT_ERROR =
  'Invalid arXiv ID or URL. Please provide a valid arXiv ID (e.g., 2404.12175) or URL (e.g., https://arxiv.org/abs/2404.12175)';

const PDF_ONLY_SUBMISSION_ERROR =
  'This arXiv paper only has a PDF submission — no LaTeX source is available for download';

export function resolveArxivPaperDirectoryRelative(
  id: string,
  options: Pick<DownloadSourceOptions, 'destination'> = {},
): string {
  const paperDirName = id.replaceAll('/', '_');
  return options.destination === 'root' ? '.' : `References/${paperDirName}`;
}

/**
 * Normalize input that may be a URL or plain ID into a valid arXiv ID.
 * Accepts formats like:
 * - Plain ID: 2404.12175, 2404.12175v2, cs/0501072
 * - URLs: https://arxiv.org/abs/2404.12175, https://arxiv.org/pdf/2404.12175.pdf
 * @returns The normalized arXiv ID, or null if extraction fails
 */
function normalizeArxivInput(input: string): string | null {
  if (!input) {
    return null;
  }

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

class ArxivSourceProcessor {
  // NOTE: The channel string stays 'arxivProcessor' (lowercase) even
  // though the exported singleton was renamed to PascalCase in #7347. It is used
  // directly as the logger channel and prefixes every log line as
  // `[arxivProcessor] ...`, so keep it stable for anything filtering on the
  // channel name — a class-identifier rename must not change this value.
  private readonly channel = 'arxivProcessor';
  private readonly log = createLog(this.channel);

  /** Best-effort delete that logs failures at debug level instead of failing. */
  private cleanUpBestEffort(
    target: string,
    description: string,
    options?: { recursive?: boolean },
  ): Effect.Effect<void> {
    return Effect.tryPromise({
      try: () => AbsoluteFS.delete(target, options),
      catch: (error) => error,
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          this.log.debug(`Failed to clean up ${description} ${target}`, {
            data: error,
          });
        }),
      ),
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
  ): Effect.Effect<string, ArxivSourceError> {
    const log = this.log;
    return this.downloadFileOnce(url, destBasePath).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(timeout),
        orElse: () =>
          Effect.fail(
            new ArxivSourceTransientError({
              message: `Download timed out after ${timeout} ms`,
              cause: undefined,
            }),
          ),
      }),
      Effect.tapError((error) =>
        Effect.gen(function* () {
          // A permanent failure ends the retry unobserved, since it never had
          // retries left to report.
          if (error._tag !== 'ArxivSourceTransientError') return;
          const { attempt } = yield* Schedule.CurrentMetadata;
          log.debug(
            `Download attempt failed (${DOWNLOAD_RETRIES - attempt} retries left): ${error.message}`,
          );
        }),
      ),
      Effect.retry({
        schedule: downloadBackoff,
        times: DOWNLOAD_RETRIES,
        while: (error) => error._tag === 'ArxivSourceTransientError',
      }),
    );
  }

  private downloadFileOnce(
    url: string,
    destBasePath: string,
  ): Effect.Effect<string, ArxivSourceError> {
    const log = this.log;
    let destPath = destBasePath;
    return Effect.gen(function* () {
      // The fiber's own signal aborts the in-flight fetch when the attempt is
      // interrupted — by the per-attempt deadline in downloadFile or by the
      // caller — covering connection establishment and body streaming.
      const response = yield* Effect.tryPromise({
        try: (signal) => fetch(url, { signal }),
        catch: (cause) =>
          new ArxivSourceTransientError({
            message: toErrorMessage(cause),
            cause,
          }),
      });

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
      const disposition = response.headers.get('content-disposition');
      let filename: string | undefined;
      if (disposition) {
        filename = yield* Effect.try({
          try: () => parseContentDisposition(disposition).parameters.filename,
          catch: (error) => error,
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              // Malformed header; the content-type fallback below handles it.
              log.debug(
                'Ignoring malformed Content-Disposition header from arXiv source download',
                {
                  data: {
                    header: disposition,
                    error: toErrorMessage(error),
                  },
                },
              );
              return undefined;
            }),
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
        const contentType = response.headers.get('content-type') ?? '';
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

      if (!response.body) {
        return yield* Effect.fail(
          new ArxivSourceTransientError({
            message: 'Response has no body',
            cause: undefined,
          }),
        );
      }

      yield* Effect.tryPromise({
        try: () =>
          pipeline(
            // response.body is a web ReadableStream; Readable.fromWeb bridges to Node streams.
            Readable.fromWeb(response.body as NodeWebReadableStream),
            AbsoluteFS.createWriteStream(destPath),
          ),
        catch: (cause) =>
          new ArxivSourceTransientError({
            message: toErrorMessage(cause),
            cause,
          }),
      });
      return destPath;
    }).pipe(
      // A failed attempt deletes its partial download so a retry cannot race
      // stale bytes at the same path (the old `finally` + shouldCleanup flag;
      // `onError`'s cleanup is uninterruptible).
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
    const log = this.log;
    log.debug(`Extracting tar file: ${tarPath} to ${destDir}`);

    return Effect.tryPromise({
      try: () => tar.x({ file: tarPath, cwd: destDir }),
      catch: toErrorMessage,
    }).pipe(
      options.timeout == null
        ? (effect) => effect
        : Effect.timeoutOrElse({
            duration: Duration.millis(options.timeout),
            orElse: () => Effect.fail('Extraction timed out'),
          }),
      Effect.as({ success: true }),
      Effect.catch((errorMsg) =>
        Effect.sync((): ExtractResult => {
          log.error(`Failed to extract tar file: ${errorMsg}`);
          return { success: false, error: errorMsg };
        }),
      ),
    );
  }

  public readonly downloadSource = Effect.fn('arxivProcessor.downloadSource')(
    { self: this },
    function* (
      this: ArxivSourceProcessor,
      input: string,
      options: DownloadSourceOptions = {},
    ) {
      const {
        progressCallback,
        autoIndent = true,
        destination = 'references',
      } = options;
      const log = this.log;
      // Normalize input (URL or ID) to plain arXiv ID
      const id = normalizeArxivInput(input);
      if (!id) {
        return yield* Effect.fail(
          new ArxivSourcePermanentError({ message: INVALID_ARXIV_INPUT_ERROR }),
        );
      }

      log.info(`Downloading arXiv source for ID: ${id}`);

      if (!WorkspaceFS.getPath()) {
        return yield* Effect.fail(
          new ArxivSourcePermanentError({
            message: 'No workspace folder is open',
          }),
        );
      }

      const paperDirRelative = resolveArxivPaperDirectoryRelative(id, {
        destination,
      });
      const isRoot = paperDirRelative === '.';
      const paperDirFull = WorkspaceFS.fullPath(paperDirRelative);

      const needsDownload = !(yield* this.hasExistingSource(
        paperDirRelative,
        isRoot,
        paperDirFull,
      ));
      if (needsDownload) {
        yield* this.fetchAndPlaceSource(
          id,
          paperDirRelative,
          paperDirFull,
          isRoot,
          progressCallback,
        );
      }

      // Skip auto-indent for root destination to avoid reformatting existing workspace files
      if (autoIndent && !isRoot) {
        progressCallback?.('Formatting LaTeX files...', 85);

        const indentResult = yield* permanent(() =>
          indentLatexFilesInDirectory(paperDirRelative, progressCallback),
        );

        progressCallback?.(`Formatted ${indentResult.count} LaTeX files`, 95);
      }

      progressCallback?.('arXiv source downloaded successfully!', 100);

      log.info(`arXiv source downloaded to: ${paperDirFull}`);

      return { path: paperDirFull, alreadyExisted: !needsDownload };
    },
  );

  /**
   * Whether a previously-downloaded source already exists at the paper directory.
   * Skipped for the workspace root, where stray .tex files would be a false
   * positive.
   */
  private hasExistingSource(
    paperDirRelative: string,
    isRoot: boolean,
    paperDirFull: string,
  ): Effect.Effect<boolean, ArxivSourceError> {
    const log = this.log;
    return Effect.gen(function* () {
      if (isRoot) {
        return false;
      }
      if (!(yield* permanent(() => WorkspaceFS.exists(paperDirRelative)))) {
        return false;
      }
      const entries = yield* permanent(() =>
        WorkspaceFS.readDir(paperDirRelative),
      );
      const hasTexFiles = entries.some(([name]) => hasExtension(name, '.tex'));
      if (hasTexFiles) {
        log.info(`arXiv source already exists at: ${paperDirFull}`);
      }
      return hasTexFiles;
    });
  }

  /**
   * Download the arXiv source tarball into a unique staging directory, reject
   * PDF-only submissions, place the source files into the paper root, then
   * remove the staging directory.
   */
  private readonly fetchAndPlaceSource = Effect.fn(
    'arxivProcessor.fetchAndPlaceSource',
  )(
    { self: this },
    function* (
      this: ArxivSourceProcessor,
      id: string,
      paperDirRelative: string,
      paperDirFull: string,
      isRoot: boolean,
      progressCallback: DownloadSourceOptions['progressCallback'],
    ) {
      yield* permanent(() => WorkspaceFS.ensureDir(paperDirRelative));

      // Use a unique staging directory name to avoid clobbering an existing 'download/' folder at root
      const stagingDirName = `.arxiv-download-${id.replaceAll('/', '_')}`;
      const downloadDirRelative = path.join(paperDirRelative, stagingDirName);
      yield* permanent(() => WorkspaceFS.ensureDir(downloadDirRelative));

      const downloadDirFull = path.join(paperDirFull, stagingDirName);
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
        yield* permanent(() => AbsoluteFS.delete(downloadedPath));
        yield* this.cleanUpBestEffort(downloadDirFull, 'download dir', {
          recursive: true,
        });
        // Only clean up the paper directory when it was created for this download
        if (!isRoot) {
          yield* this.cleanUpBestEffort(paperDirFull, 'paper dir', {
            recursive: true,
          });
        }
        return yield* Effect.fail(
          new ArxivSourcePermanentError({ message: PDF_ONLY_SUBMISSION_ERROR }),
        );
      }

      yield* this.placeSourceFiles(
        downloadedPath,
        paperDirRelative,
        paperDirFull,
        progressCallback,
      );

      // Remove the temporary download directory (files are now in paper root)
      yield* this.cleanUpBestEffort(downloadDirFull, 'temporary download dir', {
        recursive: true,
      });
    },
  );

  /**
   * Place the downloaded source into the paper directory: extract a tar/tgz
   * archive in place, or decompress (gzip) and rename a single source file to
   * main.tex. Removes the downloaded artifact on success.
   */
  private readonly placeSourceFiles = Effect.fn(
    'arxivProcessor.placeSourceFiles',
  )(
    { self: this },
    function* (
      this: ArxivSourceProcessor,
      downloadedPath: string,
      paperDirRelative: string,
      paperDirFull: string,
      progressCallback: DownloadSourceOptions['progressCallback'],
    ) {
      const isArchive =
        hasExtension(downloadedPath, '.tar') ||
        downloadedPath.endsWith('.tar.gz') ||
        hasExtension(downloadedPath, '.tgz');
      const isGzipOnly = !isArchive && hasExtension(downloadedPath, '.gz');

      if (isArchive) {
        progressCallback?.('Extracting source files...', 60);

        const extractResult = yield* this.extractTarFile(
          downloadedPath,
          paperDirFull,
          { timeout: 30000 },
        );

        if (!extractResult.success) {
          return yield* Effect.fail(
            new ArxivSourcePermanentError({
              message: `Failed to extract arXiv source: ${extractResult.error}`,
            }),
          );
        }

        progressCallback?.('Cleaning up...', 80);

        // Remove the downloaded archive file
        yield* permanent(() => AbsoluteFS.delete(downloadedPath));
        return;
      }

      // For gzip-compressed single files, decompress first
      let sourceFilePath = downloadedPath;
      if (isGzipOnly) {
        progressCallback?.('Decompressing source file...', 60);
        const decompressedPath = downloadedPath.replace(/\.gz$/, '');
        yield* permanent(() =>
          pipeline(
            AbsoluteFS.createReadStream(downloadedPath),
            createGunzip(),
            AbsoluteFS.createWriteStream(decompressedPath),
          ),
        );
        yield* permanent(() => AbsoluteFS.delete(downloadedPath));
        sourceFilePath = decompressedPath;
      }

      // Rename to main.tex and move to paper root
      const downloadedRel = WorkspaceFS.relativePath(sourceFilePath);
      // Use forward slashes to match WorkspaceFS.relativePath() convention
      const targetRel = [paperDirRelative, 'main.tex'].join('/');
      if (downloadedRel !== targetRel) {
        yield* permanent(() => WorkspaceFS.rename(downloadedRel, targetRel));
      }
    },
  );
}

export const ArxivProcessor = new ArxivSourceProcessor();
