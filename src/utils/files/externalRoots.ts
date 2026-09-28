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
 * The agent-catalog follower every host's process runtime builds
 * (`@tools/agentCatalogFollower`) registers the agent directories; skill
 * discovery registers skill roots. The registry itself is platform-agnostic.
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
 *   gets exactly one slot, except `skill`, which holds one read-only slot per
 *   skill directory a run grants. Two different kinds may canonicalise to the
 *   same path (legitimate when a user overlays a custom dir on a built-in
 *   one) and both coexist; tiebreaking in `findExternalRoot` makes the
 *   read-only one win for permission purposes.
 * - A `skill` root belongs to the run whose step granted it: it admits only
 *   lookups made on behalf of that run, so no other run, in this project or
 *   another, reads a skill it never listed or activated. A run's grants are
 *   exactly what its latest step lists or its user activated
 *   (`grantSkillRoots`), so a skill whose plugin was disabled or lost its
 *   trust stops being readable at the next step, and they end with the run
 *   (`releaseSkillRoots`).
 */

/** Stable identifier for each registered root. Label strings are for display
 *  only and must not be used as keys. */
export type ExternalRootKind =
  'builtInWorkflow' | 'builtInToolUse' | 'custom' | 'agentDocs' | 'skill';

export interface ExternalRoot {
  /** Stable key, independent of UI text. */
  readonly kind: ExternalRootKind;
  /** Absolute, canonical filesystem path. */
  readonly absolutePath: string;
  /** Whether writes are permitted. */
  readonly writable: boolean;
  /** Human-readable label shown in workspace_info. */
  readonly label: string;
  /** A `skill` root's run, the only one it serves; other kinds serve all. */
  readonly holder?: string;
}

/** Registration options of every kind but `skill`, which runs grant. */
interface ExternalRootOptions {
  readonly kind: Exclude<ExternalRootKind, 'skill'>;
  readonly writable: boolean;
  readonly label: string;
}

export interface MatchedExternalRoot extends ExternalRoot {
  /** Path component relative to `absolutePath` (POSIX separators, '' for the root itself). */
  readonly relative: string;
}

/** Keyed by kind; a `skill` root keys by its holder and canonical path. */
const roots = new Map<string, ExternalRoot>();

/** Each holder's granted skill directories, as it last listed them. */
const grants = new Map<string, string>();

/**
 * Canonicalise a path: resolve `.`/`..` segments, then walk symlinks via
 * realpath. When the final segment does not exist yet (ENOENT / ENOTDIR) we
 * recursively canonicalise the longest existing prefix and re-append the
 * non-existent tail, so writes that create new files still match. A dangling
 * symlink on the way is followed to where it points, since that is where a
 * write through it lands.
 *
 * Throws on permission errors (EACCES/EPERM) or any unexpected error so
 * callers can fail closed: a path we cannot verify must never be admitted
 * to the allowlist. `canonicalizeWorkspacePath` is the one tolerant caller.
 *
 * Uses the JS `realpathSync`, not `.native`: on Windows the native call
 * rewrites a mapped drive to its UNC target, and the workspace identity built
 * on this function must keep the spelling the user opened.
 */
export function canonicalizePath(p: string): string {
  return canonicalizeFollowingLinks(p, 0);
}

function canonicalizeFollowingLinks(p: string, linkHops: number): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync(resolved);
  } catch (err) {
    if (!isFileNotFoundError(err) && !isNotADirectoryError(err)) {
      throw err;
    }
    // realpath fails the same way on a dangling link and on a missing entry;
    // readlink tells them apart. The hop bound matches the kernel's ELOOP.
    const target =
      isFileNotFoundError(err) && linkHops < 32
        ? readLinkOrUndefined(resolved)
        : undefined;
    if (target !== undefined) {
      return canonicalizeFollowingLinks(
        path.resolve(path.dirname(resolved), target),
        linkHops + 1,
      );
    }
    const parent = path.dirname(resolved);
    if (parent === resolved) return resolved; // reached the filesystem root
    return path.join(
      canonicalizeFollowingLinks(parent, linkHops),
      path.basename(resolved),
    );
  }
}

/** The target of `entry` when it is a symlink; `undefined` for anything else. */
function readLinkOrUndefined(entry: string): string | undefined {
  try {
    return fs.readlinkSync(entry);
  } catch {
    // EINVAL (not a link) or ENOENT (nothing there): not a dangling link.
    return undefined;
  }
}

/**
 * Register or replace the external root for the given kind. Calling again
 * with the same kind (e.g. when the custom agents dir changes) replaces
 * the previous entry for that kind in place.
 */
export function registerExternalRoot(
  absolutePath: string,
  options: ExternalRootOptions,
): void {
  if (!path.isAbsolute(absolutePath)) {
    throw new Error(
      `External root path must be absolute, got: ${absolutePath}`,
    );
  }
  // Canonicalise at registration so find-time canonicalisation lands in the
  // same space. canonicalizePath tolerates non-existent trailing segments itself
  // and only throws on permission errors or unexpected failures; per the
  // fail-closed contract in its JSDoc, let those propagate so an
  // un-verifiable path is never admitted to the allowlist. Registration is
  // setup-time and the caller already has a try/catch that surfaces a
  // meaningful error.
  const canonicalPath = canonicalizePath(absolutePath);
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
 * Make `skills` the read-only skill directories run `holder` may read,
 * replacing what it granted before; unchanged grants cost nothing.
 * Fails closed: a directory that cannot be canonicalised is not granted, and
 * the names of those are returned for the caller to report.
 */
export function grantSkillRoots(
  holder: string,
  skills: readonly { readonly name: string; readonly directory: string }[],
): string[] {
  const key = JSON.stringify(skills);
  if (grants.get(holder) === key) return [];
  releaseSkillRoots(holder);
  const refused: string[] = [];
  for (const { name, directory } of skills) {
    let absolutePath: string;
    try {
      absolutePath = canonicalizePath(directory);
    } catch {
      refused.push(name);
      continue;
    }
    roots.set(
      `skill:${holder}:${absolutePath}`,
      Object.freeze({
        kind: 'skill',
        absolutePath,
        writable: false,
        label: `Skill ${name}`,
        holder,
      }),
    );
  }
  grants.set(holder, key);
  return refused;
}

/** Withdraw every skill directory `holder` granted. */
export function releaseSkillRoots(holder: string): void {
  grants.delete(holder);
  const prefix = `skill:${holder}:`;
  for (const key of roots.keys()) if (key.startsWith(prefix)) roots.delete(key);
}

/**
 * Return the registered root that contains `absolutePath`, or null when no
 * registered root matches or the path cannot be canonicalised (fail closed).
 * `holder` is the run asking: a `skill` root another run granted, or any
 * one when no run asks, never matches.
 * Uses `path.relative` for containment so filesystem-root registrations
 * (e.g. `/` on POSIX) behave correctly, and picks the most-specific
 * registered root when multiple would match. Ties on path length prefer
 * read-only so overlapping registrations can never silently grant write
 * access.
 */
export function findExternalRoot(
  absolutePath: string,
  holder: string | undefined,
): MatchedExternalRoot | null {
  if (!path.isAbsolute(absolutePath)) return null;
  // Nothing registered means nothing can match. Checked before
  // canonicalisation so hosts that register no roots do not pay a realpath
  // syscall on every path a tool resolves.
  if (roots.size === 0) return null;

  let resolved: string;
  try {
    resolved = canonicalizePath(absolutePath);
  } catch {
    // Permission error or unexpected failure — refuse to admit the path
    // rather than approve something we cannot verify.
    return null;
  }

  let best: MatchedExternalRoot | null = null;
  for (const root of roots.values()) {
    if (
      root.kind === 'skill' &&
      (holder === undefined || root.holder !== holder)
    )
      continue;
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
