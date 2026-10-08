/**
 * Workspace helpers shared by every Node host: one canonical physical root
 * per workspace, symlink-aware workspace-relative paths, and the
 * environment a workspace's work sees (its `.env` over the process's).
 */
import * as path from 'node:path';

import { Context, Effect, String as Str } from 'effect';

import { normalizeFilePath } from '@utils/core';
import { isPathWithin } from '@utils/core/pathCore';
import { canonicalizePath } from '@utils/files/externalRoots';

/**
 * Resolve one physical workspace identity for storage and host adapters.
 * Missing trailing segments keep their spelling (see `canonicalizePath`). A
 * permission error is tolerated on purpose: a workspace under an unreadable
 * ancestor still opens, keyed by its resolved spelling. Every other failure
 * propagates.
 */
export function canonicalizeWorkspacePath(workspacePath: string): string {
  let canonical: string;
  try {
    canonical = canonicalizePath(workspacePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'EPERM') throw error;
    canonical = path.resolve(workspacePath);
  }
  return /^[a-z]:[\\/]/.test(canonical) ? Str.capitalize(canonical) : canonical;
}

/**
 * Symlink-aware workspace-relative path: a fast `resolve`-then-compare pass,
 * then a canonicalize-then-compare fallback for paths that resolve through a
 * symlink (e.g. a symlinked folder inside the workspace). Shared by
 * `workspaceRelativePath` and the desktop native-picker path so the two
 * stay in sync. Returns `undefined` when `filePath` resolves outside `root`;
 * the caller owns its outside-root fallback (identity vs normalized absolute).
 */
export function relativeToRoot(
  root: string,
  filePath: string,
): string | undefined {
  const resolvedRoot = path.resolve(root);
  const resolvedFilePath = path.resolve(filePath);
  if (isPathWithin(resolvedRoot, resolvedFilePath)) {
    return normalizeFilePath(path.relative(resolvedRoot, resolvedFilePath));
  }
  const canonicalRoot = canonicalizeWorkspacePath(root);
  const canonicalFilePath = canonicalizeWorkspacePath(filePath);
  return isPathWithin(canonicalRoot, canonicalFilePath)
    ? normalizeFilePath(path.relative(canonicalRoot, canonicalFilePath))
    : undefined;
}

/**
 * The variables of the project the work belongs to, from its `.env` file,
 * served over this process's own environment by
 * `workspaceEnvironmentLayer` (`nodePlatform`): to each run as it launches, and to a
 * single-project host's own reads. One process (the service) holds many
 * projects without merging any of them into `process.env`. Empty elsewhere.
 */
export const ProjectEnvironment = Context.Reference<
  Readonly<Record<string, string>>
>('@texra/ProjectEnvironment', { defaultValue: () => ({}) });

/** The environment the work in hand sees: this process's, with its
 *  project's `.env` variables over it. */
export const environment: Effect.Effect<
  Readonly<Record<string, string | undefined>>
> = Effect.gen(function* () {
  const project = yield* ProjectEnvironment;
  // Windows names are case-insensitive: the project's `PATH` replaces the
  // process's `Path` rather than standing beside it.
  const fold = (name: string) =>
    process.platform === 'win32' ? name.toUpperCase() : name;
  const named = new Set(Object.keys(project).map(fold));
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !named.has(fold(name))),
    ),
    ...project,
  };
});
