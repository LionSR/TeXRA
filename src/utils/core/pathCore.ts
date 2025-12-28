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

/**
 * Get the file extension in lowercase.
 * Consolidates the common `.toLowerCase().endsWith()` pattern.
 *
 * @example
 * getExtensionLowercase('Document.TEX') // returns '.tex'
 * getExtensionLowercase('file') // returns ''
 * getExtensionLowercase('/my.project/file') // returns '' (dot is in directory, not filename)
 */
export function getExtensionLowercase(filePath: string): string {
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
