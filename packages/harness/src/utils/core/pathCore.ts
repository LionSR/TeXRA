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
 * It also trims its input, so a caller that must keep a leading or trailing
 * space in a name (hidden-file and excluded-directory checks, published
 * artifact paths) cannot route through it; those call sites split on their
 * own, and each handles `..` its own way on purpose.
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

/**
 * True if a `path.relative` result climbs out of the base it was taken from.
 *
 * The `'..'` case must be matched as a whole segment: a plain
 * `startsWith('..')` also matches a first segment that merely begins with two
 * dots, so an in-root file honestly named `..notes.md` reads as an escape and
 * every containment check refuses it. Separators are the platform's, matching
 * what `path.relative` returns.
 */
export function escapesRoot(relativePath: string): boolean {
  return relativePath === '..' || relativePath.startsWith(`..${path.sep}`);
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
    (!escapesRoot(relativePath) && !path.isAbsolute(relativePath))
  );
}

/**
 * True if `target` is a strict descendant of `base` (excludes `target === base`).
 */
export function isStrictlyWithin(base: string, target: string): boolean {
  const relativePath = path.relative(base, target);
  return (
    relativePath !== '' &&
    !escapesRoot(relativePath) &&
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
 * hasExtension('notes.md', '.md') // true
 * hasExtension('Notes.MD', '.md') // true
 * hasExtension('notes.pdf', '.md') // false
 */
export function hasExtension(filePath: string, extension: string): boolean {
  return getExtensionLowercase(filePath) === extension.toLowerCase();
}
