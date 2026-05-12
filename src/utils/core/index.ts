/**
 * Core utilities - consolidated path, string, type, and async helpers.
 */

// NOTE: pathCore is NOT re-exported here because it depends on Node.js 'path'.
// This barrel is used by webview frontend code (browser context).
// Backend code should import directly: import { ... } from '@utils/core/pathCore';
export {
  isNonEmptyString,
  isString,
  escapeRegExp,
  extractErrorMessage,
  formatDuration,
  serializeError,
  type SerializedError,
} from './stringCore';
export { isObject } from './typeGuards';
export { debounce, delay } from './async';
