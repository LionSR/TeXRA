/**
 * Shared constants for memory tool and memory view.
 * Single source of truth for memory-related paths and limits.
 */

/** Virtual path prefix shown to users and models (e.g., /memories/notes.md) */
export const MEMORY_DISPLAY_ROOT = '/memories';

/** Physical storage path relative to workspace storage (e.g., memories/notes.md) */
export const MEMORY_STORAGE_ROOT = 'memories';

/** Maximum lines to display in tool view output */
export const MAX_VIEW_LINES = 999_999;

/** Maximum directory depth for listings */
export const DIRECTORY_LISTING_DEPTH = 2;

/** Maximum preview lines for memory view UI */
export const MAX_PREVIEW_LINES = 120;

/** Maximum preview characters for memory view UI */
export const MAX_PREVIEW_CHARS = 8000;

/**
 * Check if a directory entry should be skipped during traversal.
 */
export function shouldSkipEntry(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules';
}
