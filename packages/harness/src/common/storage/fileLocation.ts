import type { FileLocation } from '@shared/schemas';
import { locateInWorkspace } from '@utils/files/workspaceFS';

/**
 * A path's `FileLocation` against the workspace root its caller holds:
 * `workspace` when it lies inside `workspaceRoot` (an absolute path by its
 * symlink-aware relative form, a relative one read against the root with
 * either separator), `external` otherwise, never `runStorage`. With no folder
 * open (`workspaceRoot` undefined) every path is external, a relative one
 * resolved against the process's working directory, and an empty one throws.
 */
export function pathToLocationIn(
  workspaceRoot: string | undefined,
  target: string,
): FileLocation {
  const resolved = locateInWorkspace(workspaceRoot, target);

  if (resolved.kind === 'external') {
    if (!target) {
      throw new Error('Cannot resolve empty path without workspace');
    }
    return { kind: 'external', absolutePath: resolved.absolutePath };
  }

  return {
    kind: 'workspace',
    absolutePath: resolved.absolutePath,
    relativePath: resolved.relativePath,
  };
}
