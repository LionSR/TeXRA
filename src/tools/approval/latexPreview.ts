/**
 * LaTeX preview and diff operations for tool edit approval.
 * Handles creating temp files, running latexdiff, and building PDFs.
 */

import path from 'node:path';

import { sync as globSync } from 'glob';
import { z } from 'zod';

import { TEMP_EXTENSIONS } from '@housekeeping/constants';
import { LaTeXdiffService } from '@latex/latexdiff';
import { debug } from '@logger/logUtils';
import { platform } from '@platform/platform';
import {
  LATEXDIFF_TEMP_FILE_LOCATIONS,
  type FileLocation,
} from '@shared/schemas';
import { generateShortId } from '@utils/core';
import {
  createExternalLocation,
  createWorkspaceLocation,
} from '@utils/files/fileLocation';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { getValidatedConfig } from '@utils/config/configUtils';
import { isStrictlyWithin } from '@utils/core/pathCore';

export type BuildDisplayFn = (
  location: FileLocation,
  options?: { preserveFocus?: boolean },
) => Promise<void>;

interface LatexPreviewDisplayOptions {
  openBuildDisplay: BuildDisplayFn;
}

/** Interface for entries that support LaTeX preview operations */
export interface LatexPreviewEntry {
  request: { path: string };
  originalUri: { fsPath: string };
  proposedUri: { fsPath: string };
  originalContent: string;
  proposedContent: string;
  isSettled: () => boolean;
  workspaceTempCleanup: Array<() => Promise<void>>;
  latexOperationInProgress: boolean;
  /** Platform-specific error reporter, injected by the caller. */
  onError: (message: string) => void;
}

const TEXRA_TEMP_DIR = '.texra-temp';
/** Length of the random suffix for temp file names (8 nanoid chars ≈ 2^47 combinations, sufficient for uniqueness) */
const TEMP_ID_LENGTH = 8;

const latexdiffService = new LaTeXdiffService('ToolEditApproval');

/** Silently attempt to delete a file, ignoring errors */
async function silentUnlink(filePath: string): Promise<void> {
  await platform()
    .fs.delete(filePath)
    .catch((error) => {
      // Best-effort temp cleanup; the file may already be gone.
      debug('latexPreview', `Failed to delete temp file ${filePath}`, {
        data: error,
      });
    });
}

/** Clean up LaTeX auxiliary files for a given base path */
async function cleanupLatexAuxFiles(filePath: string): Promise<void> {
  const ext = path.extname(filePath);
  const basePathNoExt = filePath.slice(0, -ext.length);
  const unlinkTargets = TEMP_EXTENSIONS.flatMap((tempExt) =>
    tempExt.includes('*')
      ? globSync(`${basePathNoExt}${tempExt}`, { nodir: true })
      : [basePathNoExt + tempExt],
  );
  await Promise.all(unlinkTargets.map(silentUnlink));
}

/** Register cleanup function with entry, or run immediately if already settled */
function registerCleanup(
  entry: LatexPreviewEntry,
  cleanup: () => Promise<void>,
): void {
  if (entry.isSettled()) {
    // Best-effort cleanup for an already-settled entry; failures are benign.
    void cleanup().catch((error) => {
      debug('latexPreview', 'Immediate cleanup failed for settled entry', {
        data: error,
      });
    });
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
    entry.onError(`${operationName} failed: ${toErrorMessage(err)}`);
  } finally {
    entry.latexOperationInProgress = false;
  }
}

/** Read file content with fallback to provided default */
async function readFileWithFallback(
  uri: { fsPath: string },
  fallback: string,
): Promise<string> {
  return platform()
    .fs.readFile(uri.fsPath)
    .then((bytes) => Buffer.from(bytes).toString('utf8'))
    .catch(() => fallback);
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

  const location = getValidatedConfig(
    'texra.latexdiff.tempFileLocation',
    z.enum(LATEXDIFF_TEMP_FILE_LOCATIONS),
    'sameDirectory',
  );

  const originalPath = entry.request.path;
  const ext = path.extname(originalPath);
  const basename = path.basename(originalPath, ext);
  const tempFileName = `${basename}${suffix}-${generateShortId(TEMP_ID_LENGTH)}${ext}`;

  let tempDir: string;
  if (location === 'workspaceTemp') {
    tempDir = path.join(workspacePath, TEXRA_TEMP_DIR);
    await platform().fs.createDirectory(tempDir);
  } else {
    const resolvedPath = path.isAbsolute(originalPath)
      ? originalPath
      : path.join(workspacePath, originalPath);
    tempDir = path.dirname(resolvedPath);
  }

  const tempPath = path.join(tempDir, tempFileName);
  await platform().fs.writeFile(tempPath, Buffer.from(content, 'utf8'));

  registerCleanup(entry, async () => {
    await silentUnlink(tempPath);
    await cleanupLatexAuxFiles(tempPath);
    if (location === 'workspaceTemp') {
      await platform()
        .fs.delete(tempDir)
        .catch((error) => {
          // Best-effort temp dir removal; it may be non-empty or already gone.
          debug('latexPreview', `Failed to delete temp dir ${tempDir}`, {
            data: error,
          });
        });
    }
  });

  return tempPath;
}

function tempPathToLocation(tempPath: string): FileLocation {
  const workspacePath = WorkspaceFS.getPath();
  if (workspacePath == null) return createExternalLocation(tempPath);

  const normalizedWorkspacePath = path.normalize(workspacePath);
  const normalizedTempPath = path.normalize(tempPath);
  const relativePath = path.relative(
    normalizedWorkspacePath,
    normalizedTempPath,
  );

  if (isStrictlyWithin(normalizedWorkspacePath, normalizedTempPath)) {
    return createWorkspaceLocation(tempPath, relativePath);
  }

  return createExternalLocation(tempPath);
}

/** Preview the proposed LaTeX document by creating a temp file and building it */
export async function previewProposedLatex(
  entry: LatexPreviewEntry,
  options: LatexPreviewDisplayOptions,
): Promise<void> {
  await withLatexOperation(entry, 'Preview', async () => {
    const content = await readFileWithFallback(
      entry.proposedUri,
      entry.proposedContent,
    );
    const tempPath = await createTempFileWithCleanup(
      entry,
      content,
      '_preview',
    );

    if (entry.isSettled()) return;

    await options.openBuildDisplay(tempPathToLocation(tempPath), {
      preserveFocus: true,
    });
  });
}

interface LatexdiffOptions extends LatexPreviewDisplayOptions {
  subtype?: string;
}

/**
 * Run latexdiff on the original and proposed content.
 * @param options.subtype - e.g., 'ONLYCHANGEDPAGE' to show only pages with changes
 */
export async function runLatexdiff(
  entry: LatexPreviewEntry,
  options: LatexdiffOptions,
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
      tempPathToLocation(originalPath),
      tempPathToLocation(proposedPath),
      '_diff',
      'coarse',
      {
        cwd: WorkspaceFS.getPath() ?? path.dirname(originalPath),
        subtype: options.subtype,
      },
    );

    if (!result.success || !result.diffPath) {
      entry.onError(result.message ?? 'Failed to generate LaTeXdiff');
      return;
    }

    const diffFilePath = result.diffPath;
    registerCleanup(entry, async () => {
      await silentUnlink(diffFilePath);
      await cleanupLatexAuxFiles(diffFilePath);
    });

    if (entry.isSettled()) return;

    await options.openBuildDisplay(tempPathToLocation(diffFilePath), {
      preserveFocus: true,
    });
  });
}
