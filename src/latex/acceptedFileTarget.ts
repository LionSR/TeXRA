// Node imports
import path from 'node:path';

// Third-party imports
import { Cause, Effect, Exit, FileSystem, type PlatformError } from 'effect';

// Local imports
import { generateDiffFileName } from '@latex/latexdiff/diffFileNameManager';
import { withLogChannel } from '@logger/effectLog';
import { WorkspaceFs } from '@platform/rootedFs';
import type { FileLocation } from '@shared/schemas';
import { normalizeFilePath } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  createExternalLocation,
  createRunStorageLocation,
  createWorkspaceLocation,
} from '@utils/files/fileLocation';
import { locateInWorkspace } from '@utils/files/workspaceFS';
import { getExtensionLowercase } from '@utils/core/pathCore';
import { normalizeLineEndings } from '@utils/text/stringUtils';

const CHANNEL = 'AcceptedFileTarget';

export type AcceptedFileTarget = {
  targetLocation: FileLocation;
  targetFileName: string;
  isNewFile: boolean;
};

/**
 * Build a FileLocation that sits beside {@link baseLocation} but uses
 * {@link targetFileName}, preserving the base's location kind (workspace,
 * runStorage, or external) and propagating its workspace-relative directory.
 */
export function siblingLocation(
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
  target: AcceptedFileTarget,
  basePath: string,
  editedPath: string,
  targetExists: boolean,
): string {
  const action = getAcceptAction(target.isNewFile, targetExists);
  const extensionNote = target.isNewFile
    ? `Extensions differ (${getExtensionLowercase(basePath)} vs ${getExtensionLowercase(editedPath)}). `
    : '';
  return `${extensionNote}This will ${action} '${target.targetFileName}' with content from '${path.basename(editedPath)}'. Are you sure?`;
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
 * filesystem cannot answer: notifying the host of a workspace write and
 * reporting success. The reads, writes and deletions themselves go through
 * the `FileSystem` the returned program requires, so no host re-implements
 * them. `E` is the failure the host's own notification can report.
 */
export interface CommitAcceptedFilePorts<E = never> {
  /** Notify the host that a workspace file was written at this absolute path. */
  emitWritten: (absolutePath: string) => void;
  showInfo: (message: string) => Effect.Effect<void, E>;
}

/**
 * Host capabilities the accept-edited replace flow reaches through, so the
 * host-neutral orchestration can run on both the VS Code command (warning
 * dialog, app signals) and the desktop bridge (dialog IPC) without each side
 * re-implementing the confirm / commit sequence.
 */
export interface AcceptEditedFileReplacePorts<
  E = never,
> extends CommitAcceptedFilePorts<E> {
  /** Confirm the (possibly overwriting) write; return false to abort. */
  confirm: (message: string) => Effect.Effect<boolean, E>;
}

/**
 * Write `editedLocation`'s content into `target`, emitting a workspace-write
 * notification, cleaning up the stale diff companion, and reporting success.
 * Shared by every "accept edited content" path once a target has already
 * been resolved and (if needed) confirmed — replace, save-as-copy, or the
 * desktop bridge's single-confirm flow. `targetExisted` (whether the target
 * already had content, for the "replaced" vs "created" wording) is the
 * caller's to compute, since the replace path already needs it to word its
 * confirmation prompt and shouldn't check twice.
 *
 * A location's absolute path is where its file is, inside the workspace or
 * not, so every read and write goes through the `FileSystem` the caller's
 * runtime carries, at that path.
 */
export function commitAcceptedFile<E>(
  baseLocation: FileLocation,
  editedLocation: FileLocation,
  target: { targetLocation: FileLocation; targetFileName: string },
  targetExisted: boolean,
  ports: CommitAcceptedFilePorts<E>,
): Effect.Effect<void, E | PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { targetLocation, targetFileName } = target;
    const editedPath = editedLocation.absolutePath;

    const editedContent = normalizeLineEndings(
      yield* fs.readFileString(editedPath),
    );
    yield* fs.writeFileString(targetLocation.absolutePath, editedContent);
    if (targetLocation.kind === 'workspace') {
      ports.emitWritten(targetLocation.absolutePath);
    }

    const stale = staleDiffFileLocation(
      baseLocation,
      editedPath,
      targetLocation,
    );
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
  });
}

/**
 * Resolve the accept target beside the base file, confirm the write, then
 * commit it via {@link commitAcceptedFile}. Returns whether the write
 * happened (false when the user declined the confirmation). Shared by the
 * desktop file actions and the VS Code compare command's replace branch; the
 * latter wraps this with its own replace-vs-copy quick pick when run
 * metadata is available.
 */
export function acceptEditedFileReplace<E>(
  baseLocation: FileLocation,
  editedLocation: FileLocation,
  ports: AcceptEditedFileReplacePorts<E>,
): Effect.Effect<
  boolean,
  E | PlatformError.PlatformError,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const editedPath = editedLocation.absolutePath;
    const target = getAcceptedFileTarget(baseLocation, editedPath);
    const { targetLocation, isNewFile } = target;
    const targetExists =
      isNewFile && (yield* fs.exists(targetLocation.absolutePath));

    const confirmed = yield* ports.confirm(
      buildAcceptConfirmMessage(
        target,
        baseLocation.absolutePath,
        editedPath,
        targetExists,
      ),
    );
    if (!confirmed) return false;

    yield* commitAcceptedFile(
      baseLocation,
      editedLocation,
      target,
      !isNewFile || targetExists,
      ports,
    );
    return true;
  });
}

/**
 * The stale `_diff` companion file a prior latexdiff run would have generated
 * for the `baseLocation` / `editedPath` pair (see {@link generateDiffFileName}),
 * sitting beside `baseLocation` — or `undefined` when accepting leaves no
 * stale diff behind:
 *
 * - `targetLocation` isn't `baseLocation` itself: a copy/sibling write (an
 *   extension mismatch resolving to a new file via {@link getAcceptedFileTarget},
 *   or an explicit "save as copy" choice) leaves the base untouched, so the
 *   diff comparing it against `editedPath` is still accurate.
 * - The derived diff location equals `targetLocation`: possible whenever
 *   `baseLocation`'s own name already matches the generated diff-name
 *   pattern for `editedPath` (e.g. accepting into a base literally named
 *   `<edited-stem>_diff.tex`, or accepting directly into a latexdiff
 *   artifact) — deleting it would delete the file just accepted.
 */
function staleDiffFileLocation(
  baseLocation: FileLocation,
  editedPath: string,
  targetLocation: FileLocation,
): FileLocation | undefined {
  if (targetLocation.absolutePath !== baseLocation.absolutePath) {
    return undefined;
  }
  const diffLocation = siblingLocation(
    baseLocation,
    generateDiffFileName(editedPath, '_diff'),
  );
  if (diffLocation.absolutePath === targetLocation.absolutePath) {
    return undefined;
  }
  return diffLocation;
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
    const original = locateInWorkspace(workspaceRoot, originalPath);
    if (original.kind === 'external') return [];
    const diffLocation = staleDiffFileLocation(original, outputPath, original);
    if (!diffLocation || diffLocation.kind === 'external') return [];
    return [diffLocation.relativePath];
  });

  // A missing or locked diff companion does not undo an accepted file, so the
  // sweep keeps every deletion that worked and names the ones that did not
  // rather than dropping them silently. `force` keeps an already-absent
  // companion a success, as the platform delete this replaced did.
  const workspaceFs = yield* WorkspaceFs;
  const settled = yield* Effect.forEach(
    stale,
    (relativePath) =>
      Effect.exit(workspaceFs.remove(relativePath, { force: true })),
    { concurrency: 'unbounded' },
  );
  const removed: string[] = [];
  for (const [index, relativePath] of stale.entries()) {
    const result = settled[index];
    if (Exit.isSuccess(result)) {
      removed.push(relativePath);
      continue;
    }
    yield* Effect.logWarning(
      `Could not remove the stale diff file ${relativePath}: ${toErrorMessage(Cause.squash(result.cause))}`,
    ).pipe(withLogChannel(CHANNEL));
  }
  return removed;
});

export function getAcceptedFileTarget(
  baseLocation: FileLocation,
  editedPath: string,
): AcceptedFileTarget {
  const basePath = baseLocation.absolutePath;
  const baseExt = getExtensionLowercase(basePath);

  if (baseExt === getExtensionLowercase(editedPath)) {
    return {
      targetLocation: baseLocation,
      targetFileName: path.basename(basePath),
      isNewFile: false,
    };
  }

  const targetFileName = path.basename(editedPath);

  return {
    targetLocation: siblingLocation(baseLocation, targetFileName),
    targetFileName,
    isNewFile: true,
  };
}
