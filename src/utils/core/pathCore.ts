/**
 * Centralized path normalization utilities.
 *
 * This module provides a single source of truth for all path normalization
 * operations, eliminating redundant implementations across the codebase.
 *
 * @module pathCore
 */

import * as path from 'path';

const PATH_SEPARATORS = /[\\/]/;

/**
 * Options for path normalization.
 */
export interface PathNormalizationOptions {
  /** Convert to forward slashes (POSIX style). Default: true */
  toPosix?: boolean;
  /** Preserve leading './' if present. Default: false */
  preserveLeadingDot?: boolean;
  /** Filter out empty segments. Default: true */
  removeEmpty?: boolean;
}

/**
 * Normalize a path string with configurable options.
 *
 * This is the core normalization function that all other path utilities
 * should delegate to for consistency.
 *
 * @param input - The path string to normalize
 * @param options - Normalization options
 * @returns Normalized path string
 *
 * @example
 * normalizePath('sub\\dir//file.tex') // 'sub/dir/file.tex'
 * normalizePath('./sub/dir/', { preserveLeadingDot: true }) // './sub/dir'
 */
export function normalizePath(
  input: string,
  options: PathNormalizationOptions = {},
): string {
  if (!input) {
    return '';
  }

  if (input === '.') {
    return options.preserveLeadingDot ? '.' : '';
  }

  const { toPosix = true, preserveLeadingDot = false, removeEmpty = true } =
    options;

  // Trim whitespace
  let result = input.trim();
  if (!result) {
    return '';
  }

  // Track if it had a leading dot-slash
  const hadLeadingDot = result.startsWith('./') || result.startsWith('.\\');

  // Normalize separators
  if (toPosix) {
    result = result.replace(/\\/g, '/');
  }

  // Split, optionally filter, and rejoin
  const separator = toPosix ? '/' : path.sep;
  const segments = result.split(PATH_SEPARATORS);
  const filtered = removeEmpty ? segments.filter(Boolean) : segments;
  const joined = filtered.join(separator);

  // Restore leading dot if requested and it was present
  if (preserveLeadingDot && hadLeadingDot && joined && !joined.startsWith('.')) {
    return `.${separator}${joined}`;
  }

  return joined;
}

/**
 * Convert a path to POSIX style (forward slashes).
 *
 * Keeps '.' as-is for the workspace root.
 *
 * @param relativePath - The path to convert
 * @returns POSIX-style path string
 */
export function toPosixPath(relativePath: string): string {
  if (!relativePath || relativePath === '.') {
    return '.';
  }
  return normalizePath(relativePath, { toPosix: true });
}

/**
 * Get path segments as an array.
 *
 * @param input - The path string to split
 * @returns Array of non-empty path segments
 *
 * @example
 * getPathSegments('sub/dir/file.tex') // ['sub', 'dir', 'file.tex']
 */
export function getPathSegments(input: string): string[] {
  if (!input || input === '.') {
    return [];
  }
  return normalizePath(input, { toPosix: true }).split('/').filter(Boolean);
}

/**
 * Normalize a path for LaTeX \input commands.
 *
 * Converts to POSIX style and removes leading './'.
 *
 * @param value - The path to normalize
 * @returns Normalized path suitable for LaTeX
 */
export function normalizeLatexPath(value: string): string {
  if (!value) {
    return '';
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  // Use POSIX normalization, strip leading ./
  const normalized = normalizePath(trimmed, {
    toPosix: true,
    preserveLeadingDot: false,
  });

  return normalized;
}

/**
 * Normalize a workspace-relative path.
 *
 * Handles '.' as empty string for the workspace root.
 *
 * @param target - The target path
 * @returns Normalized relative path
 */
export function normalizeRelativePath(target: string): string {
  if (!target || target === '.') {
    return '';
  }
  return normalizePath(target, { toPosix: false, removeEmpty: true });
}

/**
 * Decode a URI-encoded path component safely.
 *
 * @param value - The encoded value
 * @returns Decoded value, or original if decoding fails
 */
export function decodePathComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Check if a path segment is safe (no traversal attacks).
 *
 * @param segment - The segment to check
 * @returns true if the segment is safe
 */
export function isSafePathSegment(segment: string): boolean {
  if (!segment) {
    return false;
  }

  const decoded = decodePathComponent(segment);

  // Reject absolute paths
  if (path.posix.isAbsolute(segment) || path.win32.isAbsolute(segment)) {
    return false;
  }

  // Reject path separators in segment
  if (PATH_SEPARATORS.test(segment) || PATH_SEPARATORS.test(decoded)) {
    return false;
  }

  // Reject directory traversal
  const normalized = path.normalize(decoded);
  if (
    normalized.startsWith('..') ||
    normalized.includes(`..${path.sep}`) ||
    normalized === '..' ||
    decoded.includes('..')
  ) {
    return false;
  }

  return true;
}

/**
 * Join path segments and normalize the result.
 *
 * @param segments - Path segments to join
 * @returns Joined and normalized path
 */
export function joinAndNormalize(...segments: string[]): string {
  const joined = segments.filter(Boolean).join('/');
  return normalizePath(joined, { toPosix: true });
}
