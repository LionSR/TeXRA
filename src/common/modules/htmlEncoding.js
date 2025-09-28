// Third-party imports
import { encode as encodeEntities, decode as decodeEntities } from 'he';

/**
 * Encode a value for safe HTML insertion.
 * @param {unknown} value
 * @returns {string}
 */
export const encodeHtml = (value) => encodeEntities(String(value ?? ''));

/**
 * Decode an HTML-encoded string.
 * @param {unknown} value
 * @returns {string}
 */
export const decodeHtml = (value) => decodeEntities(String(value ?? ''));

/**
 * Encode a list of values for safe HTML insertion as a comma-separated string.
 * @param {unknown[]} values
 * @param {string} separator - The separator to use between values (default: ', ')
 * @returns {string}
 */
export const encodeListForHtml = (values, separator = ', ') => {
  if (!Array.isArray(values) || values.length === 0) {
    return '';
  }
  return values.map((entry) => encodeHtml(entry)).join(separator);
};
