/**
 * LaTeX preview and diff operations for tool edit approval.
 * Handles creating temp files, running latexdiff, and building PDFs.
 *
 * Both previews are Effect programs the approval controller composes into its
 * own; the fiber they run on is the one a host gave that controller, and
 * nothing here runs one.
 */

import path from 'node:path';

import { Cause, Deferred, Effect, FileSystem, type Path } from 'effect';
import { sync as globSync } from 'glob';

import { TEMP_EXTENSIONS } from '@housekeeping/constants';
import { LaTeXdiffService } from '@latex/latexdiff';
import { generateDiffFileName } from '@latex/latexdiff/diffFileNameManager';
import { withLogChannel } from '@logger/effectLog';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import {
  LATEXDIFF_TEMP_FILE_LOCATIONS,
  type FileLocation,
} from '@shared/schemas';
import { readSettingFrom } from '@utils/config/platformSettings';
import { generateShortId } from '@utils/core';
import {
  createExternalLocation,
  createWorkspaceLocation,
} from '@utils/files/fileLocation';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { isStrictlyWithin } from '@utils/core/pathCore';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

const CHANNEL = 'latexPreview';

/**
 * The host's build-and-show display, as the program it is: the preview
 * programs below yield it, and the approval controller forks it so a build
 * outlives the preview whose settle race interrupts it.
 */
export type BuildDisplayFn = (
  location: FileLocation,
  options?: { preserveFocus?: boolean },
) => Effect.Effect<void, Error, PreviewServices>;

interface LatexPreviewDisplayOptions {
  openBuildDisplay: BuildDisplayFn;
}

/** Interface for entries that support LaTeX preview operations */
export interface LatexPreviewEntry {
  /**
   * The request this preview belongs to. Its `roots` are the session's: the
   * temp files are placed under that workspace and the diff reads its
   * settings from those slots. These programs run outside the tool call, so
   * the roots ride the request rather than being read from an ambient
   * workspace scope.
   */
  request: { path: string; roots: WorkspaceRoots };
  originalUri: { fsPath: string };
  proposedUri: { fsPath: string };
  originalContent: string;
  proposedContent: string;
  isSettled: () => boolean;
  /**
   * Filled when the request settles. A preview still running then is
   * interrupted, which stops its latexdiff subprocess.
   */
  settled: Deferred.Deferred<void>;
  /** Removals of the temp files the previews wrote, run when the request settles. */
  workspaceTempCleanup: Array<
    Effect.Effect<void, never, FileSystem.FileSystem>
  >;
  latexOperationInProgress: boolean;
  /** Platform-specific error reporter, injected by the caller. */
  onError: (message: string) => void;
}

const TEXRA_TEMP_DIR = '.texra-temp';
/** Length of the random suffix for temp file names (8 nanoid chars ≈ 2^47 combinations, sufficient for uniqueness) */
const TEMP_ID_LENGTH = 8;
/** The suffix latexdiff's output file carries after the proposed file's stem. */
const DIFF_SUFFIX = '_diff';

/**
 * What the preview programs and the host build they call take from the
 * runtime a host runs them on: the temp files this module stages, and the
 * workspace-rooted compile a build display runs behind them.
 */
type PreviewServices = FileSystem.FileSystem | Path.Path | ChildProcessSpawner;

/** Delete a file or directory; a real failure is logged, not raised. */
const silentDelete = (
  targetPath: string,
  kind: 'file' | 'dir',
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // `fs.remove` without `recursive`: a non-directory (a symlink included)
    // is unlinked, a directory is `rm`'d without
    // recursion, and an already-absent target is not an error — that last is
    // what `force` carries, not a new best-effort.
    yield* fs.remove(targetPath, { force: true }).pipe(
      // Best-effort temp cleanup: `force` already absorbs an absent target,
      // so what reaches here is a real fault worth a warning.
      Effect.catch((error) =>
        Effect.logWarning(`Failed to delete temp ${kind} ${targetPath}`).pipe(
          withLogChannel(CHANNEL),
          Effect.annotateLogs({ data: error }),
        ),
      ),
    );
  });

/** Delete a file and the LaTeX auxiliary files built beside it */
const deleteWithAuxFiles = (
  filePath: string,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.suspend(() => {
    const ext = path.extname(filePath);
    // An extensionless file (extname returns '') has no suffix to strip:
    // `slice(0, -0)` is `slice(0, 0)`, which would drop the path entirely and
    // unlink bare relative names (and glob every `*.bak*`) in the process cwd.
    const basePathNoExt =
      ext === '' ? filePath : filePath.slice(0, -ext.length);
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
  cleanup: Effect.Effect<void, never, FileSystem.FileSystem>,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
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
  operation: Effect.Effect<void, Error, PreviewServices>,
): Effect.Effect<void, never, PreviewServices> =>
  Effect.suspend(() => {
    if (entry.latexOperationInProgress) return Effect.void;
    entry.latexOperationInProgress = true;
    return operation.pipe(
      Effect.raceFirst(Deferred.await(entry.settled)),
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
): Effect.Effect<string, never, PreviewServices> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // The raw bytes decoded as-is: no line-ending normalization and no BOM
    // handling, unlike `readNormalizedFile`.
    return yield* fs.readFile(uri.fsPath).pipe(
      Effect.map((bytes) => Buffer.from(bytes).toString('utf8')),
      Effect.catch((error) =>
        error.reason._tag === 'NotFound'
          ? Effect.succeed(fallback)
          : Effect.logWarning(
              `Failed to read ${uri.fsPath}; previewing held content (saved hand edits may be missing): ${toErrorMessage(error)}`,
            ).pipe(
              withLogChannel(CHANNEL),
              Effect.annotateLogs({ data: error }),
              Effect.as(fallback),
            ),
      ),
    );
  });

/**
 * Create a temporary file and register its cleanup with the entry.
 * Returns the temp file path for further operations.
 */
const createTempFileWithCleanup = Effect.fn('createTempFileWithCleanup')(
  function* (
    entry: LatexPreviewEntry,
    content: string,
    suffix: string,
  ): Effect.fn.Return<string, Error, PreviewServices> {
    const workspacePath = entry.request.roots.workspace;
    if (!workspacePath) {
      return yield* Effect.fail(new Error('No workspace folder open'));
    }

    const location = yield* readSettingFrom<
      (typeof LATEXDIFF_TEMP_FILE_LOCATIONS)[number]
    >(entry.request.roots, 'texra.latexdiff.tempFileLocation');

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
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        if (location === 'workspaceTemp') {
          // Recursive because the provider's `createDirectory` always was:
          // two previews of files in one folder share this temp directory.
          yield* fs.makeDirectory(tempDir, { recursive: true });
        }
        yield* fs.writeFileString(tempPath, content);
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
): Effect.Effect<void, never, PreviewServices> =>
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

      yield* options.openBuildDisplay(
        tempPathToLocation(entry.request.roots.workspace, tempPath),
        { preserveFocus: true },
      );
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
): Effect.Effect<void, never, PreviewServices> =>
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

      const result = yield* new LaTeXdiffService(
        'ToolEditApproval',
        entry.request.roots,
      ).runDiff(
        tempPathToLocation(entry.request.roots.workspace, originalPath),
        tempPathToLocation(entry.request.roots.workspace, proposedPath),
        DIFF_SUFFIX,
        'coarse',
        {
          cwd: entry.request.roots.workspace ?? outputDirectory,
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
        entry.request.roots.workspace,
        result.diffPath,
      );
      yield* options.openBuildDisplay(diffLocation, { preserveFocus: true });
    }),
  );
