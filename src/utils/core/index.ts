/**
 * Core utilities - centralized, reusable functions.
 *
 * This module exports consolidated utilities that replace redundant
 * implementations scattered across the codebase.
 *
 * @module core
 */

// Path utilities
export {
  normalizePath,
  toPosixPath,
  getPathSegments,
  normalizeLatexPath,
  normalizeRelativePath,
  decodePathComponent,
  isSafePathSegment,
  joinAndNormalize,
  type PathNormalizationOptions,
} from './pathCore';

// String utilities
export {
  isNonEmptyString,
  isString,
  getTrimmedOrDefault,
  getTrimmedOrUndefined,
  extractErrorMessage,
  truncateString,
  isBlank,
  normalizeWhitespace,
  safeToString,
} from './stringCore';

// Type guards
export {
  isArray,
  isContentArray,
  isTextContentItem,
  contentToString,
  ensureStringContent,
  isObject,
  isStringArray,
  hasProperty,
  hasStringProperty,
  type TextContentItem,
  type ContentItem,
  type MessageContent,
} from './typeGuards';
