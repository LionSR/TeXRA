/**
 * Path normalization and utility functions.
 */

// Standard library imports
import * as path from 'path';

const PATH_SEPARATORS = /[\\/]/;

/** Convert a path to POSIX style (forward slashes). */
export function toPosixPath(relativePath: string): string {
  if (!relativePath || relativePath === '.') {
    return '.';
  }
  return relativePath
    .trim()
    .replaceAll('\\', '/')
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
  const trimmed = value?.trim();
  if (!trimmed) return '';

  const posix = toPosixPath(trimmed);
  // Strip leading ./ for LaTeX compatibility
  return posix.startsWith('./') ? posix.slice(2) : posix;
}

/**
 * Get the file extension in lowercase.
 * Internal helper for hasExtension - not exported.
 */
function getExtensionLowercase(filePath: string): string {
  if (!filePath) return '';
  return path.extname(filePath).toLowerCase();
}

/**
 * Check if a file path has a specific extension (case-insensitive).
 * Consolidates scattered `.toLowerCase().endsWith('.ext')` patterns.
 *
 * @example
 * hasExtension('paper.tex', '.tex') // true
 * hasExtension('Paper.TEX', '.tex') // true
 * hasExtension('paper.pdf', '.tex') // false
 */
export function hasExtension(filePath: string, extension: string): boolean {
  return getExtensionLowercase(filePath) === extension.toLowerCase();
}

/**
 * Join a base directory with a relative path, stripping leading/trailing slashes.
 * Used by LaTeX file extraction (figures, bibliography) to resolve relative paths.
 * Preserves absolute paths (starting with / or drive letter) without joining.
 *
 * @example
 * joinLatexPath('/project', 'figures/image.pdf') // '/project/figures/image.pdf'
 * joinLatexPath('/project', '/abs/refs') // '/abs/refs' (absolute preserved)
 */
export function joinLatexPath(baseDir: string, relativePath: string): string {
  // Preserve absolute paths (Unix / or Windows C:\)
  if (path.isAbsolute(relativePath)) {
    return path.normalize(relativePath);
  }
  const stripped = relativePath.replaceAll(/^\/+|\/+$/g, '');
  return path.normalize(path.join(baseDir, stripped));
}

/**
 * Ensure a path has a specific file extension (adds if missing).
 * Case-insensitive check using hasExtension.
 *
 * @example
 * ensureExtension('refs', '.bib') // 'refs.bib'
 * ensureExtension('refs.bib', '.bib') // 'refs.bib'
 * ensureExtension('refs.BIB', '.bib') // 'refs.BIB' (no duplicate)
 */
export function ensureExtension(filePath: string, extension: string): string {
  if (!filePath) return '';
  return hasExtension(filePath, extension)
    ? filePath
    : `${filePath}${extension}`;
}
