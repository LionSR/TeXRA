/**
 * Core utilities - consolidated path, string, and type helpers.
 */

export {
  toPosixPath,
  getPathSegments,
  normalizeLatexPath,
  getExtensionLowercase,
  hasExtension,
  getFilenameWithoutExtension,
} from './pathCore';
export {
  isNonEmptyString,
  isString,
  extractErrorMessage,
  serializeError,
  type SerializedError,
} from './stringCore';
export { contentToString, isObject, type MessageContent } from './typeGuards';
