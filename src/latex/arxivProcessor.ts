import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

import { parse as parseContentDisposition } from 'content-disposition';
import { StatusCodes } from 'http-status-codes';
import * as arxivIdentifiers from 'identifiers-arxiv';
import pRetry, { AbortError } from 'p-retry';
import pTimeout from 'p-timeout';
import * as tar from 'tar';

import * as logger from '@logger/logUtils';
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
  channel?: string;
}

// AbortSignal.timeout() covers the entire request including body streaming,
// unlike the old axios timeout which only covered header receipt. Use a
// generous deadline so large tarballs (10s+ on a slow link) can complete.
const DOWNLOAD_TIMEOUT_MS = 120_000; // 2 min

export type ArxivDownloadDestination = 'root' | 'references';

export interface DownloadSourceOptions {
  progressCallback?: (msg: string, increment?: number) => void;
  autoIndent?: boolean;
  destination?: ArxivDownloadDestination;
  /** Workspace-relative destination directory. Defaults to References/<id>. */
  into?: string;
}

const INVALID_ARXIV_INPUT_ERROR =
  'Invalid arXiv ID or URL. Please provide a valid arXiv ID (e.g., 2404.12175) or URL (e.g., https://arxiv.org/abs/2404.12175)';

const PDF_ONLY_SUBMISSION_ERROR =
  'This arXiv paper only has a PDF submission — no LaTeX source is available for download';

function normalizeWorkspaceRelativeDirectory(candidate: string): string {
  return candidate
    .trim()
    .replaceAll(path.sep, '/')
    .replaceAll(/^\/+|\/+$/g, '');
}

export function resolveArxivPaperDirectoryRelative(
  id: string,
  options: Pick<DownloadSourceOptions, 'destination' | 'into'> = {},
): string {
  const paperDirName = id.replaceAll('/', '_');
  const customRoot = options.into
    ? normalizeWorkspaceRelativeDirectory(options.into)
    : '';
  if (customRoot) {
    return customRoot === '.' ? paperDirName : `${customRoot}/${paperDirName}`;
  }
  return options.destination === 'root' ? '.' : `References/${paperDirName}`;
}

class ArxivSourceProcessor {
  // NOTE: The channel string stays 'arxivProcessor' (lowercase) even
  // though the exported singleton was renamed to PascalCase in #7347. It is used
  // directly as the logger channel and prefixes every log line as
  // `[arxivProcessor] ...`, so keep it stable for anything filtering on the
  // channel name — a class-identifier rename must not change this value.
  private readonly channel = 'arxivProcessor';

  /** Best-effort delete that logs failures at debug level instead of throwing. */
  private async cleanUpBestEffort(
    target: string,
    description: string,
    options?: { recursive?: boolean },
  ): Promise<void> {
    await AbsoluteFS.delete(target, options).catch((error: unknown) => {
      logger.debug(
        this.channel,
        `Failed to clean up ${description} ${target}`,
        {
          data: error,
        },
      );
    });
  }

  /**
   * Determine file extension from content-type header.
   * Handles tar, gzip, and tex content types.
   * Throws if the response is a PDF (no LaTeX source available) — an
   * `AbortError` so the download retry loop treats it as permanent.
   */
  private getExtensionFromContentType(contentType: string): string {
    if (contentType.includes('pdf')) {
      throw new AbortError(PDF_ONLY_SUBMISSION_ERROR);
    }

    const isTar = contentType.includes('tar');
    const isGzip = contentType.includes('gz');
    const isTex = contentType.includes('tex') || contentType.includes('plain');

    if (isTar && isGzip) return '.tar.gz';
    if (isTar) return '.tar';
    if (isGzip) return '.gz';
    if (isTex) return '.tex';
    return '';
  }

  private isValidId(id: string): boolean {
    return arxivIdentifiers.extract(id).includes(id);
  }

  /**
   * Normalize input that may be a URL or plain ID into a valid arXiv ID.
   * Accepts formats like:
   * - Plain ID: 2404.12175, 2404.12175v2, cs/0501072
   * - URLs: https://arxiv.org/abs/2404.12175, https://arxiv.org/pdf/2404.12175.pdf
   * @returns The normalized arXiv ID, or null if extraction fails
   */
  private normalizeInput(input: string): string | null {
    if (!input) {
      return null;
    }

    const normalized = normaliseArxivIdentifier(input.trim());
    // Verify the normalized result is a valid arXiv ID
    return this.isValidId(normalized) ? normalized : null;
  }

  /** @returns Error message if invalid, null if valid */
  public validateId(input: string): string | null {
    if (!input) return 'arXiv ID or URL is required';
    return this.normalizeInput(input) ? null : INVALID_ARXIV_INPUT_ERROR;
  }

  /** Sanitized directory name for a paper (e.g. `2404.12175` or `cs_0501072`). */
  public getPaperDirName(input: string): string {
    const id = this.normalizeInput(input);
    return id ? id.replaceAll('/', '_') : input;
  }

  /**
   * Download `url` to disk, retrying transient failures — network errors,
   * 408/429, or 5xx (see {@link isTransientHttpStatus}) — with exponential
   * backoff. Permanent failures — other 4xx statuses or a PDF-only
   * submission — abort the retry loop immediately.
   */
  public async downloadFile(
    url: string,
    destBasePath: string,
    timeout = 30000,
  ): Promise<string> {
    return pRetry(() => this.downloadFileOnce(url, destBasePath, timeout), {
      retries: 2,
      minTimeout: 1000,
      // Jitter the backoff so concurrent clients don't retry in lockstep.
      randomize: true,
      onFailedAttempt: ({ error, retriesLeft }) => {
        logger.debug(
          this.channel,
          `Download attempt failed (${retriesLeft} retries left): ${toErrorMessage(error)}`,
        );
      },
    });
  }

  private async downloadFileOnce(
    url: string,
    destBasePath: string,
    timeout: number,
  ): Promise<string> {
    let destPath = destBasePath;
    let shouldCleanup = true;
    try {
      // AbortSignal.timeout covers both connection establishment and body streaming.
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeout),
      });

      if (response.status === StatusCodes.NOT_FOUND) {
        throw new AbortError('Source not available for this arXiv ID');
      }

      if (response.status !== StatusCodes.OK) {
        const message = `Failed to download: HTTP ${response.status}`;
        throw isTransientHttpStatus(response.status)
          ? new Error(message)
          : new AbortError(message);
      }

      // Extract filename from Content-Disposition header if available.
      // Uses content-disposition package for full RFC 6266 / RFC 5987 compliance,
      // which handles both `filename=` and `filename*=UTF-8''...` (percent-encoded
      // Unicode names that the old regex silently dropped).
      const disposition = response.headers.get('content-disposition');
      let filename: string | undefined;
      if (disposition) {
        try {
          filename = parseContentDisposition(disposition).parameters.filename;
        } catch (error) {
          // Malformed header; the content-type fallback below handles it.
          logger.debug(
            this.channel,
            'Ignoring malformed Content-Disposition header from arXiv source download',
            {
              data: {
                header: disposition,
                error: toErrorMessage(error),
              },
            },
          );
        }
      }
      if (filename) {
        // basename prevents path traversal from a crafted header value.
        destPath = path.join(
          path.dirname(destBasePath),
          path.basename(filename),
        );
      } else {
        const contentType = response.headers.get('content-type') ?? '';
        const extension = this.getExtensionFromContentType(contentType);
        destPath = destBasePath + extension;
      }

      if (!response.body) {
        throw new Error('Response has no body');
      }

      await pipeline(
        // response.body is a web ReadableStream; Readable.fromWeb bridges to Node streams.
        Readable.fromWeb(response.body as NodeWebReadableStream),
        AbsoluteFS.createWriteStream(destPath),
      );
      shouldCleanup = false;
      return destPath;
    } finally {
      if (shouldCleanup) {
        // Await so a retry attempt can't race this delete on the same path.
        await this.cleanUpBestEffort(destPath, 'partial download');
      }
    }
  }

  public async extractTarFile(
    tarPath: string,
    destDir: string,
    options: ExtractOptions = {},
  ): Promise<ExtractResult> {
    const channel = options.channel ?? this.channel;
    logger.debug(channel, `Extracting tar file: ${tarPath} to ${destDir}`);

    try {
      const extraction = tar.x({ file: tarPath, cwd: destDir });
      if (options.timeout) {
        await pTimeout(extraction, {
          milliseconds: options.timeout,
          message: 'Extraction timed out',
        });
      } else {
        await extraction;
      }
      return { success: true };
    } catch (err) {
      const errorMsg = toErrorMessage(err);
      logger.error(channel, `Failed to extract tar file: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  }

  public async downloadSource(
    input: string,
    options: DownloadSourceOptions = {},
  ): Promise<{ path: string; alreadyExisted: boolean }> {
    const {
      progressCallback,
      autoIndent = true,
      destination = 'references',
      into,
    } = options;

    // Normalize input (URL or ID) to plain arXiv ID
    const id = this.normalizeInput(input);
    if (!id) {
      throw new Error(INVALID_ARXIV_INPUT_ERROR);
    }

    logger.info(this.channel, `Downloading arXiv source for ID: ${id}`);

    if (!WorkspaceFS.getPath()) {
      throw new Error('No workspace folder is open');
    }

    const paperDirRelative = resolveArxivPaperDirectoryRelative(id, {
      destination,
      into,
    });
    const isRoot = paperDirRelative === '.';
    const paperDirFull = WorkspaceFS.fullPath(paperDirRelative);

    const needsDownload = !(await this.hasExistingSource(
      paperDirRelative,
      isRoot,
      paperDirFull,
    ));
    if (needsDownload) {
      await this.fetchAndPlaceSource(
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

      const indentResult = await indentLatexFilesInDirectory(
        paperDirRelative,
        progressCallback,
      );

      progressCallback?.(`Formatted ${indentResult.count} LaTeX files`, 95);
    }

    progressCallback?.('arXiv source downloaded successfully!', 100);

    logger.info(this.channel, `arXiv source downloaded to: ${paperDirFull}`);

    return { path: paperDirFull, alreadyExisted: !needsDownload };
  }

  /**
   * Whether a previously-downloaded source already exists at the paper directory.
   * Skipped for the workspace root, where stray .tex files would be a false
   * positive.
   */
  private async hasExistingSource(
    paperDirRelative: string,
    isRoot: boolean,
    paperDirFull: string,
  ): Promise<boolean> {
    if (isRoot || !(await WorkspaceFS.exists(paperDirRelative))) {
      return false;
    }
    const entries = await WorkspaceFS.readDir(paperDirRelative);
    const hasTexFiles = entries.some(([name]) => hasExtension(name, '.tex'));
    if (hasTexFiles) {
      logger.info(
        this.channel,
        `arXiv source already exists at: ${paperDirFull}`,
      );
    }
    return hasTexFiles;
  }

  /**
   * Download the arXiv source tarball into a unique staging directory, reject
   * PDF-only submissions, place the source files into the paper root, then
   * remove the staging directory.
   */
  private async fetchAndPlaceSource(
    id: string,
    paperDirRelative: string,
    paperDirFull: string,
    isRoot: boolean,
    progressCallback: DownloadSourceOptions['progressCallback'],
  ): Promise<void> {
    await WorkspaceFS.ensureDir(paperDirRelative);

    // Use a unique staging directory name to avoid clobbering an existing 'download/' folder at root
    const stagingDirName = `.arxiv-download-${id.replaceAll('/', '_')}`;
    const downloadDirRelative = path.join(paperDirRelative, stagingDirName);
    await WorkspaceFS.ensureDir(downloadDirRelative);

    const downloadDirFull = path.join(paperDirFull, stagingDirName);
    const downloadBasePath = path.join(downloadDirFull, 'source');

    progressCallback?.(`Downloading arXiv source for ${id}...`, 20);

    const downloadUrl = `https://arxiv.org/src/${id}`;
    const downloadedPath = await this.downloadFile(
      downloadUrl,
      downloadBasePath,
      DOWNLOAD_TIMEOUT_MS,
    );

    // Detect PDF-only submissions (no LaTeX source available)
    if (hasExtension(downloadedPath, '.pdf')) {
      await AbsoluteFS.delete(downloadedPath);
      await this.cleanUpBestEffort(downloadDirFull, 'download dir', {
        recursive: true,
      });
      // Only clean up the paper directory when it was created for this download
      if (!isRoot) {
        await this.cleanUpBestEffort(paperDirFull, 'paper dir', {
          recursive: true,
        });
      }
      throw new Error(PDF_ONLY_SUBMISSION_ERROR);
    }

    await this.placeSourceFiles(
      downloadedPath,
      paperDirRelative,
      paperDirFull,
      progressCallback,
    );

    // Remove the temporary download directory (files are now in paper root)
    await this.cleanUpBestEffort(downloadDirFull, 'temporary download dir', {
      recursive: true,
    });
  }

  /**
   * Place the downloaded source into the paper directory: extract a tar/tgz
   * archive in place, or decompress (gzip) and rename a single source file to
   * main.tex. Removes the downloaded artifact on success.
   */
  private async placeSourceFiles(
    downloadedPath: string,
    paperDirRelative: string,
    paperDirFull: string,
    progressCallback: DownloadSourceOptions['progressCallback'],
  ): Promise<void> {
    const isArchive =
      hasExtension(downloadedPath, '.tar') ||
      downloadedPath.endsWith('.tar.gz') ||
      hasExtension(downloadedPath, '.tgz');
    const isGzipOnly = !isArchive && hasExtension(downloadedPath, '.gz');

    if (isArchive) {
      progressCallback?.('Extracting source files...', 60);

      const extractResult = await this.extractTarFile(
        downloadedPath,
        paperDirFull,
        { timeout: 30000 },
      );

      if (!extractResult.success) {
        throw new Error(
          `Failed to extract arXiv source: ${extractResult.error}`,
        );
      }

      progressCallback?.('Cleaning up...', 80);

      // Remove the downloaded archive file
      await AbsoluteFS.delete(downloadedPath);
      return;
    }

    // For gzip-compressed single files, decompress first
    let sourceFilePath = downloadedPath;
    if (isGzipOnly) {
      progressCallback?.('Decompressing source file...', 60);
      const decompressedPath = downloadedPath.replace(/\.gz$/, '');
      await pipeline(
        AbsoluteFS.createReadStream(downloadedPath),
        createGunzip(),
        AbsoluteFS.createWriteStream(decompressedPath),
      );
      await AbsoluteFS.delete(downloadedPath);
      sourceFilePath = decompressedPath;
    }

    // Rename to main.tex and move to paper root
    const downloadedRel = WorkspaceFS.relativePath(sourceFilePath);
    // Use forward slashes to match WorkspaceFS.relativePath() convention
    const targetRel = [paperDirRelative, 'main.tex'].join('/');
    if (downloadedRel !== targetRel) {
      await WorkspaceFS.rename(downloadedRel, targetRel);
    }
  }
}

export const ArxivProcessor = new ArxivSourceProcessor();
