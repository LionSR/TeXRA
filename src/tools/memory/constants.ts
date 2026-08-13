export const MEMORY_DISPLAY_ROOT = '/memories';

export const MAX_VIEW_LINES = 999_999;

export const DIRECTORY_LISTING_DEPTH = 2;

export const MAX_PREVIEW_LINES = 120;

export const MAX_PREVIEW_CHARS = 8000;

export const MAX_PINNED_MEMORIES = 10;

export function shouldSkipEntry(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules';
}
