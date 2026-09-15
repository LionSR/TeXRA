/**
 * LaTeX preview and diff operations for tool edit approval.
 * Handles creating temp files, running latexdiff, and building PDFs.
 *
 * Both previews are Effect programs the approval controller runs through its
 * host's runner, so the process runtime is the host's and nothing here runs a
 * fiber.
 */

import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import { Cause, Effect } from 'effect';
import { sync as globSync } from 'glob';
import { z } from 'zod';

import { isFileNotFoundError } from '@common/errors';
import { TEMP_EXTENSIONS } from '@housekeeping/constants';
import { LaTeXdiffService } from '@latex/latexdiff';
import { generateDiffFileName } from '@latex/latexdiff/diffFileNameManager';
import { debug, warn } from '@logger/logUtils';
import {
  LATEXDIFF_TEMP_FILE_LOCATIONS,
  type FileLocation,
} from '@shared/schemas';
import { generateShortId } from '@utils/core';
import {
  createExternalLocation,
  createWorkspaceLocation,
} from '@utils/files/fileLocation';
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
  /**
   * The request this preview belongs to. `workspacePath` is the session root
   * the temp files are placed under; these programs run on the host's own
   * runner, outside the tool call, so it rides the request rather than being
   * read from an ambient workspace scope.
   */
  request: { path: string; workspacePath?: string | undefined };
  originalUri: { fsPath: string };
  proposedUri: { fsPath: string };
  originalContent: string;
  proposedContent: string;
  isSettled: () => boolean;
  /**
   * Resolves when the request settles. A preview still running then is
   * interrupted, which stops its latexdiff subprocess.
   */
  settled: Promise<void>;
  /** Removals of the temp files the previews wrote, run when the request settles. */
  workspaceTempCleanup: Array<Effect.Effect<void>>;
  latexOperationInProgress: boolean;
  /** Platform-specific error reporter, injected by the caller. */
  onError: (message: string) => void;
}

const TEXRA_TEMP_DIR = '.texra-temp';
/** Length of the random suffix for temp file names (8 nanoid chars ≈ 2^47 combinations, sufficient for uniqueness) */
const TEMP_ID_LENGTH = 8;
/** The suffix latexdiff's output file carries after the proposed file's stem. */
const DIFF_SUFFIX = '_diff';

const latexdiffService = new LaTeXdiffService('ToolEditApproval');

/** Silently attempt to delete a file or directory, ignoring errors */
const silentDelete = (
  targetPath: string,
  kind: 'file' | 'dir',
): Effect.Effect<void> =>
  Effect.tryPromise({
    // What `BaseFS.delete` reached on the process provider: a non-directory
    // (a symlink included) is unlinked, a directory is `rm`'d without
    // recursion, and an already-absent target is not an error — that last is
    // what `force` carries, not a new best-effort.
    try: () => rm(targetPath, { force: true }),
    catch: (error) => error,
  }).pipe(
    // Best-effort temp cleanup; the target may already be gone.
    Effect.catch((error) =>
      Effect.sync(() => {
        debug('latexPreview', `Failed to delete temp ${kind} ${targetPath}`, {
          data: error,
        });
      }),
    ),
  );

/** Delete a file and the LaTeX auxiliary files built beside it */
const deleteWithAuxFiles = (filePath: string): Effect.Effect<void> =>
  Effect.suspend(() => {
    const ext = path.extname(filePath);
    const basePathNoExt = filePath.slice(0, -ext.length);
    const unlinkTargets = TEMP_EXTENSIONS.flatMap((tempExt) =>
      tempExt.includes('*')
        ? globSync(`${basePathNoExt}${tempExt}`, { nodir: true })
        : [basePathNoExt + tempExt],
    );
    return Effect.forEach(
      [filePath, ...unlinkTargets],
      (target) => silentDelete(target, 'file'),
      { concurrency: 'unbounded', discard: true },
    );
  });

/** Register cleanup with the entry, or run it now if the entry already settled */
const registerCleanup = (
  entry: LatexPreviewEntry,
  cleanup: Effect.Effect<void>,
): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (entry.isSettled()) return cleanup;
    entry.workspaceTempCleanup.push(cleanup);
    return Effect.void;
  });

/**
 * Run a LaTeX operation with standard error handling and progress tracking.
 * The operation ends early, interrupted, when the request settles under it.
 */
const withLatexOperation = (
  entry: LatexPreviewEntry,
  operationName: string,
  operation: Effect.Effect<void, unknown>,
): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (entry.latexOperationInProgress) return Effect.void;
    entry.latexOperationInProgress = true;
    return operation.pipe(
      Effect.raceFirst(Effect.promise(() => entry.settled)),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.sync(() => {
              entry.onError(
                `${operationName} failed: ${toErrorMessage(Cause.squash(cause))}`,
              );
            }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          entry.latexOperationInProgress = false;
        }),
      ),
    );
  });

/** Read file content with fallback to provided default. The disk read exists
 *  to pick up the user's saved hand edits to the approval temp file; a
 *  missing file (entry settled/cleaned up racing the preview) is genuinely
 *  benign, so only that case falls back silently. Any other failure still
 *  falls back — the held in-memory content keeps the preview usable — but
 *  warns, because the preview would silently drop the user's saved edits. */
const readFileWithFallback = (
  uri: { fsPath: string },
  fallback: string,
): Effect.Effect<string> =>
  Effect.tryPromise({
    // `BaseFS.readBytes` returned the raw bytes: no line-ending normalization
    // and no BOM handling, unlike `read`.
    try: () => readFile(uri.fsPath),
    catch: (error) => error,
  }).pipe(
    Effect.map((bytes) => bytes.toString('utf8')),
    Effect.catch((error) =>
      Effect.sync(() => {
        if (!isFileNotFoundError(error)) {
          warn(
            'latexPreview',
            `Failed to read ${uri.fsPath}; previewing held content (saved hand edits may be missing): ${toErrorMessage(error)}`,
            { data: error },
          );
        }
        return fallback;
      }),
    ),
  );

/**
 * Create a temporary file and register its cleanup with the entry.
 * Returns the temp file path for further operations.
 */
const createTempFileWithCleanup = Effect.fn('createTempFileWithCleanup')(
  function* (
    entry: LatexPreviewEntry,
    content: string,
    suffix: string,
  ): Effect.fn.Return<string, unknown> {
    const workspacePath = entry.request.workspacePath;
    if (!workspacePath) {
      return yield* Effect.fail(new Error('No workspace folder open'));
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

    const tempDir =
      location === 'workspaceTemp'
        ? path.join(workspacePath, TEXRA_TEMP_DIR)
        : path.dirname(
            path.isAbsolute(originalPath)
              ? originalPath
              : path.join(workspacePath, originalPath),
          );
    const tempPath = path.join(tempDir, tempFileName);

    // Writing the file and registering its removal are one step: a settled
    // request interrupting between them would leave a file nothing deletes.
    // The removal is registered however the write ends, since a failed write
    // can still leave a partial file behind.
    yield* Effect.uninterruptible(
      Effect.tryPromise({
        try: async () => {
          if (location === 'workspaceTemp') {
            // Recursive because the provider's `createDirectory` always was:
            // two previews of files in one folder share this temp directory.
            await mkdir(tempDir, { recursive: true });
          }
          await writeFile(tempPath, content);
        },
        catch: (error) => error,
      }).pipe(
        Effect.onExit(() =>
          registerCleanup(
            entry,
            Effect.gen(function* () {
              yield* deleteWithAuxFiles(tempPath);
              if (location === 'workspaceTemp') {
                yield* silentDelete(tempDir, 'dir');
              }
            }),
          ),
        ),
      ),
    );

    return tempPath;
  },
);
function tempPathToLocation(
  workspacePath: string | undefined,
  tempPath: string,
): FileLocation {
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
export const previewProposedLatex = (
  entry: LatexPreviewEntry,
  options: LatexPreviewDisplayOptions,
): Effect.Effect<void> =>
  withLatexOperation(
    entry,
    'Preview',
    Effect.gen(function* () {
      const content = yield* readFileWithFallback(
        entry.proposedUri,
        entry.proposedContent,
      );
      const tempPath = yield* createTempFileWithCleanup(
        entry,
        content,
        '_preview',
      );

      if (entry.isSettled()) return;

      yield* Effect.tryPromise({
        try: () =>
          options.openBuildDisplay(
            tempPathToLocation(entry.request.workspacePath, tempPath),
            {
              preserveFocus: true,
            },
          ),
        catch: (error) => error,
      });
    }),
  );

interface LatexdiffOptions extends LatexPreviewDisplayOptions {
  subtype?: string;
}

/**
 * Run latexdiff on the original and proposed content.
 * @param options.subtype - e.g., 'ONLYCHANGEDPAGE' to show only pages with changes
 */
export const runLatexdiff = (
  entry: LatexPreviewEntry,
  options: LatexdiffOptions,
): Effect.Effect<void> =>
  withLatexOperation(
    entry,
    'LaTeXdiff',
    Effect.gen(function* () {
      const [originalContent, proposedContent] = yield* Effect.all(
        [
          readFileWithFallback(entry.originalUri, entry.originalContent),
          readFileWithFallback(entry.proposedUri, entry.proposedContent),
        ],
        { concurrency: 2 },
      );

      const originalPath = yield* createTempFileWithCleanup(
        entry,
        originalContent,
        '_original',
      );
      const proposedPath = yield* createTempFileWithCleanup(
        entry,
        proposedContent,
        '_proposed',
      );

      // The diff lands beside the original copy under the proposed copy's
      // stem. Its removal is registered before latexdiff starts, so a
      // request settling mid-diff, which interrupts the diff after its
      // output may already be written, still has it deleted.
      const outputDirectory = path.dirname(originalPath);
      yield* registerCleanup(
        entry,
        deleteWithAuxFiles(
          path.join(
            outputDirectory,
            generateDiffFileName(proposedPath, DIFF_SUFFIX),
          ),
        ),
      );

      const result = yield* latexdiffService.runDiff(
        tempPathToLocation(entry.request.workspacePath, originalPath),
        tempPathToLocation(entry.request.workspacePath, proposedPath),
        DIFF_SUFFIX,
        'coarse',
        {
          cwd: entry.request.workspacePath ?? outputDirectory,
          subtype: options.subtype,
          outputDirectory,
        },
      );

      if (!result.success || !result.diffPath) {
        entry.onError(result.message ?? 'Failed to generate LaTeXdiff');
        return;
      }

      if (entry.isSettled()) return;

      const diffLocation = tempPathToLocation(
        entry.request.workspacePath,
        result.diffPath,
      );
      yield* Effect.tryPromise({
        try: () =>
          options.openBuildDisplay(diffLocation, { preserveFocus: true }),
        catch: (error) => error,
      });
    }),
  );
