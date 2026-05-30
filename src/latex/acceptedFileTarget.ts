// Standard library imports
import path from 'path';

// Local imports - agent
import { extractAgentSuffix } from '@agent/utils/mergeFileUtils';

// Local imports - utilities
import { getExtensionLowercase } from '@utils/core/pathCore';
import {
  createExternalLocation,
  createRunStorageLocation,
  createWorkspaceLocation,
  type FileLocation,
} from '@utils/files';

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
    ? `${baseNameWithoutExt}_${agentSuffix}${editedExt}`
    : path.basename(editedPath);

  return {
    targetLocation: siblingLocation(baseLocation, targetFileName),
    targetFileName,
    isNewFile: true,
  };
}
