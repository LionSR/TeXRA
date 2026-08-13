/**
 * Shared shape behind this codebase's several filename/path-segment
 * sanitizers: replace disallowed characters, optionally collapse repeated
 * replacement runs, trim replacement characters from the edges, fall back
 * to a default when nothing survives, and optionally cap the length.
 */

import escapeRegExp from 'escape-string-regexp';

export interface SanitizePathSegmentOptions {
  /** Global regex matching characters to replace. */
  invalidCharPattern: RegExp;
  /** String to substitute for each match of `invalidCharPattern`. */
  replacement: string;
  /** Lowercase the input before sanitizing. */
  lowercase?: boolean;
  /** Collapse consecutive replacement characters into a single one. */
  collapseRepeats?: boolean;
  /** Trim leading/trailing replacement characters from the result. */
  trimReplacement?: boolean;
  /** Value to use if the result is empty after sanitization. */
  fallback?: string;
  /** Maximum length of the result, applied last. */
  maxLength?: number;
}

export function sanitizePathSegment(
  input: string,
  options: SanitizePathSegmentOptions,
): string {
  let result = options.lowercase ? input.toLowerCase() : input;
  result = result.replaceAll(options.invalidCharPattern, options.replacement);

  if (options.replacement) {
    const escaped = escapeRegExp(options.replacement);
    if (options.collapseRepeats) {
      result = result.replaceAll(
        new RegExp(`${escaped}+`, 'g'),
        options.replacement,
      );
    }
    if (options.trimReplacement) {
      result = result.replaceAll(
        new RegExp(`^(?:${escaped})+|(?:${escaped})+$`, 'g'),
        '',
      );
    }
  }

  if (!result && options.fallback) result = options.fallback;
  return options.maxLength ? result.slice(0, options.maxLength) : result;
}
