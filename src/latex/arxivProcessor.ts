// Standard library imports
import * as path from 'path';
import axios from 'axios';
import { pipeline } from 'node:stream/promises';

// Third-party imports
import * as arxivIdentifiers from 'identifiers-arxiv';
import * as tar from 'tar';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utilities
import { WorkspaceFS, AbsoluteFS } from '@utils/files';
import { indentLatexFilesInDirectory } from '@housekeeping/indent';

export interface ExtractResult {
  success: boolean;
  error?: string;
}

export interface ExtractOptions {
  timeout?: number;
  channel?: string;
}

export class ArxivSourceProcessor {
  constructor(private readonly channel: string = 'arxivProcessor') {
    logger.initialize(this.channel);
  }

  public isValidId(id: string): boolean {
    const extractedIds = arxivIdentifiers.extract(id);
    return extractedIds.length > 0 && extractedIds.includes(id);
  }

  public validateId(id: string): string | null {
    if (!id) {
      return 'arXiv ID is required';
    }

    if (!this.isValidId(id)) {
      return 'Invalid arXiv ID format. Please provide a valid arXiv ID like YYMM.NNNNN, YYMM.NNNNNvN, or category/YYMM.NNNNN';
    }

    return null;
  }

  public async downloadFile(
    url: string,
    destPath: string,
    timeout = 30000,
  ): Promise<void> {
    try {
      const response = await axios.get(url, {
        responseType: 'stream',
        validateStatus: () => true,
        timeout,
      });

      if (response.status === 404) {
        throw new Error('Source not available for this arXiv ID');
      }

      if (response.status !== 200) {
        throw new Error(`Failed to download: HTTP ${response.status}`);
      }

      await pipeline(
        response.data as NodeJS.ReadableStream,
        AbsoluteFS.createWriteStream(destPath),
      );
    } catch (err) {
      try {
        await AbsoluteFS.delete(destPath);
      } catch {
        // ignore errors deleting destPath
      }
      throw err;
    }
  }

  public async extractTarFile(
    tarPath: string,
    destDir: string,
    options: ExtractOptions = {},
  ): Promise<ExtractResult> {
    logger.debug(
      options.channel ?? this.channel,
      `Extracting tar file: ${tarPath} to ${destDir}`,
    );

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
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(
        options.channel ?? this.channel,
        `Failed to extract tar file: ${errorMsg}`,
      );
      return { success: false, error: errorMsg };
    }
  }

  public async downloadSource(
    id: string,
    progressCallback?: (msg: string, increment?: number) => void,
    autoIndent = true,
  ): Promise<string> {
    logger.info(this.channel, `Downloading arXiv source for ID: ${id}`);

    const validationError = this.validateId(id);
    if (validationError) {
      throw new Error(validationError);
    }

    const workspacePath = WorkspaceFS.getPath();
    if (!workspacePath) {
      throw new Error('No workspace folder is open');
    }

    const papersExDir = 'PapersEx';
    if (!(await WorkspaceFS.exists(papersExDir))) {
      await WorkspaceFS.createDir(papersExDir);
    }

    const paperDirRelative = path.join(papersExDir, id.replace(/\//g, '_'));
    if (!(await WorkspaceFS.exists(paperDirRelative))) {
      await WorkspaceFS.createDir(paperDirRelative);
    }

    const paperDirFull = WorkspaceFS.fullPath(paperDirRelative);
    const tarFileName = `${id.replace(/\//g, '_')}.tar.gz`;
    const tarFilePath = path.join(paperDirFull, tarFileName);

    if (progressCallback) {
      progressCallback(`Downloading arXiv source for ${id}...`, 20);
    }

    const downloadUrl = `https://arxiv.org/src/${id}`;
    await this.downloadFile(downloadUrl, tarFilePath);

    if (progressCallback) {
      progressCallback('Extracting source files...', 60);
    }

    const extractResult = await this.extractTarFile(tarFilePath, paperDirFull, {
      timeout: 30000,
    });

    if (!extractResult.success) {
      throw new Error(`Failed to extract arXiv source: ${extractResult.error}`);
    }

    if (progressCallback) {
      progressCallback('Cleaning up...', 80);
    }

    await WorkspaceFS.delete(path.join(paperDirRelative, tarFileName));

    if (autoIndent) {
      if (progressCallback) {
        progressCallback('Formatting LaTeX files...', 85);
      }

      const indentedCount = await indentLatexFilesInDirectory(
        paperDirRelative,
        progressCallback,
      );

      if (progressCallback) {
        progressCallback(`Formatted ${indentedCount} LaTeX files`, 95);
      }
    }

    if (progressCallback) {
      progressCallback('arXiv source downloaded successfully!', 100);
    }

    logger.info(
      this.channel,
      `arXiv source downloaded and extracted to: ${paperDirFull}`,
    );

    return paperDirFull;
  }
}

export const arxivProcessor = new ArxivSourceProcessor();
