/**
 * Copy content registry for progress view.
 *
 * Stores copyable content by ID to avoid duplicating large strings in DOM attributes.
 */

// Local module state
const copyContentStore = new Map<string, string>();

function hashString(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return (hash >>> 0).toString(36);
}

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
