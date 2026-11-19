/**
 * LaTeX preview and diff operations for tool edit approval.
 * Handles creating temp files, running latexdiff, and building PDFs.
 *
 * Both previews are Effect programs the approval controller composes into its
 * own; the fiber they run on is the one a host gave that controller, and
 * nothing here runs one.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  Cause,
  Effect,
  FileSystem,
  type Path,
  Schema,
  Scope,
  type Semaphore,
} from 'effect';

import {
  isStrictlyWithin,
  createExternalLocation,
  createWorkspaceLocation,
  withSessionFs,
} from '@texra-ai/harness/host';
import { withLogChannel } from '@texra-ai/harness/plugins';
import { meansAbsent } from '@texra-ai/harness/node';
import { toErrorMessage, type FileLocation } from '@texra-ai/harness/schemas';
import { collectFilesFromPatterns } from '@housekeeping/artifactFiles';
import { TEMP_EXTENSIONS } from '@housekeeping/constants';
import { removeBestEffort } from '@texra/common/files/removeBestEffort';
import { latexdiff } from '@latex/latexdiff';
import { compileLatex2Pdf } from '@latex/texTools';
import {
  generateDiffFileName,
  WORKSPACE_DIFF_SUFFIX,
} from '@latex/latexdiff/diffFileNameManager';
import type { WorkspaceRoots } from '@texra-ai/harness';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

const CHANNEL = 'latexPreview';

/**
 * The host's build-and-show display, as the program it is: the preview
 * programs below yield it, and the approval controller forks it so a build
 * outlives the preview whose completion race interrupts it.
 */
export type BuildDisplayFn = (
  location: FileLocation,
  options?: { preserveFocus?: boolean },
) => Effect.Effect<void, Error, PreviewServices>;

/**
 * A TeX file a host could not compile to show it. The message is the whole
 * sentence the user reads.
 */
export class DisplayCompileFailed extends Schema.TaggedError<DisplayCompileFailed>()(
  'DisplayCompileFailed',
  { message: Schema.String },
) {}

/** A preview asked for with no workspace folder to stage its files in. */
class PreviewWorkspaceMissing extends Schema.TaggedError<PreviewWorkspaceMissing>()(
  'PreviewWorkspaceMissing',
  { message: Schema.String },
) {}

/**
 * Compile a TeX file to show it, into `outputDirectory` (where the host's
 * viewer reads the PDF), answering the PDF's path. A missing compiler or a
 * failed build fails with the sentence the host shows. A failed build's log
 * tail goes to the app log, not the sentence: a toast or a native dialog
 * cannot scroll a log of a few hundred lines, and in the message rather than
 * a `data` annotation because the sink bounds an annotation to 2000
 * characters.
 */
export const compileForDisplay = Effect.fn('latexPreview.compileForDisplay')(
  function* (
    roots: WorkspaceRoots,
    location: FileLocation,
    outputDirectory: string,
  ): Effect.fn.Return<string, DisplayCompileFailed, PreviewServices> {
    const sourcePath = location.absolutePath;
    const built = yield* withSessionFs(
      roots,
      compileLatex2Pdf(location, roots, { outputDirectory }),
    ).pipe(
      // No compiler to drive: the message names it and how to install one.
      Effect.catchTag('ToolMissing', (missing) =>
        Effect.fail(
          new DisplayCompileFailed({
            message: `Cannot preview ${sourcePath}: ${missing.message}`,
          }),
        ),
      ),
    );
    if (built.ok) return built.pdfPath;
    yield* Effect.logError(
      `LaTeX build failed for ${sourcePath}:\n${built.logTail}`,
    ).pipe(withLogChannel(CHANNEL));
    return yield* new DisplayCompileFailed({
      message: `LaTeX build failed for ${sourcePath}. See the LaTeX log in ${outputDirectory} for details.`,
    });
  },
);

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
  /**
   * Where the temp files the previews write are removed: each removal is a
   * finalizer of this scope, which closes once the request's previews have
   * stopped (a removal added after it closed runs at once).
   */
  readonly files: Scope.Scope;
  /** One LaTeX operation at a time: one started while another runs does
   *  nothing. */
  readonly operation: Semaphore.Semaphore;
  /** Platform-specific error reporter, injected by the caller. */
  onError: (message: string) => void;
}

/** Length of the random suffix for temp file names (8 hex digits of a UUID, 2^32 combinations) */
const TEMP_ID_LENGTH = 8;

/**
 * What the preview programs and the host build they call take from the
 * runtime a host runs them on: the temp files this module stages, and the
 * workspace-rooted compile a build display runs behind them.
 */
type PreviewServices = FileSystem.FileSystem | Path.Path | ChildProcessSpawner;

/**
 * Delete a file and the LaTeX auxiliary files its build wrote, beside it or
 * in its `build/` folder, found the way Clean Build finds them. A listing
 * that fails is logged and deletes only the file.
 */
const deleteWithAuxFiles = Effect.fn('latexPreview.deleteWithAuxFiles')(
  function* (
    filePath: string,
  ): Effect.fn.Return<void, never, FileSystem.FileSystem> {
    const dir = path.dirname(filePath);
    // An extensionless file keeps its whole name as the stem.
    const stem = path.basename(filePath, path.extname(filePath));
    // Listed relative to the file's own directory.
    const auxFiles = yield* collectFilesFromPatterns(
      dir,
      '.',
      [stem],
      TEMP_EXTENSIONS,
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`Failed to list the build files of ${filePath}`).pipe(
          Effect.annotateLogs({ data: error }),
          Effect.as(new Set<string>()),
        ),
      ),
      withLogChannel(CHANNEL),
    );
    yield* removeBestEffort(
      yield* FileSystem.FileSystem,
      [filePath, ...[...auxFiles].map((file) => path.resolve(dir, file))],
      'temp file',
    ).pipe(withLogChannel(CHANNEL));
  },
);

/** Remove `filePath` and its LaTeX auxiliary files when the entry's files
 *  scope closes. */
const removeWithEntry = Effect.fn('latexPreview.removeWithEntry')(function* (
  entry: LatexPreviewEntry,
  filePath: string,
): Effect.fn.Return<void, never, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  yield* Scope.addFinalizer(
    entry.files,
    deleteWithAuxFiles(filePath).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
    ),
  );
});

/**
 * Run a LaTeX operation, reporting its failure through the entry. It runs
 * on a fiber in the request's scope, so the request finishing interrupts it.
 */
const withLatexOperation = (
  entry: LatexPreviewEntry,
  operationName: string,
  operation: Effect.Effect<void, Error, PreviewServices>,
): Effect.Effect<void, never, PreviewServices> =>
  operation.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.sync(() => {
            entry.onError(`${operationName} failed: ${toErrorMessage(cause)}`);
          }),
    ),
    entry.operation.withPermitsIfAvailable(1),
    Effect.asVoid,
  );

/** Read file content with fallback to provided default. The disk read exists
 *  to pick up the user's saved hand edits to the approval temp file; a
 *  missing file (entry finished/cleaned up racing the preview) is genuinely
 *  benign, so only that case falls back silently. Any other failure still
 *  falls back — the held in-memory content keeps the preview usable — but
 *  warns, because the preview would silently drop the user's saved edits. */
const readFileWithFallback = Effect.fn('latexPreview.readFileWithFallback')(
  function* (
    uri: { fsPath: string },
    fallback: string,
  ): Effect.fn.Return<string, never, PreviewServices> {
    const fs = yield* FileSystem.FileSystem;
    // The raw bytes decoded as-is, line endings included.
    return yield* fs.readFile(uri.fsPath).pipe(
      Effect.map((bytes) => Buffer.from(bytes).toString('utf8')),
      Effect.catch((error) =>
        meansAbsent(error)
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
  },
);

/**
 * Create a temporary file and register its cleanup with the entry.
 * Returns the temp file path for further operations.
 */
const createTempFileWithCleanup = Effect.fn('createTempFileWithCleanup')(
  function* (entry: LatexPreviewEntry, content: string, suffix: string) {
    const workspaceRoot = entry.request.roots.workspace;
    if (!workspaceRoot) {
      return yield* new PreviewWorkspaceMissing({
        message: 'No workspace folder open',
      });
    }

    const originalPath = entry.request.path;
    const ext = path.extname(originalPath);
    const basename = path.basename(originalPath, ext);
    const tempFileName = `${basename}${suffix}-${randomUUID().slice(0, TEMP_ID_LENGTH)}${ext}`;

    // Beside the file it stands in for, where its relative inputs resolve.
    const tempDir = path.dirname(
      path.isAbsolute(originalPath)
        ? originalPath
        : path.join(workspaceRoot, originalPath),
    );
    const tempPath = path.join(tempDir, tempFileName);

    // The removal is registered however the write ends: a failed or
    // interrupted write can still leave a partial file behind.
    const fs = yield* FileSystem.FileSystem;
    yield* fs
      .writeFileString(tempPath, content)
      .pipe(Effect.onExit(() => removeWithEntry(entry, tempPath)));

    return tempPath;
  },
);
function tempPathToLocation(
  workspaceRoot: string | undefined,
  tempPath: string,
): FileLocation {
  if (workspaceRoot == null) return createExternalLocation(tempPath);

  const normalizedWorkspacePath = path.normalize(workspaceRoot);
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
      // request finishing mid-diff, which interrupts the diff after its
      // output may already be written, still has it deleted.
      const outputDirectory = path.dirname(originalPath);
      yield* removeWithEntry(
        entry,
        path.join(
          outputDirectory,
          generateDiffFileName(proposedPath, WORKSPACE_DIFF_SUFFIX),
        ),
      );

      const diffPath = yield* latexdiff(
        tempPathToLocation(entry.request.roots.workspace, originalPath),
        tempPathToLocation(entry.request.roots.workspace, proposedPath),
        {
          roots: entry.request.roots,
          cwd: entry.request.roots.workspace ?? outputDirectory,
          suffix: WORKSPACE_DIFF_SUFFIX,
          mathMarkup: 'coarse',
          subtype: options.subtype,
          outputDirectory,
        },
      ).pipe(withLogChannel('ToolEditApproval'));

      const diffLocation = tempPathToLocation(
        entry.request.roots.workspace,
        diffPath,
      );
      yield* options.openBuildDisplay(diffLocation, { preserveFocus: true });
    }),
  );
