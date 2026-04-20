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
 * - `findExternalRoot` resolves real paths before matching, so a symlink
 *   inside a writable root that points outside the root (e.g. at
 *   `/etc/passwd`) will NOT match and tools will reject it.
 * - Containment is tested via `path.relative`, which works correctly even
 *   for filesystem roots like `/` or `C:\` (where `root + path.sep` would
 *   produce a bad prefix).
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

function normalise(absolutePath: string): string {
  return path.resolve(absolutePath);
}

/**
 * Resolve a path through any intermediate symlinks. Falls back gracefully
 * when the path (or a trailing segment) does not exist yet — essential for
 * write operations that create new files. The longest existing prefix is
 * realpath-resolved; the non-existent tail is re-appended unchanged.
 */
function resolveRealPath(p: string): string {
  try {
    return fs.realpathSync.native
      ? fs.realpathSync.native(p)
      : fs.realpathSync(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      // Permissions or other error — fall back to the caller-supplied path so
      // downstream logic can surface a meaningful error instead of us
      // silently approving an unresolvable location.
      return p;
    }
    const parent = path.dirname(p);
    if (parent === p) return p; // reached the filesystem root
    const base = path.basename(p);
    return path.join(resolveRealPath(parent), base);
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
  const key = normalise(absolutePath);
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
  roots.delete(normalise(absolutePath));
}

/**
 * Return the registered root that contains `absolutePath`, or null when no
 * registered root matches. Uses `path.relative` for containment so
 * filesystem-root registrations (e.g. `/` on POSIX) behave correctly, and
 * picks the most-specific registered root when multiple would match.
 *
 * Symlinks are resolved before matching. An allowlisted-looking path that
 * actually symlinks outside the root is rejected.
 */
export function findExternalRoot(
  absolutePath: string,
): MatchedExternalRoot | null {
  if (!path.isAbsolute(absolutePath)) return null;
  const normalised = normalise(absolutePath);
  const resolved = resolveRealPath(normalised);

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

/** Clear all registrations. Intended for tests. */
export function resetExternalRoots(): void {
  roots.clear();
}
