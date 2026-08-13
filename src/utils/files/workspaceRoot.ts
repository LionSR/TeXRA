import * as path from 'node:path';

import { normalizeFilePath } from '@utils/core';

import { findExternalRoot, type MatchedExternalRoot } from './externalRoots';

/**
 * Result of resolving a path against a workspace root.
 * 'workspace' paths live inside the root; 'external' paths do not.
 *
 * External paths may additionally match an allowlisted external root (see
 * `externalRoots.ts`). When they do, `allowed` is populated so tools can
 * operate on the path instead of rejecting it outright.
 */
export type ResolvedPath =
  | { kind: 'workspace'; absolutePath: string; relativePath: string }
  | {
      kind: 'external';
      absolutePath: string;
      allowed?: MatchedExternalRoot;
    };

/**
 * Wrap an external result with allowlist info. Returns the input unchanged
 * when the path does not match any registered external root.
 */
export function annotateExternal(resolved: {
  kind: 'external';
  absolutePath: string;
}): { kind: 'external'; absolutePath: string; allowed?: MatchedExternalRoot } {
  const match = findExternalRoot(resolved.absolutePath);
  return match ? { ...resolved, allowed: match } : resolved;
}

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
  const relativePath = path.posix.normalize(normalizeFilePath(inputPath));
  if (relativePath.startsWith('..')) {
    return annotateExternal({
      kind: 'external',
      absolutePath: path.resolve(root, inputPath),
    });
  }
  return {
    kind: 'workspace',
    absolutePath: path.join(root, relativePath),
    relativePath,
  };
}
