/**
 * Workspace directories that bulk file operations (formatting, cleaning,
 * packing) skip — generated artifacts and TeXRA-managed bookkeeping dirs.
 * Compared case-insensitively (lowercase entries).
 */
export const EXCLUDED_DIRS = new Set([
  'figs',
  'figures',
  'media',
  'medias',
  'build',
  'versions',
  'history',
  'notes',
  'diffs',
]);
