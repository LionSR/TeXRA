/**
 * Copy content registry for progress view.
 *
 * Stores copyable content by ID to avoid duplicating large strings in DOM attributes.
 */

import { createContentStore } from './contentStore';

const copyContentStore = createContentStore<string>({
  max: 1000,
  prefix: 'auto',
  serialize: (content) => content,
});

/**
 * Register copy content and return a stable ID for lookup.
 */
export function registerCopyContent(
  content: string,
  contentId?: string,
): string {
  return copyContentStore.register(content, contentId);
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
