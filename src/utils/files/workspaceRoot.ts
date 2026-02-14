import * as path from 'path';

/**
 * Result of resolving a path against a workspace root.
 * 'workspace' paths live inside the root; 'external' paths do not.
 */
export type ResolvedPath =
  | { kind: 'workspace'; absolutePath: string; relativePath: string }
  | { kind: 'external'; absolutePath: string };

/**
 * Resolve a relative path against a workspace root.
 *
 * Pure path logic — no VS Code, no I/O. Paths escaping via '..' are external.
 * For absolute paths use WorkspaceFS.locatePath() (symlink-aware).
 */
export function locatePathInRoot(
  root: string,
  inputPath: string,
): ResolvedPath {
  // Normalize backslashes before posix.normalize so '..' segments collapse correctly.
  // On POSIX, backslashes are valid filename chars — path.normalize would preserve them.
  const relative = path.posix.normalize(inputPath.replaceAll('\\', '/'));
  if (relative.startsWith('..')) {
    return {
      kind: 'external',
      absolutePath: path.resolve(root, inputPath),
    };
  }
  return {
    kind: 'workspace',
    absolutePath: path.join(root, relative),
    relativePath: relative,
  };
}
