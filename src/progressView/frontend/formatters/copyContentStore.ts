/**
 * Copy content registry for progress view.
 *
 * Stores copyable content by ID to avoid duplicating large strings in DOM attributes.
 */

import { hashString } from './hashUtils';

const MAX_STORE_SIZE = 1000;
const copyContentStore = new Map<string, string>();

/**
 * Register copy content and return a stable ID for lookup.
 */
export function registerCopyContent(
  content: string,
  contentId?: string,
): string {
  const id = contentId ?? `auto:${content.length}:${hashString(content)}`;
  const existing = copyContentStore.get(id);
  if (existing !== content) {
    if (existing === undefined && copyContentStore.size >= MAX_STORE_SIZE) {
      const oldest = copyContentStore.keys().next().value;
      if (oldest !== undefined) copyContentStore.delete(oldest);
    }
    copyContentStore.set(id, content);
  }
  return id;
}

/**
 * Retrieve copy content by ID.
 */
export function getCopyContent(id: string): string | undefined {
  return copyContentStore.get(id);
}

/**
 * Clear all copy content entries (called on stream delete / delete-all).
 */
export function clearCopyContentStore(): void {
  copyContentStore.clear();
}
