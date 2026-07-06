/**
 * Core utilities - consolidated path, string, type, and async helpers.
 */

// NOTE: pathCore is NOT re-exported here because it depends on Node.js 'path'.
// This barrel is used by webview frontend code (browser context).
// Backend code should import directly: import { ... } from '@utils/core/pathCore';
//
// String validation/formatting primitives live in @utils/text/stringUtils
// (the single home for generic string helpers) and are re-exported here for
// existing @utils/core consumers.
export {
  isNonEmptyString,
  isString,
  formatCompactDuration,
  formatCompactTokenCount,
  formatDuration,
  serializeError,
} from '../text/stringUtils';
export {
  isObject,
  isFiniteNumber,
  filterNotNull,
  filterNotNullish,
  ensureArray,
  unique,
  assertNever,
} from './typeGuards';
export {
  debounce,
  delay,
  createFlushableDebounce,
  type FlushableDebounce,
} from './async';
export { byName, byString, toNewestFirstByTimestamp } from './comparators';
export { clamp, clampIndex, clampOptional, roundTo } from './math';
export { tryParseUrl } from './urlCore';
