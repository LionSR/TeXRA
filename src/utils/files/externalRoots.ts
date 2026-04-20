import * as path from 'path';

/**
 * Allowlist of external filesystem roots that tools may read or write.
 *
 * Tools like read_file, write_file, ls, glob, and grep normally refuse any path
 * outside the workspace. Registering a root here lets those tools operate on
 * absolute paths that fall inside it, while paths outside the registry keep
 * their current "stay within the workspace" rejection.
 *
 * Registration happens in the VS Code activation layer (see frontend/setup.ts);
 * the registry itself is platform-agnostic.
 */

export interface ExternalRoot {
  /** Absolute filesystem path (symlinks resolved by caller). */
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

/** Register or replace an external root. */
export function registerExternalRoot(
  absolutePath: string,
  options: { writable: boolean; label: string },
): void {
  const key = normalise(absolutePath);
  roots.set(key, { absolutePath: key, writable: options.writable, label: options.label });
}

/** Remove a previously registered root. */
export function unregisterExternalRoot(absolutePath: string): void {
  roots.delete(normalise(absolutePath));
}

/**
 * Return the registered root that contains `absolutePath`, or null when no
 * registered root matches.
 *
 * The input must be absolute and already symlink-resolved by the caller; we
 * compare after `path.resolve` to collapse `..` segments so traversal cannot
 * escape a registered root.
 */
export function findExternalRoot(
  absolutePath: string,
): MatchedExternalRoot | null {
  if (!path.isAbsolute(absolutePath)) return null;
  const resolved = normalise(absolutePath);

  for (const root of roots.values()) {
    if (resolved === root.absolutePath) {
      return { ...root, relative: '' };
    }
    const prefix = root.absolutePath + path.sep;
    if (resolved.startsWith(prefix)) {
      const relative = resolved
        .slice(prefix.length)
        .replaceAll(path.sep, '/');
      return { ...root, relative };
    }
  }
  return null;
}

/** Snapshot of the current registry for display purposes. */
export function listExternalRoots(): ExternalRoot[] {
  return [...roots.values()];
}

/** Clear all registrations. Intended for tests. */
export function resetExternalRoots(): void {
  roots.clear();
}
