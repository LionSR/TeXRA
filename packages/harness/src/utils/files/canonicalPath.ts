import * as fs from 'node:fs';
import * as path from 'node:path';

// Third-party imports
import { Predicate } from 'effect';

import { meansAbsent } from '@utils/files/fsEntryExists';

/**
 * Canonicalise a path: resolve `.`/`..` segments, then walk symlinks via
 * realpath. When the final segment does not exist yet (ENOENT / ENOTDIR) we
 * recursively canonicalise the longest existing prefix and re-append the
 * non-existent tail, so writes that create new files still match. A dangling
 * symlink on the way is followed to where it points, since that is where a
 * write through it lands.
 *
 * Throws on permission errors (EACCES/EPERM) or any unexpected error.
 * `canonicalizeWorkspaceRoot` is the one tolerant caller.
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
