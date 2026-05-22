/**
 * LaTeX preview and diff operations for tool edit approval.
 * Handles creating temp files, running latexdiff, and building PDFs.
 */

import { randomUUID } from 'crypto';
import path from 'path';

import { sync as globSync } from 'glob';

import { platform } from '@platform/platform';
import { getConfig } from '@agent/core/config';
import { toErrorMessage } from '@common/errors';
import { TEMP_EXTENSIONS } from '@housekeeping/constants';
import { LaTeXdiffService } from '@latex/latexdiff';
import {
  createExternalLocation,
  createWorkspaceLocation,
  WorkspaceFS,
  type FileLocation,
} from '@utils/files';

type BuildDisplayFn = (
  location: FileLocation,
  options?: { preserveFocus?: boolean },
) => Promise<void>;
export type { BuildDisplayFn };

interface LatexPreviewDisplayOptions {
  openBuildDisplay?: BuildDisplayFn;
}

let openBuildDisplayIfTex: BuildDisplayFn = async () => {};
/** Inject the VS Code LaTeX build+display function. Default: no-op. */
export function setOpenBuildDisplay(fn: BuildDisplayFn): void {
  openBuildDisplayIfTex = fn;
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

/** Temp file location options */
type TempFileLocation = 'sameDirectory' | 'workspaceTemp';

const TEXRA_TEMP_DIR = '.texra-temp';
/** Length of UUID prefix for temp file names (8 chars = 4 billion combinations, sufficient for uniqueness) */
const UUID_PREFIX_LENGTH = 8;

const latexdiffService = new LaTeXdiffService('ToolEditApproval');

/** Silently attempt to delete a file, ignoring errors */
async function silentUnlink(filePath: string): Promise<void> {
  await platform()
    .fs.delete(filePath)
    .catch(() => {});
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
        .catch(() => {});
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

  if (
    relativePath &&
    !relativePath.startsWith('..') &&
    !path.isAbsolute(relativePath)
  ) {
    return createWorkspaceLocation(tempPath, relativePath);
  }

  return createExternalLocation(tempPath);
}

/** Preview the proposed LaTeX document by creating a temp file and building it */
export async function previewProposedLatex(
  entry: LatexPreviewEntry,
  options: LatexPreviewDisplayOptions = {},
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

    await (options.openBuildDisplay ?? openBuildDisplayIfTex)(
      tempPathToLocation(tempPath),
      {
        preserveFocus: true,
      },
    );
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
  options?: LatexdiffOptions,
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
      false,
      'coarse',
      {
        cwd: WorkspaceFS.getPath() ?? path.dirname(originalPath),
        subtype: options?.subtype,
      },
    );

    if (!result.success || !result.diffFileName) {
      entry.onError(result.message ?? 'Failed to generate LaTeXdiff');
      return;
    }

    // Validate filename to prevent path traversal
    if (
      result.diffFileName.includes('/') ||
      result.diffFileName.includes('\\') ||
      result.diffFileName.includes('..')
    ) {
      entry.onError('LaTeXdiff failed: invalid output filename');
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

    await (options?.openBuildDisplay ?? openBuildDisplayIfTex)(
      tempPathToLocation(diffFilePath),
      {
        preserveFocus: true,
      },
    );
  });
}
