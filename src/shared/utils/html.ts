// Third-party imports
import { encode as encodeEntities, decode as decodeEntities } from 'he';

/**
 * Encode a value for safe HTML insertion.
 */
export function encodeHtml(value: unknown): string {
  return encodeEntities(String(value ?? ''));
}

/**
 * Decode an HTML-encoded string.
 */
export function decodeHtml(value: unknown): string {
  return decodeEntities(String(value ?? ''));
}

/**
 * Encode a list of values for safe HTML insertion as a separated string.
 */
export function encodeListForHtml(values: unknown[], separator = ', '): string {
  if (!Array.isArray(values) || values.length === 0) {
    return '';
  }
  return values.map((entry) => encodeHtml(entry)).join(separator);
}
