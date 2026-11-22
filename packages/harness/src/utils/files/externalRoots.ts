import * as fs from 'node:fs';
import * as path from 'node:path';

// Third-party imports
import { Predicate } from 'effect';

import { isPathWithin } from '@utils/core/pathCore';
import { meansAbsent } from '@utils/files/fsEntryExists';

/**
 * The external filesystem roots a tool call may reach: the directories its
 * run's step accepts for its own calls (`StepRoot`: a skill the step lists or
 * its user activated, read-only, or a memory folder, which its calls also
 * write). Tools like read_file, write_file, edit_file, glob and grep normally
 * refuse any path outside the workspace; a path inside one of these roots is
 * accepted according to its `writable` flag. Nothing is registered
 * process-wide: a root is gone once no step holds it.
 *
 * Security notes
 * --------------
 * - Lookup canonicalises its input (resolve, then realpath), as the step
 *   canonicalised its roots, so symlinks in a root component do not cause
 *   silent matching failures. Canonicalisation is tolerant of non-existent
 *   trailing segments and fails closed on permission errors (any EACCES/EPERM
 *   makes `findExternalRoot` return null rather than accept an un-verifiable
 *   path).
 * - A symlink inside a root that resolves outside it (e.g. at `/etc/passwd`)
 *   is NOT matched and tools reject it.
 * - Containment is tested via `path.relative`, which works correctly even
 *   for filesystem roots like `/` or `C:\`; when several roots contain a
 *   path, the most specific (longest) wins.
 */

/** A directory one step accepts for its own calls, canonical
 *  (`canonicalizePath`): a skill it lists or its user activated, read-only,
 *  or a memory folder, which its calls also write. */
export interface StepRoot {
  readonly absolutePath: string;
  readonly label: string;
  readonly writable?: boolean;
}

/** The root a path falls in, as a tool's permission check reads it. */
export interface MatchedExternalRoot extends StepRoot {
  readonly writable: boolean;
}

/**
 * Canonicalise a path: resolve `.`/`..` segments, then walk symlinks via
 * realpath. When the final segment does not exist yet (ENOENT / ENOTDIR) we
 * recursively canonicalise the longest existing prefix and re-append the
 * non-existent tail, so writes that create new files still match. A dangling
 * symlink on the way is followed to where it points, since that is where a
 * write through it lands.
 *
 * Throws on permission errors (EACCES/EPERM) or any unexpected error so
 * callers can fail closed: a path we cannot verify must never be accepted
 * to the allowlist. `canonicalizeWorkspaceRoot` is the one tolerant caller.
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
    if (!meansAbsent(err)) throw err;
    // realpath fails the same way on a dangling link and on a missing entry;
    // readlink tells them apart. The hop bound matches the kernel's ELOOP.
    const target = linkHops < 32 ? readLinkOrUndefined(resolved) : undefined;
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
  } catch (err) {
    // EINVAL (not a link), or ENOENT or ENOTDIR (nothing there): not a
    // dangling link. Anything else (EACCES, ELOOP, ...) propagates, so a
    // path that cannot be verified fails closed.
    const notALink =
      Predicate.hasProperty(err, 'code') && err.code === 'EINVAL';
    if (notALink || meansAbsent(err)) return undefined;
    throw err;
  }
}

/**
 * Return the step root that contains `absolutePath`, or null when none
 * matches or the path cannot be canonicalised (fail closed). `stepRoots` are
 * the read-only roots the asking call's step accepts; a call outside a run
 * has none. The most specific root wins.
 */
export function findExternalRoot(
  absolutePath: string,
  stepRoots: readonly StepRoot[] = [],
): MatchedExternalRoot | null {
  if (!path.isAbsolute(absolutePath)) return null;
  // Checked before canonicalisation so a lookup with nothing to match pays
  // no realpath syscall.
  if (stepRoots.length === 0) return null;

  let resolved: string;
  try {
    resolved = canonicalizePath(absolutePath);
  } catch {
    // Permission error or unexpected failure — refuse to accept the path
    // rather than approve something we cannot verify.
    return null;
  }

  let best: StepRoot | null = null;
  for (const root of stepRoots) {
    if (!isPathWithin(root.absolutePath, resolved)) continue;
    if (best === null || root.absolutePath.length > best.absolutePath.length)
      best = root;
  }
  return best === null ? null : { ...best, writable: best.writable ?? false };
}
