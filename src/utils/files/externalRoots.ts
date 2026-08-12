import * as fs from 'node:fs';
import * as path from 'node:path';

import { isFileNotFoundError, isNotADirectoryError } from '@common/errors';
import { isPathWithin } from '@utils/core/pathCore';

/**
 * Allowlist of external filesystem roots that tools may read or write.
 *
 * Tools like read_file, write_file, glob, and grep normally refuse any
 * path outside the workspace. Registering a root here lets those tools
 * operate on absolute paths that fall inside it, while paths outside the
 * registry keep their current "stay within the workspace" rejection.
 *
 * Registration happens in the VS Code activation layer (see frontend/setup.ts);
 * the registry itself is platform-agnostic.
 *
 * Security notes
 * --------------
 * - `registerExternalRoot` rejects non-absolute inputs so the registry cannot
 *   be seeded with process-CWD-relative values.
 * - Both register and find canonicalise inputs through the same pipeline
 *   (resolve → realpath), so symlinks in any registered root component do
 *   not cause silent matching failures. Canonicalisation is tolerant of
 *   non-existent trailing segments (essential for writes that create new
 *   files) and fails closed on permission errors (any EACCES/EPERM makes
 *   `findExternalRoot` return null rather than admit an un-verifiable path).
 * - A symlink inside a writable root that resolves outside the root (e.g.
 *   at `/etc/passwd`) is NOT matched and tools reject it.
 * - Containment is tested via `path.relative`, which works correctly even
 *   for filesystem roots like `/` or `C:\` (where `root + path.sep` would
 *   produce a bad prefix). When multiple registered roots could contain a
 *   path (nested registration), the most specific (longest) wins; ties on
 *   path length prefer read-only so a writable entry cannot silently grant
 *   write access to a directory that is also registered read-only under a
 *   different kind (e.g. if a user points the custom agents dir at the
 *   built-in agents dir).
 * - The registry keys on `ExternalRootKind`, not on the path — each kind
 *   gets exactly one slot. Two different kinds may canonicalise to the
 *   same path (legitimate when a user overlays a custom dir on a built-in
 *   one) and both coexist; tiebreaking in `findExternalRoot` makes the
 *   read-only one win for permission purposes.
 */

/** Stable identifier for each registered root. Label strings are for display
 *  only and must not be used as keys. */
export type ExternalRootKind =
  'builtInWorkflow' | 'builtInToolUse' | 'custom' | 'agentDocs';

export interface ExternalRoot {
  /** Stable key, independent of UI text. */
  readonly kind: ExternalRootKind;
  /** Absolute, canonical filesystem path. */
  readonly absolutePath: string;
  /** Whether writes are permitted. */
  readonly writable: boolean;
  /** Human-readable label shown in workspace_info. */
  readonly label: string;
}

export interface MatchedExternalRoot extends ExternalRoot {
  /** Path component relative to `absolutePath` (POSIX separators, '' for the root itself). */
  readonly relative: string;
}

const roots = new Map<ExternalRootKind, ExternalRoot>();

/**
 * Canonicalise an absolute path: resolve `.`/`..` segments, then walk
 * symlinks via realpath. When the final segment does not exist yet
 * (ENOENT / ENOTDIR) we recursively canonicalise the longest existing
 * prefix and re-append the non-existent tail — writes that create new
 * files must still match.
 *
 * Throws on permission errors (EACCES/EPERM) or any unexpected error so
 * callers can fail closed: a path we cannot verify must never be admitted
 * to the allowlist.
 */
function canonicalise(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync.native(resolved);
  } catch (err) {
    if (!isFileNotFoundError(err) && !isNotADirectoryError(err)) {
      throw err;
    }
    const parent = path.dirname(resolved);
    if (parent === resolved) return resolved; // reached the filesystem root
    return path.join(canonicalise(parent), path.basename(resolved));
  }
}

/**
 * Register or replace the external root for the given kind. Calling again
 * with the same kind (e.g. when the custom agents dir changes) replaces
 * the previous entry for that kind in place.
 */
export function registerExternalRoot(
  absolutePath: string,
  options: { kind: ExternalRootKind; writable: boolean; label: string },
): void {
  if (!path.isAbsolute(absolutePath)) {
    throw new Error(
      `External root path must be absolute, got: ${absolutePath}`,
    );
  }
  // Canonicalise at registration so find-time canonicalisation lands in the
  // same space. canonicalise tolerates non-existent trailing segments itself
  // and only throws on permission errors or unexpected failures; per the
  // fail-closed contract in its JSDoc, let those propagate so an
  // un-verifiable path is never admitted to the allowlist. Registration is
  // setup-time and the caller already has a try/catch that surfaces a
  // meaningful error.
  const canonicalPath = canonicalise(absolutePath);
  // Frozen: the registry hands these entries to tool code and to
  // `listExternalRoots`, and a mutated `writable` or `absolutePath` would
  // silently widen the allowlist for every later lookup.
  roots.set(
    options.kind,
    Object.freeze({
      kind: options.kind,
      absolutePath: canonicalPath,
      writable: options.writable,
      label: options.label,
    }),
  );
}

/**
 * Return the registered root that contains `absolutePath`, or null when no
 * registered root matches or the path cannot be canonicalised (fail closed).
 * Uses `path.relative` for containment so filesystem-root registrations
 * (e.g. `/` on POSIX) behave correctly, and picks the most-specific
 * registered root when multiple would match. Ties on path length prefer
 * read-only so overlapping registrations can never silently grant write
 * access.
 */
export function findExternalRoot(
  absolutePath: string,
): MatchedExternalRoot | null {
  if (!path.isAbsolute(absolutePath)) return null;

  let resolved: string;
  try {
    resolved = canonicalise(absolutePath);
  } catch {
    // Permission error or unexpected failure — refuse to admit the path
    // rather than approve something we cannot verify.
    return null;
  }

  let best: MatchedExternalRoot | null = null;
  for (const root of roots.values()) {
    if (!isPathWithin(root.absolutePath, resolved)) continue;

    const candidate: MatchedExternalRoot = {
      ...root,
      relative: path
        .relative(root.absolutePath, resolved)
        .replaceAll(path.sep, '/'),
    };

    // Prefer the most-specific (longest) match; on ties, prefer read-only so a
    // writable entry cannot override a colocated read-only one.
    if (
      best === null ||
      candidate.absolutePath.length > best.absolutePath.length ||
      (candidate.absolutePath.length === best.absolutePath.length &&
        best.writable &&
        !candidate.writable)
    ) {
      best = candidate;
    }
  }
  return best;
}

/** Snapshot of the current registry for display purposes. */
export function listExternalRoots(): ExternalRoot[] {
  return [...roots.values()];
}
