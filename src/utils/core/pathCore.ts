/**
 * Path normalization and utility functions.
 */

// Standard library imports
import * as path from 'node:path';

import { normalize } from 'pathe';

/**
 * Get path segments as an array.
 * Only converts backslashes — does NOT resolve '..' so callers can detect
 * traversal attempts (e.g. AcceptRunFilesTool's `includes('..')` guard).
 */
export function getPathSegments(input: string): string[] {
  if (!input || input === '.') {
    return [];
  }
  return input.trim().replaceAll('\\', '/').split('/').filter(Boolean);
}

/** Convert a path to POSIX style (forward slashes, collapsed separators, resolved `.` and `..`). */
export function toPosixPath(relativePath: string): string {
  if (!relativePath || relativePath === '.') {
    return '.';
  }
  return normalize(relativePath.trim()).split('/').filter(Boolean).join('/');
}

/** Normalize a LaTeX \input path by trimming, converting separators, and resolving `.`/`..` segments. */
export function normalizeLatexPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return toPosixPath(trimmed);
}

/**
 * True if `target` is `base` itself or a descendant of it.
 * Computed via path.relative — works for both absolute and relative inputs
 * as long as both are resolved the same way by the caller.
 */
export function isPathWithin(base: string, target: string): boolean {
  const relativePath = path.relative(base, target);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  );
}

/**
 * True if `target` is a strict descendant of `base` (excludes `target === base`).
 */
export function isStrictlyWithin(base: string, target: string): boolean {
  const relativePath = path.relative(base, target);
  return (
    relativePath !== '' &&
    !relativePath.startsWith('..') &&
    !path.isAbsolute(relativePath)
  );
}

/** Get the file extension in lowercase (e.g. `'.tex'` for `'Paper.TEX'`). */
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
