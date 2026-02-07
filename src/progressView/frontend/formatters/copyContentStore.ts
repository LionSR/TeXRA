/**
 * Copy content registry for progress view.
 *
 * Stores copyable content by ID to avoid duplicating large strings in DOM attributes.
 */

import { hashString } from './hashUtils';

// Local module state
const copyContentStore = new Map<string, string>();

function buildDefaultId(content: string): string {
  const normalized = content ?? '';
  return `auto:${normalized.length}:${hashString(normalized)}`;
}

/**
 * Register copy content and return a stable ID for lookup.
 */
export function registerCopyContent(
  content: string,
  contentId?: string,
): string {
  const normalized = content ?? '';
  const id = contentId ?? buildDefaultId(normalized);
  if (copyContentStore.get(id) !== normalized) {
    copyContentStore.set(id, normalized);
  }
  return id;
}

/**
 * Retrieve copy content by ID.
 */
export function getCopyContent(id: string): string | undefined {
  return copyContentStore.get(id);
}
