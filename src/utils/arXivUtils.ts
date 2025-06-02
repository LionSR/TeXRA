import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
// Import the identifiers-arxiv package
import * as arxivIdentifiers from 'identifiers-arxiv';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utils
import {
  getWorkspacePath,
  getFullPathFromWorkspace,
  createDirectory,
  deleteFile,
  fileExists,
} from './workspaceFileUtils';
import { executeCommand } from './execUtils';
import { indentLatexFilesInDirectory } from '../housekeeping/indent';

const CHANNEL = 'arXivUtils';

/**
 * Validates if the given string is a valid arXiv ID
 * @param arxivId The arXiv ID to validate
 * @returns True if the ID is valid, false otherwise
 */
export function isValidArxivId(arxivId: string): boolean {
  // Use the identifiers-arxiv package for better validation
  // extract() returns an array of valid IDs, so if the result contains our ID, it's valid
  const extractedIds = arxivIdentifiers.extract(arxivId);
  return extractedIds.length > 0 && extractedIds.includes(arxivId);
}

/**
 * Validates an arXiv ID and returns an error message if invalid
 * @param arxivId The arXiv ID to validate
 * @returns Error message if invalid, null if valid
 */
export function validateArxivId(arxivId: string): string | null {
  if (!arxivId) {
    return 'arXiv ID is required';
  }

  if (!isValidArxivId(arxivId)) {
    return 'Invalid arXiv ID format. Please provide a valid arXiv ID like YYMM.NNNNN, YYMM.NNNNNvN, or category/YYMM.NNNNN';
  }

  return null;
}

/**
 * Downloads a file from a URL to a local file path
 * @param url The URL to download from
 * @param destPath The local file path to save to
 * @returns A promise that resolves when the download is complete
 */
export function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);

    https
      .get(url, (response) => {
        if (response.statusCode === 404) {
          reject(new Error('Source not available for this arXiv ID'));
          return;
        }

        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download: HTTP ${response.statusCode}`));
          return;
        }

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          resolve();
        });
      })
      .on('error', (err) => {
        fs.unlink(destPath, () => {}); // Delete the file if there was an error
        reject(err);
      });
  });
}

/**
 * Result interface for tar extraction
 */
interface ExtractResult {
  success: boolean;
  error?: string;
}

/**
 * Options for tar extraction
 */
interface ExtractOptions {
  timeout?: number;
  channel?: string;
}

/**
 * Extracts a tar file to a destination directory
 * @param tarPath The path to the tar file
 * @param destDir The directory to extract to
 * @param options Additional options for extraction
 * @returns A promise that resolves with the extraction result
 */
export async function extractTarFile(
  tarPath: string,
  destDir: string,
  options: ExtractOptions = {},
): Promise<ExtractResult> {
  logger.debug(
    options.channel ?? CHANNEL,
    `Extracting tar file: ${tarPath} to ${destDir}`,
  );

  // Build the command
  const tarCommand = `tar -xf "${tarPath}" -C "${destDir}"`;

  // Use executeCommand from execUtils
  const result = await executeCommand(tarCommand, {
    channel: options.channel ?? CHANNEL,
    timeout: options.timeout,
    truncate: true,
  });

  if (!result.success) {
    logger.error(
      options.channel ?? CHANNEL,
      `Failed to extract tar file: ${result.stderr}`,
    );
    return {
      success: false,
      error: result.stderr || 'Unknown error during extraction',
    };
  }

  return { success: true };
}

/**
 * Downloads and extracts an arXiv source file
 * @param arxivId The arXiv ID
 * @param progressCallback Optional callback for progress updates
 * @param autoIndent Whether to automatically indent LaTeX files after extraction
 * @returns A promise that resolves to the path where the source was extracted
 */
export async function downloadArxivSource(
  arxivId: string,
  progressCallback?: (message: string, increment?: number) => void,
  autoIndent = true,
): Promise<string> {
  logger.info(CHANNEL, `Downloading arXiv source for ID: ${arxivId}`);

  // Validate arXiv ID
  const validationError = validateArxivId(arxivId);
  if (validationError) {
    throw new Error(validationError);
  }

  // Get workspace path
  const workspacePath = getWorkspacePath();
  if (!workspacePath) {
    throw new Error('No workspace folder is open');
  }

  // Create PapersEx directory if it doesn't exist
  const papersExDir = 'PapersEx';
  if (!(await fileExists(papersExDir))) {
    await createDirectory(papersExDir);
  }

  // Create a specific directory for this paper
  const paperDirRelative = path.join(papersExDir, arxivId.replace(/\//g, '_'));
  if (!(await fileExists(paperDirRelative))) {
    await createDirectory(paperDirRelative);
  }

  // Get the full paths for operations that need them
  const paperDirFull = getFullPathFromWorkspace(paperDirRelative);
  const tarFileName = `${arxivId.replace(/\//g, '_')}.tar.gz`;
  const tarFilePath = path.join(paperDirFull, tarFileName);

  // Download the tar file
  if (progressCallback) {
    progressCallback(`Downloading arXiv source for ${arxivId}...`, 20);
  }

  const downloadUrl = `https://arxiv.org/src/${arxivId}`;
  await downloadFile(downloadUrl, tarFilePath);

  if (progressCallback) {
    progressCallback(`Extracting source files...`, 60);
  }

  // Extract the tar file using the improved function
  const extractResult = await extractTarFile(tarFilePath, paperDirFull, {
    timeout: 30000, // 30 seconds timeout
  });

  if (!extractResult.success) {
    throw new Error(`Failed to extract arXiv source: ${extractResult.error}`);
  }

  if (progressCallback) {
    progressCallback(`Cleaning up...`, 80);
  }

  // Clean up the tar file
  await deleteFile(path.join(paperDirRelative, tarFileName));

  // Indent LaTeX files if autoIndent is enabled
  if (autoIndent) {
    if (progressCallback) {
      progressCallback(`Formatting LaTeX files...`, 85);
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
    progressCallback(`arXiv source downloaded successfully!`, 100);
  }

  logger.info(
    CHANNEL,
    `arXiv source downloaded and extracted to: ${paperDirFull}`,
  );

  return paperDirFull;
}
