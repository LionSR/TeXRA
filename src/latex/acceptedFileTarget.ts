// Standard library imports
import path from 'path';

// Local imports - agent
import { extractAgentSuffix } from '@agent/utils/mergeFileUtils';

// Local imports - utilities
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

export function getAcceptedFileTarget(
  baseLocation: FileLocation,
  editedPath: string,
): AcceptedFileTarget {
  const basePath = baseLocation.absolutePath;
  const baseExt = path.extname(basePath).toLowerCase();
  const editedExt = path.extname(editedPath);

  if (baseExt === editedExt.toLowerCase()) {
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
  const targetAbsolutePath = path.join(path.dirname(basePath), targetFileName);

  if (baseLocation.kind === 'external') {
    return {
      targetLocation: createExternalLocation(targetAbsolutePath),
      targetFileName,
      isNewFile: true,
    };
  }

  const targetRelativePath = path.join(
    path.dirname(baseLocation.relativePath),
    targetFileName,
  );
  const targetLocation =
    baseLocation.kind === 'workspace'
      ? createWorkspaceLocation(targetAbsolutePath, targetRelativePath)
      : createRunStorageLocation(
          targetAbsolutePath,
          targetRelativePath,
          baseLocation.executionId,
        );

  return { targetLocation, targetFileName, isNewFile: true };
}
