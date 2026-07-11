// Local imports
import { isObject } from '@utils/core';

/**
 * Concatenate text out of a provider `reasoning_details` value, which may be
 * a plain string or an array of provider-specific reasoning items. Callers
 * supply `getItemText` to pull the text out of their own item shape; the
 * item's actual shape (T) is only guaranteed by the calling provider's API
 * contract, not verified here beyond "is a non-null object".
 */
export function joinReasoningItemsText<T>(
  details: unknown,
  getItemText: (item: T) => string | undefined,
): string {
  if (typeof details === 'string') return details;
  if (!Array.isArray(details)) return '';
  return details
    .filter(isObject)
    .map((item) => getItemText(item as T) ?? '')
    .join('');
}
