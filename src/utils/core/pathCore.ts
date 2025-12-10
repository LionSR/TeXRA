/**
 * Path normalization utilities.
 */

const PATH_SEPARATORS = /[\\/]/;

/** Convert a path to POSIX style (forward slashes). */
export function toPosixPath(relativePath: string): string {
  if (!relativePath || relativePath === '.') {
    return '.';
  }
  return relativePath
    .trim()
    .replace(/\\/g, '/')
    .split(PATH_SEPARATORS)
    .filter(Boolean)
    .join('/');
}

/** Get path segments as an array. */
export function getPathSegments(input: string): string[] {
  if (!input || input === '.') {
    return [];
  }
  return toPosixPath(input).split('/').filter(Boolean);
}

/** Normalize a path for LaTeX \input commands (strips leading ./). */
export function normalizeLatexPath(value: string): string {
  if (!value) {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  const posix = toPosixPath(trimmed);
  // Strip leading ./ for LaTeX compatibility
  return posix.startsWith('./') ? posix.slice(2) : posix;
}
