// Standard library imports
import * as path from 'path';

/**
 * Result of resolving a path against a workspace root.
 * 'workspace' paths have both absolute and forward-slash relative forms.
 * 'external' paths are outside the workspace (or no workspace is open).
 */
export type ResolvedPath =
  | { kind: 'workspace'; absolutePath: string; relativePath: string }
  | { kind: 'external'; absolutePath: string };

/**
 * Resolve a relative path against a workspace root directory.
 *
 * Pure path logic — no VS Code APIs, no file I/O.
 * Returns a discriminated union; callers apply their own policy
 * (throw on external, create ExternalFileLocation, etc.).
 *
 * NOTE: For absolute paths, prefer WorkspaceFS.locatePath() which uses
 * VS Code's symlink-aware asRelativePath(). This function uses plain
 * path.resolve/path.relative, which does NOT follow symlinks.
 */
export function locatePathInRoot(
  root: string,
  inputPath: string,
): ResolvedPath {
  if (!inputPath) {
    return {
      kind: 'workspace',
      absolutePath: root,
      relativePath: '',
    };
  }

  if (path.isAbsolute(inputPath)) {
    const normalizedInput = path.resolve(inputPath);
    const normalizedRoot = path.resolve(root);

    if (
      normalizedInput.startsWith(normalizedRoot + path.sep) ||
      normalizedInput === normalizedRoot
    ) {
      return {
        kind: 'workspace',
        absolutePath: inputPath,
        relativePath: path
          .relative(normalizedRoot, normalizedInput)
          .replaceAll('\\', '/'),
      };
    }
    return { kind: 'external', absolutePath: inputPath };
  }

  // Relative path — convert backslashes to forward slashes BEFORE normalizing
  // so that path.posix.normalize() can properly collapse '..' segments.
  // On POSIX, backslashes are valid filename characters, so path.normalize()
  // would preserve them; the subsequent replaceAll would then create new
  // path separators that could form '..' traversals bypassing the check below.
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
