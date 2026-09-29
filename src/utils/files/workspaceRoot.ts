import * as path from 'node:path';

import { normalizeFilePath } from '@utils/core';

/**
 * Result of resolving a path against a workspace root.
 * 'workspace' paths live inside the root; 'external' paths do not. Whether an
 * external path is admitted is the tool path resolver's question
 * (`resolveToolPath`), asked of the external-root allowlist for the calling
 * session's project.
 */
export type ResolvedPath =
  | { kind: 'workspace'; absolutePath: string; relativePath: string }
  | { kind: 'external'; absolutePath: string };

/**
 * Resolve a relative path against a workspace root.
 *
 * Pure path logic — no VS Code, no I/O. Paths escaping via '..' are external.
 * For absolute paths use locateInWorkspace() (symlink-aware).
 */
export function locatePathInRoot(
  root: string,
  inputPath: string,
): ResolvedPath {
  // Normalize backslashes before posix.normalize so '..' segments collapse correctly.
  // On POSIX, backslashes are valid filename chars — path.normalize would preserve them.
  const relativePath = path.posix.normalize(normalizeFilePath(inputPath));
  // `startsWith('..')` alone also matches a first segment that merely begins
  // with two dots (`..notes.tex`), which is a file inside the root. The
  // normalized path uses '/' on every platform, so match the '..' segment.
  if (relativePath === '..' || relativePath.startsWith('../')) {
    return { kind: 'external', absolutePath: path.resolve(root, inputPath) };
  }
  return {
    kind: 'workspace',
    absolutePath: path.join(root, relativePath),
    relativePath,
  };
}
