// Node imports
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  normalizeFilePath,
  type FileLocation,
} from '@texra-ai/harness/schemas';

// Third-party imports
import { Effect, FileSystem, Option, type PlatformError } from 'effect';

// Local imports
import {
  pathToLocationIn,
  createExternalLocation,
  createRunStorageLocation,
  createWorkspaceLocation,
  withFileWriteLane,
} from '@texra-ai/harness/host';
import { readNormalizedFile } from '@texra-ai/harness/node';
import {
  withLogChannel,
  WorkspaceFs,
  emitAppSignal,
  type AppSignals,
} from '@texra-ai/harness/plugins';
import {
  generateDiffFileName,
  WORKSPACE_DIFF_SUFFIX,
} from '@latex/latexdiff/diffFileNameManager';

const CHANNEL = 'AcceptedFileTarget';

/**
 * Build a FileLocation that sits beside {@link baseLocation} but uses
 * {@link targetFileName}, preserving the base's location kind (workspace,
 * runStorage, or external) and propagating its workspace-relative directory.
 */
function siblingLocation(
  baseLocation: FileLocation,
  targetFileName: string,
): FileLocation {
  const targetAbsolutePath = path.join(
    path.dirname(baseLocation.absolutePath),
    targetFileName,
  );
  if (baseLocation.kind === 'external') {
    return createExternalLocation(targetAbsolutePath);
  }
  const targetRelativePath = normalizeFilePath(
    path.join(path.dirname(baseLocation.relativePath), targetFileName),
  );
  if (baseLocation.kind === 'workspace') {
    return createWorkspaceLocation(targetAbsolutePath, targetRelativePath);
  }
  return createRunStorageLocation(
    targetAbsolutePath,
    targetRelativePath,
    baseLocation.runId,
  );
}

/**
 * Verb describing the write that accepting an edited file will perform,
 * used in the confirmation prompt ("This will {action} ...").
 */
function getAcceptAction(isNewFile: boolean, targetExists: boolean): string {
  if (targetExists) return 'overwrite existing';
  if (isNewFile) return 'create';
  return 'overwrite';
}

/**
 * Confirmation prompt shown before writing accepted content into the
 * workspace. Shared by the VS Code command and the desktop bridge so both
 * hosts surface identical wording.
 */
function buildAcceptConfirmMessage(
  targetPath: string,
  basePath: string,
  editedPath: string,
  targetExists: boolean,
): string {
  const isNewFile = targetPath !== basePath;
  const action = getAcceptAction(isNewFile, targetExists);
  const extensionNote = isNewFile
    ? `Extensions differ (${path.extname(basePath).toLowerCase()} vs ${path.extname(editedPath).toLowerCase()}). `
    : '';
  return `${extensionNote}This will ${action} '${path.basename(targetPath)}' with content from '${path.basename(editedPath)}'. Are you sure?`;
}

/**
 * Success message shown after writing accepted content. `replaced` is whether
 * the target already existed (true → "replaced", false → "created").
 */
function buildAcceptSuccessMessage(
  targetFileName: string,
  editedPath: string,
  replaced: boolean,
): string {
  const operation = replaced ? 'replaced' : 'created';
  return `Successfully ${operation} '${targetFileName}' with content from '${path.basename(editedPath)}'`;
}

/**
 * Host capabilities the accept-edited commit step reaches through that the
 * filesystem cannot answer: reporting success. The reads, writes and
 * deletions themselves go through the `FileSystem` the returned program
 * requires, and a workspace write is announced on the process's signal hub
 * (`workspaceFilesWritten`), so no host re-implements them. `E` is the
 * failure the host's own notification can report.
 */
interface CommitAcceptedFilePorts<E = never> {
  showInfo: (message: string) => Effect.Effect<void, E>;
}

/**
 * Host capabilities the accept-edited replace flow reaches through, so the
 * host-neutral orchestration can run on both the VS Code command (warning
 * dialog) and the desktop bridge (dialog IPC) without each side
 * re-implementing the confirm / commit sequence.
 */
interface AcceptEditedFileReplacePorts<
  E = never,
> extends CommitAcceptedFilePorts<E> {
  /** Confirm the (possibly overwriting) write; return false to abort. */
  confirm: (message: string) => Effect.Effect<boolean, E>;
}

/**
 * Write `editedLocation`'s content into `target`, emitting a workspace-write
 * notification, cleaning up the stale diff companion, and reporting success.
 * Answers the content it wrote, read once, so a caller describing the
 * accepted file reads exactly what was written; none when the target no
 * longer holds `confirmedAgainst` (`undefined` for no file), the content
 * the person confirmed the replacement against.
 * Runs once the target has been resolved and confirmed. `targetExisted`
 * (whether the target already had content, for the "replaced" vs "created"
 * wording) is the caller's to compute, since it already needs it to word its
 * confirmation prompt and shouldn't check twice.
 *
 * A location's absolute path is where its file is, inside the workspace or
 * not, so every read and write goes through the `FileSystem` the caller's
 * runtime carries, at that path.
 */
const commitAcceptedFile = Effect.fn('commitAcceptedFile')(function* <E>(
  baseLocation: FileLocation,
  editedLocation: FileLocation,
  targetLocation: FileLocation,
  confirmedAgainst: string | undefined,
  targetExisted: boolean,
  ports: CommitAcceptedFilePorts<E>,
): Effect.fn.Return<
  Option.Option<string>,
  E | PlatformError.PlatformError,
  FileSystem.FileSystem | AppSignals
> {
  const fs = yield* FileSystem.FileSystem;
  const targetPath = targetLocation.absolutePath;
  const targetFileName = path.basename(targetPath);
  const editedPath = editedLocation.absolutePath;

  const editedContent = yield* readNormalizedFile(fs, editedPath);
  // The confirmation was given to the target as it was when the dialog
  // opened; the dialog can stay open for minutes. A save to the target
  // meanwhile (the user's editor, a run) is not replaced on that answer.
  // The check and the write hold the file's write lane, shared with every
  // other writer that reads, decides and writes it (an approved edit, the
  // desktop editor's save). The new content is staged beside the file and
  // renamed over it, so a write that fails partway leaves the user's file as
  // it was. An existing target is replaced where a symlink points, with the
  // mode it had.
  const written = yield* Effect.gen(function* () {
    const current = yield* contentOrMissing(fs, targetPath);
    if (current !== confirmedAgainst) return false;
    const real =
      current === undefined ? targetPath : yield* fs.realPath(targetPath);
    const mode =
      current === undefined ? undefined : (yield* fs.stat(real)).mode & 0o7777;
    const staged = path.join(
      path.dirname(real),
      `.${path.basename(real)}.${randomUUID()}.tmp`,
    );
    yield* fs.writeFileString(staged, editedContent).pipe(
      Effect.andThen(mode === undefined ? Effect.void : fs.chmod(staged, mode)),
      Effect.andThen(fs.rename(staged, real)),
      Effect.onError(() =>
        fs.remove(staged, { force: true }).pipe(
          Effect.ignore({
            log: 'Warn',
            message: `A staged accept file stays behind: ${staged}`,
          }),
        ),
      ),
      Effect.uninterruptible,
    );
    return true;
  }).pipe(withFileWriteLane(targetPath));
  if (!written) {
    yield* ports.showInfo(
      `${targetFileName} changed while the confirmation was open; nothing was written. Accept again to replace the current content.`,
    );
    return Option.none();
  }
  if (targetLocation.kind === 'workspace') {
    yield* emitAppSignal('workspaceFilesWritten', {
      absolutePaths: [targetLocation.absolutePath],
    });
  }

  // A copy or sibling write (an extension mismatch resolving to a new file
  // via acceptedFileTarget, or an explicit "save as copy") leaves the base
  // untouched, so the diff comparing it against `editedPath` is still
  // accurate.
  const stale =
    targetLocation.absolutePath === baseLocation.absolutePath
      ? staleDiffFileLocation(baseLocation, editedPath)
      : undefined;
  if (stale) {
    // Diff-file cleanup is a best-effort side effect of accepting a file: a
    // file already gone is the post-condition, and any other failure (a
    // locked file) is reported without failing the accept.
    yield* fs
      .remove(stale.absolutePath, { force: true })
      .pipe(
        Effect.catchTag('PlatformError', (error) =>
          Effect.logWarning(
            `Could not remove the stale diff file ${stale.absolutePath}: ${error.message}`,
          ).pipe(withLogChannel(CHANNEL)),
        ),
      );
  }

  yield* ports.showInfo(
    buildAcceptSuccessMessage(targetFileName, editedPath, targetExisted),
  );
  return Option.some(editedContent);
});

/** The file's content, or `undefined` for a file that is not there. */
const contentOrMissing = Effect.fn('acceptedFileTarget.contentOrMissing')(
  function* (
    fs: FileSystem.FileSystem,
    absolutePath: string,
  ): Effect.fn.Return<string | undefined, PlatformError.PlatformError> {
    if (!(yield* fs.exists(absolutePath))) return undefined;
    return yield* fs.readFileString(absolutePath);
  },
);

/**
 * Resolve the accept target beside the base file, confirm the write, then
 * commit it via {@link commitAcceptedFile}. Answers the content written,
 * or none when nothing was (the user declined, or the target changed while
 * the confirmation was open). The document task toolbar's accept, on both
 * hosts, runs it with the host's confirmation.
 */
export const acceptEditedFileReplace = Effect.fn('acceptEditedFileReplace')(
  function* <E>(
    baseLocation: FileLocation,
    editedLocation: FileLocation,
    ports: AcceptEditedFileReplacePorts<E>,
  ): Effect.fn.Return<
    Option.Option<string>,
    E | PlatformError.PlatformError,
    FileSystem.FileSystem | AppSignals
  > {
    const fs = yield* FileSystem.FileSystem;
    const editedPath = editedLocation.absolutePath;
    const targetLocation = acceptedFileTarget(baseLocation, editedPath);
    const targetPath = targetLocation.absolutePath;
    const isNewFile = targetPath !== baseLocation.absolutePath;
    const confirmedAgainst = yield* contentOrMissing(fs, targetPath);
    const targetExists = isNewFile && confirmedAgainst !== undefined;

    const confirmed = yield* ports.confirm(
      buildAcceptConfirmMessage(
        targetPath,
        baseLocation.absolutePath,
        editedPath,
        targetExists,
      ),
    );
    if (!confirmed) return Option.none();
    return yield* commitAcceptedFile(
      baseLocation,
      editedLocation,
      targetLocation,
      confirmedAgainst,
      !isNewFile || targetExists,
      ports,
    );
  },
);

/**
 * The stale `_diff` companion file a prior latexdiff run would have generated
 * for the `baseLocation` / `editedPath` pair (see {@link generateDiffFileName}),
 * sitting beside `baseLocation`, once an accept has written over the base.
 * `undefined` when that companion is the base itself: possible whenever
 * `baseLocation`'s own name already matches the generated diff-name pattern
 * for `editedPath` (e.g. accepting into a base literally named
 * `<edited-stem>_diff.tex`, or accepting directly into a latexdiff
 * artifact) — deleting it would delete the file just accepted.
 */
function staleDiffFileLocation(
  baseLocation: FileLocation,
  editedPath: string,
): FileLocation | undefined {
  const diffLocation = siblingLocation(
    baseLocation,
    generateDiffFileName(editedPath, WORKSPACE_DIFF_SUFFIX),
  );
  return diffLocation.absolutePath === baseLocation.absolutePath
    ? undefined
    : diffLocation;
}

/**
 * Remove stale diff companions after accepting workspace outputs, keeping
 * successful paths. `workspaceRoot` is the accepting session's folder, carried
 * as data; the deletions go through that session's own confined view.
 */
export const cleanupAcceptedWorkspaceDiffFiles = Effect.fn(
  'acceptedFileTarget.cleanupDiffFiles',
)(function* (
  workspaceRoot: string | undefined,
  entries: readonly { outputPath: string; originalPath: string }[],
): Effect.fn.Return<string[], never, WorkspaceFs> {
  const stale = entries.flatMap(({ outputPath, originalPath }) => {
    const original = pathToLocationIn(workspaceRoot, originalPath);
    if (original.kind === 'external') return [];
    const diffLocation = staleDiffFileLocation(original, outputPath);
    if (!diffLocation || diffLocation.kind === 'external') return [];
    return [diffLocation.relativePath];
  });

  // A missing or locked diff companion does not undo an accepted file, so the
  // sweep keeps every deletion that worked and names the ones that did not
  // rather than dropping them silently. `force` keeps an already-absent
  // companion a success: there is nothing left to remove.
  const workspaceFs = yield* WorkspaceFs;
  const removed = yield* Effect.forEach(
    stale,
    (relativePath) =>
      workspaceFs.remove(relativePath, { force: true }).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning(
            `Could not remove the stale diff file ${relativePath}: ${error.message}`,
          ).pipe(withLogChannel(CHANNEL), Effect.as(false)),
        ),
      ),
    { concurrency: 8 },
  );
  return stale.filter((_, index) => removed[index]);
});

/** Where accepted content goes: over the base when the extensions match,
 *  otherwise a new file beside it named after the edited file. */
function acceptedFileTarget(
  baseLocation: FileLocation,
  editedPath: string,
): FileLocation {
  const sameExtension =
    path.extname(baseLocation.absolutePath).toLowerCase() ===
    path.extname(editedPath).toLowerCase();
  return sameExtension
    ? baseLocation
    : siblingLocation(baseLocation, path.basename(editedPath));
}
