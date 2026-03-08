import * as path from 'path';

/**
 * Virtual path registry — maps display prefixes (e.g., `/agents/builtin`)
 * to real filesystem directories. Tools resolve virtual paths through this
 * registry before performing file I/O, enabling access to directories
 * outside the workspace (agent directories, extension resources, etc.).
 *
 * The registry itself is VS Code-free; registration is called from the
 * VS Code activation layer in `src/frontend/setup.ts`.
 */

export interface VirtualPathEntry {
  /** Absolute filesystem path this prefix maps to. */
  absolutePath: string;
  /** Whether writes are allowed (false for built-in dirs). */
  writable: boolean;
  /** Human-readable description for system prompt display. */
  description: string;
}

export interface ResolvedVirtualPath {
  /** Absolute filesystem path after resolution. */
  absolutePath: string;
  /** Whether the target directory is writable. */
  writable: boolean;
  /** The original virtual display path (normalized). */
  displayPath: string;
}

const registry = new Map<string, VirtualPathEntry>();

/**
 * Register a virtual path prefix.
 * @param displayPrefix - Virtual prefix WITHOUT trailing slash (e.g., `/agents/builtin`)
 * @param entry - Target directory info
 */
export function registerVirtualPath(
  displayPrefix: string,
  entry: VirtualPathEntry,
): void {
  // Normalize: strip trailing slash, ensure leading slash
  const normalized = '/' + displayPrefix.replaceAll(/^\/+|\/+$/g, '');
  registry.set(normalized, entry);
}

/**
 * Remove a virtual path prefix.
 */
export function unregisterVirtualPath(displayPrefix: string): void {
  const normalized = '/' + displayPrefix.replaceAll(/^\/+|\/+$/g, '');
  registry.delete(normalized);
}

/**
 * Resolve a tool input path against the virtual path registry.
 * Returns null if the path doesn't match any registered prefix.
 *
 * @param inputPath - Path from tool input (e.g., `/agents/builtin/polish.yaml`)
 * @returns Resolved path info or null
 */
export function resolveVirtualPath(
  inputPath: string,
): ResolvedVirtualPath | null {
  if (!inputPath.startsWith('/')) return null;

  for (const [prefix, entry] of registry) {
    if (inputPath === prefix || inputPath.startsWith(prefix + '/')) {
      const suffix =
        inputPath === prefix ? '' : inputPath.slice(prefix.length + 1);

      // Resolve and normalize the absolute path
      const absolutePath = suffix
        ? path.resolve(entry.absolutePath, suffix)
        : entry.absolutePath;

      // Prevent path traversal escaping the virtual root
      const normalizedBase = path.resolve(entry.absolutePath);
      if (
        absolutePath !== normalizedBase &&
        !absolutePath.startsWith(normalizedBase + path.sep)
      ) {
        return null;
      }

      return {
        absolutePath,
        writable: entry.writable,
        displayPath: inputPath,
      };
    }
  }

  return null;
}

/**
 * Get descriptions of all registered virtual paths.
 * Used by the system prompt builder to inform the model.
 */
export function getVirtualPathDescriptions(): Array<{
  prefix: string;
  description: string;
  writable: boolean;
}> {
  return [...registry.entries()].map(([prefix, entry]) => ({
    prefix,
    description: entry.description,
    writable: entry.writable,
  }));
}

/**
 * Clear all registrations.
 * @internal For testing only.
 */
export function resetVirtualPaths(): void {
  registry.clear();
}
