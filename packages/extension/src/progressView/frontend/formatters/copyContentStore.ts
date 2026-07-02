/**
 * Copy content registry for progress view.
 *
 * Stores copyable content by ID to avoid duplicating large strings in DOM attributes.
 */

import { LRUCache } from 'lru-cache';

import { hashString } from './hashUtils';

const copyContentStore = new LRUCache<string, string>({ max: 1000 });

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
