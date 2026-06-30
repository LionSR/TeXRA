// Standard library imports
import path from 'node:path';

// Local imports - agent
import { extractAgentSuffix } from '@agent/utils/mergeFileUtils';

// Local imports - utilities
import type { FileLocation } from '@shared/schemas';
import {
  createExternalLocation,
  createRunStorageLocation,
  createWorkspaceLocation,
} from '@utils/files';
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
  const targetRelativePath = path.join(
    path.dirname(baseLocation.relativePath),
    targetFileName,
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
export function buildAcceptConfirmMessage(
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
export function buildAcceptSuccessMessage(
  targetFileName: string,
  editedPath: string,
  replaced: boolean,
): string {
  const operation = replaced ? 'replaced' : 'created';
  return `Successfully ${operation} '${targetFileName}' with content from '${path.basename(editedPath)}'`;
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
