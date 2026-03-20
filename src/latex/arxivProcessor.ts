import * as path from 'path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

import axios from 'axios';
import { StatusCodes } from 'http-status-codes';
import * as arxivIdentifiers from 'identifiers-arxiv';
import * as tar from 'tar';

import { toErrorMessage } from '@common/errors';
import { indentLatexFilesInDirectory } from '@housekeeping/indent';
import * as logger from '@logger/logUtils';
import { normaliseArxivIdentifier } from '@tools/latex/arxivShared';
import { WorkspaceFS, AbsoluteFS } from '@utils/files';

export interface ExtractResult {
  success: boolean;
  error?: string;
}

export interface ExtractOptions {
  timeout?: number;
  channel?: string;
}

const INVALID_ARXIV_INPUT_ERROR =
  'Invalid arXiv ID or URL. Please provide a valid arXiv ID (e.g., 2404.12175) or URL (e.g., https://arxiv.org/abs/2404.12175)';

export class ArxivSourceProcessor {
  constructor(private readonly channel: string = 'arxivProcessor') {
    logger.initialize(this.channel);
  }

  /**
   * Determine file extension from content-type header.
   * Handles tar, gzip, and tex content types.
   * Throws if the response is a PDF (no LaTeX source available).
   */
  private getExtensionFromContentType(contentType: string): string {
    if (contentType.includes('pdf')) {
      throw new Error(
        'This arXiv paper only has a PDF submission — no LaTeX source is available for download',
      );
    }

    const isTar = contentType.includes('tar');
    const isGzip = contentType.includes('gzip') || contentType.includes('gz');
    const isTex = contentType.includes('tex') || contentType.includes('plain');

    if (isTar && isGzip) return '.tar.gz';
    if (isTar) return '.tar';
    if (isGzip) return '.gz';
    if (isTex) return '.tex';
    return '';
  }

  public isValidId(id: string): boolean {
    return arxivIdentifiers.extract(id).includes(id);
  }

  /**
   * Normalize input that may be a URL or plain ID into a valid arXiv ID.
   * Accepts formats like:
   * - Plain ID: 2404.12175, 2404.12175v2, cs/0501072
   * - URLs: https://arxiv.org/abs/2404.12175, https://arxiv.org/pdf/2404.12175.pdf
   * @returns The normalized arXiv ID, or null if extraction fails
   */
  public normalizeInput(input: string): string | null {
    if (!input) {
      return null;
    }

    const normalized = normaliseArxivIdentifier(input.trim());
    // Verify the normalized result is a valid arXiv ID
    return this.isValidId(normalized) ? normalized : null;
  }

  /**
   * Validate input that may be a URL or plain arXiv ID.
   * @returns Error message if invalid, null if valid
   */
  public validateId(input: string): string | null {
    if (!input) {
      return 'arXiv ID or URL is required';
    }

    const normalized = this.normalizeInput(input);
    if (!normalized) {
      return INVALID_ARXIV_INPUT_ERROR;
    }

    return null;
  }

  public async downloadFile(
    url: string,
    destBasePath: string,
    timeout = 30000,
  ): Promise<string> {
    let destPath = destBasePath;
    let shouldCleanup = true;
    try {
      const response = await axios.get(url, {
        responseType: 'stream',
        validateStatus: () => true,
        timeout,
      });

      if (response.status === StatusCodes.NOT_FOUND) {
        throw new Error('Source not available for this arXiv ID');
      }

      if (response.status !== StatusCodes.OK) {
        throw new Error(`Failed to download: HTTP ${response.status}`);
      }

      // Extract filename from Content-Disposition header if available
      const disposition = response.headers['content-disposition'];
      if (disposition) {
        const match = /filename="?([^";]+)"?/i.exec(disposition);
        if (match) {
          // Place file in download directory using basename to prevent path traversal
          destPath = path.join(
            path.dirname(destBasePath),
            path.basename(match[1]),
          );
        }
      } else {
        const contentType = response.headers['content-type'] ?? '';
        const extension = this.getExtensionFromContentType(contentType);
        destPath = destBasePath + extension;
      }

      await pipeline(
        response.data as NodeJS.ReadableStream,
        AbsoluteFS.createWriteStream(destPath),
      );
      shouldCleanup = false;
      return destPath;
    } finally {
      if (shouldCleanup) {
        void AbsoluteFS.delete(destPath).catch(() => undefined);
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
        await Promise.race([
          extraction,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('Extraction timed out')),
              options.timeout,
            ),
          ),
        ]);
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
    progressCallback?: (msg: string, increment?: number) => void,
    autoIndent = true,
  ): Promise<{ path: string; alreadyExisted: boolean }> {
    // Normalize input (URL or ID) to plain arXiv ID
    const id = this.normalizeInput(input);
    if (!id) {
      throw new Error(INVALID_ARXIV_INPUT_ERROR);
    }

    logger.info(this.channel, `Downloading arXiv source for ID: ${id}`);

    const workspacePath = WorkspaceFS.getPath();
    if (!workspacePath) {
      throw new Error('No workspace folder is open');
    }

    // Create project directory for the arXiv paper inside Papers/ (sanitize ID to avoid path issues)
    const paperDirRelative = path.join('Papers', id.replaceAll('/', '_'));
    const paperDirFull = WorkspaceFS.fullPath(paperDirRelative);

    // Check if source was already downloaded successfully.
    // A .tex file in the paper directory is a reliable signal that extraction completed,
    // regardless of whether the staging 'download' dir was cleaned up afterwards.
    let needsDownload = true;
    if (await WorkspaceFS.exists(paperDirRelative)) {
      const entries = await WorkspaceFS.readDir(paperDirRelative);
      const hasTexFiles = entries.some(([name]) => name.endsWith('.tex'));
      if (hasTexFiles) {
        needsDownload = false;
        logger.info(
          this.channel,
          `arXiv source already exists at: ${paperDirFull}`,
        );
      }
    }

    if (needsDownload) {
      await WorkspaceFS.ensureDir(paperDirRelative);

      // Create temporary download subdirectory for staging the archive
      const downloadDirRelative = path.join(paperDirRelative, 'download');
      await WorkspaceFS.ensureDir(downloadDirRelative);

      const downloadDirFull = path.join(paperDirFull, 'download');
      const downloadBasePath = path.join(downloadDirFull, 'source');

      progressCallback?.(`Downloading arXiv source for ${id}...`, 20);

      const downloadUrl = `https://arxiv.org/src/${id}`;
      const downloadedPath = await this.downloadFile(
        downloadUrl,
        downloadBasePath,
      );

      // Detect PDF-only submissions (no LaTeX source available)
      if (downloadedPath.endsWith('.pdf')) {
        await AbsoluteFS.delete(downloadedPath);
        await AbsoluteFS.delete(downloadDirFull, { recursive: true }).catch(
          () => undefined,
        );
        await AbsoluteFS.delete(paperDirFull, { recursive: true }).catch(
          () => undefined,
        );
        throw new Error(
          'This arXiv paper only has a PDF submission — no LaTeX source is available for download',
        );
      }

      const isArchive =
        downloadedPath.endsWith('.tar') ||
        downloadedPath.endsWith('.tar.gz') ||
        downloadedPath.endsWith('.tgz');

      // Detect gzip-compressed single files (.gz but not .tar.gz/.tgz)
      const isGzipOnly = !isArchive && downloadedPath.endsWith('.gz');

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
      } else {
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

      // Remove the temporary download directory (files are now in paper root)
      await AbsoluteFS.delete(downloadDirFull, { recursive: true }).catch(
        () => undefined,
      );
    }

    if (autoIndent) {
      progressCallback?.('Formatting LaTeX files...', 85);

      const indentedCount = await indentLatexFilesInDirectory(
        paperDirRelative,
        progressCallback,
      );

      progressCallback?.(`Formatted ${indentedCount} LaTeX files`, 95);
    }

    progressCallback?.('arXiv source downloaded successfully!', 100);

    logger.info(this.channel, `arXiv source downloaded to: ${paperDirFull}`);

    return { path: paperDirFull, alreadyExisted: !needsDownload };
  }
}

export const arxivProcessor = new ArxivSourceProcessor();
