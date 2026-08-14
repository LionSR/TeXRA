// Node imports
import path from 'node:path';

// Local imports
import { extractAgentSuffix } from '@latex/mergeFileUtils';
import { generateDiffFileName } from '@latex/latexdiff/diffFileNameManager';
import type { FileLocation } from '@shared/schemas';
import { normalizeFilePath } from '@utils/core';
import {
  createExternalLocation,
  createRunStorageLocation,
  createWorkspaceLocation,
} from '@utils/files/fileLocation';
import { getExtensionLowercase } from '@utils/core/pathCore';

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
    baseLocation.executionId,
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
 * Host capabilities the accept-edited commit step reaches through: writing
 * the edited content into the resolved target, notifying the host, cleaning
 * up the stale diff companion, and reporting success. Shared by every accept
 * path (replace, save-as-copy) across every host (VS Code command, desktop
 * bridge) so none of them re-implement the write / emit / cleanup / success
 * sequence.
 */
export interface CommitAcceptedFilePorts {
  readFile: (location: FileLocation) => Promise<string>;
  writeFile: (location: FileLocation, content: string) => Promise<void>;
  /** Notify the host that a workspace file was written at this absolute path. */
  emitWritten: (absolutePath: string) => void;
  showInfo: (message: string) => void | Promise<void>;
  /**
   * Remove the stale `_diff` companion file left over from the run that
   * produced `editedLocation`, if any. Errors (e.g. the file was already
   * gone) are non-fatal and should be swallowed by the port implementation.
   */
  deleteFile: (location: FileLocation) => Promise<void>;
}

/**
 * Host capabilities the accept-edited replace flow reaches through, so the
 * host-neutral orchestration can run on both the VS Code command (AbsoluteFS,
 * warning dialog, app signals) and the desktop bridge (node fs, dialog IPC)
 * without each side re-implementing the confirm / commit sequence.
 */
export interface AcceptEditedFileReplacePorts extends CommitAcceptedFilePorts {
  exists: (location: FileLocation) => Promise<boolean>;
  /** Confirm the (possibly overwriting) write; return false to abort. */
  confirm: (message: string) => Promise<boolean>;
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
 */
export async function commitAcceptedFile(
  baseLocation: FileLocation,
  editedLocation: FileLocation,
  target: { targetLocation: FileLocation; targetFileName: string },
  targetExisted: boolean,
  ports: CommitAcceptedFilePorts,
): Promise<void> {
  const { targetLocation, targetFileName } = target;
  const editedPath = editedLocation.absolutePath;

  const editedContent = await ports.readFile(editedLocation);
  await ports.writeFile(targetLocation, editedContent);
  if (targetLocation.kind === 'workspace') {
    ports.emitWritten(targetLocation.absolutePath);
  }

  await cleanupStaleDiffFile(
    baseLocation,
    editedPath,
    targetLocation,
    ports.deleteFile,
  );

  await ports.showInfo(
    buildAcceptSuccessMessage(targetFileName, editedPath, targetExisted),
  );
}

/**
 * Resolve the accept target beside the base file, confirm the write, then
 * commit it via {@link commitAcceptedFile}. Returns whether the write
 * happened (false when the user declined the confirmation). Shared by the
 * desktop file actions and the VS Code compare command's replace branch; the
 * latter wraps this with its own replace-vs-copy quick pick when run
 * metadata is available.
 */
export async function acceptEditedFileReplace(
  baseLocation: FileLocation,
  editedLocation: FileLocation,
  ports: AcceptEditedFileReplacePorts,
): Promise<boolean> {
  const editedPath = editedLocation.absolutePath;
  const target = getAcceptedFileTarget(baseLocation, editedPath);
  const { targetLocation, isNewFile } = target;
  const targetExists = isNewFile && (await ports.exists(targetLocation));

  const confirmed = await ports.confirm(
    buildAcceptConfirmMessage(
      target,
      baseLocation.absolutePath,
      editedPath,
      targetExists,
    ),
  );
  if (!confirmed) return false;

  await commitAcceptedFile(
    baseLocation,
    editedLocation,
    target,
    !isNewFile || targetExists,
    ports,
  );
  return true;
}

/**
 * Location of the stale `_diff` companion file that a prior latexdiff run
 * would have generated for the `baseLocation` / `editedPath` pair, sitting
 * beside `baseLocation`. Shared by every "accept edited content" path so the
 * diff-naming convention (see {@link generateDiffFileName}) is computed once.
 */
export function diffFileLocation(
  baseLocation: FileLocation,
  editedPath: string,
): FileLocation {
  const diffFileName = generateDiffFileName(
    baseLocation.absolutePath,
    editedPath,
    '_diff',
  );
  return siblingLocation(baseLocation, diffFileName);
}

/**
 * Delete the stale `_diff` companion file for (baseLocation, editedPath) via
 * `deleteFile`. No-ops in two cases:
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
 *
 * `deleteFile` is expected to swallow its own errors (missing/locked file);
 * this only guards against deleting content that was never stale.
 */
export async function cleanupStaleDiffFile(
  baseLocation: FileLocation,
  editedPath: string,
  targetLocation: FileLocation,
  deleteFile: (location: FileLocation) => Promise<void>,
): Promise<void> {
  if (targetLocation.absolutePath !== baseLocation.absolutePath) return;
  const diffLocation = diffFileLocation(baseLocation, editedPath);
  if (diffLocation.absolutePath === targetLocation.absolutePath) return;
  await deleteFile(diffLocation);
}

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

  const baseNameWithoutExt = path.parse(basePath).name;
  const editedNameWithoutExt = path.parse(editedPath).name;
  const agentSuffix = extractAgentSuffix(
    baseNameWithoutExt,
    editedNameWithoutExt,
  );
  const targetFileName = agentSuffix
    ? `${baseNameWithoutExt}_${agentSuffix}${path.extname(editedPath)}`
    : path.basename(editedPath);

  return {
    targetLocation: siblingLocation(baseLocation, targetFileName),
    targetFileName,
    isNewFile: true,
  };
}
