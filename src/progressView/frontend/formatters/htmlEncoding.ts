// Third-party imports
import { decode as decodeEntities, encode as encodeEntities } from 'he';

export const encodeHtml = (value: unknown): string =>
  encodeEntities(String(value ?? ''));

export const decodeHtml = (value: unknown): string =>
  decodeEntities(String(value ?? ''));

export const encodeListForHtml = (
  values: unknown[],
  separator: string = ', ',
): string => {
  if (!Array.isArray(values) || values.length === 0) {
    return '';
  }
  return values.map((entry) => encodeHtml(entry)).join(separator);
};
