/**
 * LaTeX preview and diff operations for tool edit approval.
 * Handles creating temp files, running latexdiff, and building PDFs.
 */

import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import * as vscode from 'vscode';

import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';
import { getConfig } from '@utils/config';
import { WorkspaceFS, pathToLocation } from '@utils/files';
import { LaTeXdiffService } from '@latex/latexdiff';
import { TEMP_EXTENSIONS } from '@housekeeping/constants';

/** Interface for entries that support LaTeX preview operations */
export interface LatexPreviewEntry {
  request: { path: string };
  originalUri: vscode.Uri;
  proposedUri: vscode.Uri;
  originalContent: string;
  proposedContent: string;
  isSettled: () => boolean;
  workspaceTempCleanup: Array<() => Promise<void>>;
  latexOperationInProgress: boolean;
}

/** Temp file location options */
type TempFileLocation = 'sameDirectory' | 'workspaceTemp';

const TEXRA_TEMP_DIR = '.texra-temp';
/** Length of UUID prefix for temp file names (8 chars = 4 billion combinations, sufficient for uniqueness) */
const UUID_PREFIX_LENGTH = 8;

const latexdiffService = new LaTeXdiffService('ToolEditApproval');

/** Silently attempt to delete a file, ignoring errors */
async function silentUnlink(filePath: string): Promise<void> {
  await fs.unlink(filePath).catch(() => {});
}

/** Clean up LaTeX auxiliary files for a given base path */
async function cleanupLatexAuxFiles(filePath: string): Promise<void> {
  const ext = path.extname(filePath);
  const basePathNoExt = filePath.slice(0, -ext.length);
  for (const tempExt of TEMP_EXTENSIONS) {
    await silentUnlink(basePathNoExt + tempExt);
  }
}

/** Register cleanup function with entry, or run immediately if already settled */
function registerCleanup(
  entry: LatexPreviewEntry,
  cleanup: () => Promise<void>,
): void {
  if (entry.isSettled()) {
    void cleanup().catch(() => {});
    return;
  }
  entry.workspaceTempCleanup.push(cleanup);
}

/** Execute a LaTeX operation with standard error handling and progress tracking */
async function withLatexOperation(
  entry: LatexPreviewEntry,
  operationName: string,
  operation: () => Promise<void>,
): Promise<void> {
  if (entry.latexOperationInProgress) {
    return;
  }
  entry.latexOperationInProgress = true;

  try {
    await operation();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`${operationName} failed: ${message}`);
  } finally {
    entry.latexOperationInProgress = false;
  }
}

/** Read file content with fallback to provided default */
async function readFileWithFallback(
  uri: vscode.Uri,
  fallback: string,
): Promise<string> {
  return fs.readFile(uri.fsPath, 'utf8').catch(() => fallback);
}

/**
 * Create a temporary file and register its cleanup with the entry.
 * Returns the temp file path for further operations.
 */
async function createTempFileWithCleanup(
  entry: LatexPreviewEntry,
  content: string,
  suffix: string,
): Promise<string> {
  const workspacePath = WorkspaceFS.getPath();
  if (!workspacePath) {
    throw new Error('No workspace folder open');
  }

  const location = getConfig<TempFileLocation>(
    'texra.latexdiff.tempFileLocation',
    'sameDirectory',
  );

  const originalPath = entry.request.path;
  const ext = path.extname(originalPath);
  const basename = path.basename(originalPath, ext);
  const tempFileName = `${basename}${suffix}-${randomUUID().slice(0, UUID_PREFIX_LENGTH)}${ext}`;

  let tempDir: string;
  if (location === 'workspaceTemp') {
    tempDir = path.join(workspacePath, TEXRA_TEMP_DIR);
    await fs.mkdir(tempDir, { recursive: true });
  } else {
    const resolvedPath = path.isAbsolute(originalPath)
      ? originalPath
      : path.join(workspacePath, originalPath);
    tempDir = path.dirname(resolvedPath);
  }

  const tempPath = path.join(tempDir, tempFileName);
  await fs.writeFile(tempPath, content, 'utf8');

  registerCleanup(entry, async () => {
    await silentUnlink(tempPath);
    await cleanupLatexAuxFiles(tempPath);
    if (location === 'workspaceTemp') {
      await fs.rmdir(tempDir).catch(() => {});
    }
  });

  return tempPath;
}

/** Preview the proposed LaTeX document by creating a temp file and building it */
export async function previewProposedLatex(
  entry: LatexPreviewEntry,
): Promise<void> {
  await withLatexOperation(entry, 'Preview', async () => {
    const content = await readFileWithFallback(
      entry.proposedUri,
      entry.proposedContent,
    );
    const tempPath = await createTempFileWithCleanup(entry, content, '_preview');

    if (entry.isSettled()) return;

    await openBuildDisplayIfTex(pathToLocation(tempPath), { preserveFocus: true });
  });
}

/**
 * Run latexdiff on the original and proposed content.
 * @param options.subtype - e.g., 'ONLYCHANGEDPAGE' to show only pages with changes
 */
export async function runLatexdiff(
  entry: LatexPreviewEntry,
  options?: { subtype?: string },
): Promise<void> {
  await withLatexOperation(entry, 'LaTeXdiff', async () => {
    const [originalContent, proposedContent] = await Promise.all([
      readFileWithFallback(entry.originalUri, entry.originalContent),
      readFileWithFallback(entry.proposedUri, entry.proposedContent),
    ]);

    const originalPath = await createTempFileWithCleanup(
      entry,
      originalContent,
      '_original',
    );
    const proposedPath = await createTempFileWithCleanup(
      entry,
      proposedContent,
      '_proposed',
    );

    const result = await latexdiffService.runDiff(
      pathToLocation(originalPath),
      pathToLocation(proposedPath),
      '_diff',
      false,
      'coarse',
      {
        cwd: WorkspaceFS.getPath() ?? path.dirname(originalPath),
        subtype: options?.subtype,
      },
    );

    if (!result.success || !result.diffFileName) {
      vscode.window.showErrorMessage(
        result.message ?? 'Failed to generate LaTeXdiff',
      );
      return;
    }

    // Validate filename to prevent path traversal
    if (
      result.diffFileName.includes('/') ||
      result.diffFileName.includes('\\') ||
      result.diffFileName.includes('..')
    ) {
      vscode.window.showErrorMessage(
        'LaTeXdiff failed: invalid output filename',
      );
      return;
    }

    const diffFilePath = path.join(
      path.dirname(originalPath),
      result.diffFileName,
    );
    registerCleanup(entry, async () => {
      await silentUnlink(diffFilePath);
      await cleanupLatexAuxFiles(diffFilePath);
    });

    if (entry.isSettled()) return;

    await openBuildDisplayIfTex(pathToLocation(diffFilePath), {
      preserveFocus: true,
    });
  });
}
