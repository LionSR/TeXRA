/**
 * Concatenate text out of a provider `reasoning_details` value, which may be
 * a plain string or an array of provider-specific reasoning items. Callers
 * supply `getItemText` to pull the text out of their own item shape.
 */
export function joinReasoningItemsText<T>(
  details: unknown,
  getItemText: (item: T) => string | undefined,
): string {
  if (typeof details === 'string') return details;
  if (!Array.isArray(details)) return '';
  return details
    .filter((item): item is T => !!item && typeof item === 'object')
    .map((item) => getItemText(item) ?? '')
    .join('');
}
