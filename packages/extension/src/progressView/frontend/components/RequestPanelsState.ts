// Local imports - shared utilities
import { clampIndex } from '@utils/core';

/** Keep a selected inquiry by key, choosing its nearest successor if removed. */
export function selectExternalInquiryKey(
  selectedKey: string | null,
  previousKeys: readonly string[],
  keys: readonly string[],
): string | null {
  if (keys.length === 0) return null;
  if (selectedKey && keys.includes(selectedKey)) return selectedKey;

  const previousIndex = selectedKey ? previousKeys.indexOf(selectedKey) : 0;
  const fallbackIndex = clampIndex(previousIndex, keys.length);
  return keys[fallbackIndex] ?? null;
}

export function isTextInput(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return true;
  }
  if ((el as HTMLElement).isContentEditable) return true;

  const tagName = el.tagName.toLowerCase();
  if (tagName.includes('textarea') || tagName.includes('input')) return true;

  return isTextInput(el.shadowRoot?.activeElement ?? null);
}
