/**
 * Centralized path normalization utilities.
 * Consolidates repeated path manipulation patterns across the codebase.
 */

import * as path from 'path';

/**
 * Path normalization helper that eliminates duplicated logic
 */
export class PathNormalizer {
  /**
   * Normalizes a run-relative path by removing empty segments
   * @param target The path to normalize
   * @returns Normalized path with empty segments filtered
   */
  static normalizeRunRelative(target: string): string {
    const normalized = target === '.' ? '' : target;
    if (!normalized) {
      return '';
    }
    return normalized.split(path.sep).filter(Boolean).join(path.sep);
  }

  /**
   * Checks if a path is within a given root directory
   * @param candidate The path to check
   * @param root The root directory
   * @returns True if candidate is within root
   */
  static isWithinDirectory(candidate: string, root: string): boolean {
    if (!root) {
      return false;
    }

    const normalizedRoot = path.resolve(root);
    const normalizedCandidate = path.resolve(candidate);

    if (normalizedCandidate === normalizedRoot) {
      return true;
    }

    const rootWithSep = normalizedRoot.endsWith(path.sep)
      ? normalizedRoot
      : `${normalizedRoot}${path.sep}`;

    return normalizedCandidate.startsWith(rootWithSep);
  }

  /**
   * Computes the relative path from a root directory
   * @param target The absolute path
   * @param root The root directory
   * @returns Relative path if within root, null otherwise
   */
  static getRelativePath(
    target: string,
    root: string,
  ): { relative: string; isInside: boolean } {
    if (!root || !target) {
      return { relative: '', isInside: false };
    }

    const relativeToRoot = path.relative(root, target);

    // Check if path escapes the root (starts with ..)
    const isInside =
      !relativeToRoot.startsWith('..') && !path.isAbsolute(relativeToRoot);

    return {
      relative: isInside ? relativeToRoot : '',
      isInside,
    };
  }

  /**
   * Extracts path segments after a specific directory in the path
   * @param fullPath The full path to analyze
   * @param anchorDir The directory name to find
   * @param offsetAfterAnchor Number of segments to skip after finding anchor
   * @returns Remaining path segments or null if anchor not found
   */
  static extractAfterAnchor(
    fullPath: string,
    anchorDir: string,
    offsetAfterAnchor = 0,
  ): string | null {
    const normalized = path.normalize(fullPath);
    const segments = normalized.split(path.sep).filter(Boolean);
    const anchorIndex = segments.indexOf(anchorDir);

    if (anchorIndex === -1 || segments.length < anchorIndex + offsetAfterAnchor + 1) {
      return null;
    }

    const remainder = segments.slice(anchorIndex + offsetAfterAnchor + 1);
    return remainder.length > 0 ? remainder.join(path.sep) : '';
  }

  /**
   * Decodes a path component, handling URI encoding safely
   * @param value The path component to decode
   * @returns Decoded path component, or original if decoding fails
   */
  static decodePathComponent(value: string): string {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  /**
   * Validates that a path segment is safe (no traversal, no absolute paths)
   * @param segment The path segment to validate
   * @returns True if safe, false otherwise
   */
  static isSafePathSegment(segment: string): boolean {
    if (!segment) {
      return false;
    }

    const decoded = PathNormalizer.decodePathComponent(segment);

    // Check for absolute paths
    if (path.posix.isAbsolute(segment) || path.win32.isAbsolute(segment)) {
      return false;
    }

    // Check for path separators
    const PATH_SEPARATORS = /[\\/]/;
    if (PATH_SEPARATORS.test(segment) || PATH_SEPARATORS.test(decoded)) {
      return false;
    }

    // Check for parent directory traversal
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
   * Resolves a potentially relative path to absolute, using a root directory
   * @param target The target path (may be relative or absolute)
   * @param root The root directory for resolving relative paths
   * @returns Absolute path
   */
  static resolveToAbsolute(target: string, root: string): string {
    if (!target) {
      return root;
    }

    if (path.isAbsolute(target)) {
      return path.normalize(target);
    }

    const normalized = PathNormalizer.normalizeRunRelative(target);
    return normalized.length === 0 ? root : path.join(root, normalized);
  }
}
