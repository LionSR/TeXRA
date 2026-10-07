/**
 * LaTeX subsystem runtime constants: build/viewer timing delays and the
 * workspace directories bulk file operations skip. Split out of the old
 * `@shared/constants/latex` dumping ground.
 */

/** Delay before registering a diff document for side-by-side view. */
export const DIFF_REGISTRATION_DELAY_MS = 300;

/** Delay before auto-opening the LaTeX viewer after build. */
export const LATEX_VIEWER_OPEN_DELAY_MS = 5000;

/** Delay before refreshing the LaTeX viewer after build. */
export const LATEX_VIEWER_REFRESH_DELAY_MS = 5000;

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
