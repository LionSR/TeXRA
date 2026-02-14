/**
 * Virtual path resolution for storage namespaces (/memories, /executions).
 *
 * Translates virtual display paths to physical StorageFS paths and back,
 * with traversal validation. Used by grep and glob to search storage.
 */

// Standard library imports
import * as path from 'path';

// Local imports
import { EXECUTIONS_DIR } from '@agent/storage/ExecutionKVStore';
import { StorageFS } from '@utils/files';

// Local file imports
import { ToolError } from './result';
import { MEMORY_DISPLAY_ROOT, MEMORY_STORAGE_ROOT } from './memory/constants';

const EXECUTIONS_DISPLAY_ROOT = '/executions';

/** A virtual namespace mapping display prefix to storage directory. */
export interface VirtualNamespace {
  readonly display: string;
  readonly storage: string;
}

/** All supported virtual namespaces. */
const VIRTUAL_NAMESPACES: readonly VirtualNamespace[] = [
  { display: MEMORY_DISPLAY_ROOT, storage: MEMORY_STORAGE_ROOT },
  { display: EXECUTIONS_DISPLAY_ROOT, storage: EXECUTIONS_DIR },
];

/** Result of resolving a virtual path. */
export interface VirtualPathResolution {
  /** Absolute filesystem path to search. */
  absolutePath: string;
  /** The namespace this path belongs to. */
  namespace: VirtualNamespace;
}

/**
 * Try to resolve a virtual display path. Returns null if the path
 * doesn't match any virtual namespace (i.e. it's a normal workspace path).
 *
 * @throws ToolError on path traversal attempts (../)
 */
export function tryResolveVirtualPath(
  displayPath: string,
): VirtualPathResolution | null {
  for (const ns of VIRTUAL_NAMESPACES) {
    if (
      displayPath === ns.display ||
      displayPath.startsWith(`${ns.display}/`)
    ) {
      const suffix =
        displayPath === ns.display
          ? ''
          : displayPath.slice(`${ns.display}/`.length);

      // Validate against path traversal
      if (suffix) {
        const resolved = path.resolve(ns.storage, suffix);
        const base = path.resolve(ns.storage);
        const relative = path.relative(base, resolved);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new ToolError(
            `Invalid path "${displayPath}": path traversal is not allowed.`,
          );
        }
      }

      const storagePath = suffix ? path.join(ns.storage, suffix) : ns.storage;
      return {
        absolutePath: StorageFS.fullPath(storagePath),
        namespace: ns,
      };
    }
  }

  return null;
}

/**
 * Translate a physical absolute path back to a virtual display path.
 *
 * Replaces the leading `absoluteBase` prefix with the namespace's virtual
 * display prefix. Everything after the base path (colons, line numbers,
 * matched content) is preserved as-is.
 */
export function translateOutputLine(
  line: string,
  absoluteBase: string,
  namespace: VirtualNamespace,
): string {
  if (!line.startsWith(absoluteBase)) return line;

  // Replace the absolute base with the virtual prefix.
  // This is safe because we only match lines that start with the base path,
  // so we're guaranteed to be replacing the file path portion, not content.
  return namespace.display + line.slice(absoluteBase.length);
}
