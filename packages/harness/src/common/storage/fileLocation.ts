import type { FileLocation } from '@shared/schemas';
import { locateInWorkspace } from '@utils/files/workspaceFS';

/**
 * Convert a string path to a FileLocation against the workspace root its
 * caller holds as data: `undefined` with no folder open, which resolves every
 * path as external.
 *
 * NOT run-storage aware — it can only create workspace or external locations.
 * For run-storage awareness, use `sourceLocationUnder`.
 *
 * Path normalization is handled internally - you can pass paths with either
 * forward slashes or backslashes. It's safe to pass already-normalized paths
 * (path.normalize() is idempotent).
 *
 * @param workspaceRoot - The session's workspace root
 * @param target - Absolute or workspace-relative path
 * @returns FileLocation (workspace or external, never runStorage)
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
