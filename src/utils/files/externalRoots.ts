import * as fs from 'fs';
import * as path from 'path';

/**
 * Allowlist of external filesystem roots that tools may read or write.
 *
 * Tools like read_file, write_file, ls, glob, and grep normally refuse any
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
 *   path (nested registration), the most specific (longest) wins so
 *   read-only children defeat writable parents.
 */

/** Stable identifier for each registered root — keyed off by callers that need
 *  to locate a specific root (e.g. template-variable injection). Label strings
 *  are for display only and must not be used as keys. */
export type ExternalRootKind =
  | 'builtInWorkflow'
  | 'builtInToolUse'
  | 'custom'
  | 'agentDocs';

export interface ExternalRoot {
  /** Stable key, independent of UI text. */
  kind: ExternalRootKind;
  /** Absolute, canonical filesystem path. */
  absolutePath: string;
  /** Whether writes are permitted. */
  writable: boolean;
  /** Human-readable label shown in workspace_info. */
  label: string;
}

export interface MatchedExternalRoot extends ExternalRoot {
  /** Path component relative to `absolutePath` (POSIX separators, '' for the root itself). */
  relative: string;
}

const roots = new Map<string, ExternalRoot>();

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
    return fs.realpathSync.native
      ? fs.realpathSync.native(resolved)
      : fs.realpathSync(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      throw err;
    }
    const parent = path.dirname(resolved);
    if (parent === resolved) return resolved; // reached the filesystem root
    const base = path.basename(resolved);
    return path.join(canonicalise(parent), base);
  }
}

/** Register or replace an external root. */
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
  // same space. Falls back to path.resolve only on canonicalise failure —
  // registration is setup-time and the caller already has a try/catch that
  // will surface a meaningful error.
  let key: string;
  try {
    key = canonicalise(absolutePath);
  } catch {
    key = path.resolve(absolutePath);
  }
  roots.set(key, {
    kind: options.kind,
    absolutePath: key,
    writable: options.writable,
    label: options.label,
  });
}

/** Remove a previously registered root. */
export function unregisterExternalRoot(absolutePath: string): void {
  if (!path.isAbsolute(absolutePath)) {
    throw new Error(
      `External root path must be absolute, got: ${absolutePath}`,
    );
  }
  // Try both canonical and raw keys so callers can unregister with the same
  // path they passed to register, even if canonicalisation was partial.
  let canonicalKey: string | undefined;
  try {
    canonicalKey = canonicalise(absolutePath);
  } catch {
    // fall through to raw key only
  }
  if (canonicalKey !== undefined) {
    roots.delete(canonicalKey);
  }
  roots.delete(path.resolve(absolutePath));
}

/**
 * Return the registered root that contains `absolutePath`, or null when no
 * registered root matches or the path cannot be canonicalised (fail closed).
 * Uses `path.relative` for containment so filesystem-root registrations
 * (e.g. `/` on POSIX) behave correctly, and picks the most-specific
 * registered root when multiple would match.
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
    const relativePath = path.relative(root.absolutePath, resolved);
    const contained =
      relativePath === '' ||
      (!relativePath.startsWith('..') &&
        relativePath !== '..' &&
        !path.isAbsolute(relativePath));
    if (!contained) continue;

    if (best === null || root.absolutePath.length > best.absolutePath.length) {
      best = {
        ...root,
        relative: relativePath.replaceAll(path.sep, '/'),
      };
    }
  }
  return best;
}

/** Snapshot of the current registry for display purposes. */
export function listExternalRoots(): ExternalRoot[] {
  return [...roots.values()];
}
