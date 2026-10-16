import * as path from 'node:path';

import { WORKSPACE_STORAGE_LAYOUT } from '@common/storage/storageLayout';
import { normalizeFilePath } from '@utils/core';
import { isPathWithin } from '@utils/core/pathCore';

/** The root the memory tool shows its tree under. */
export const MEMORY_DISPLAY_ROOT = '/memories';

/** How deep a directory `view` lists. */
export const DIRECTORY_LISTING_DEPTH = 2;

/** How many lines a memory preview shows. */
export const MAX_PREVIEW_LINES = 120;

/** How many characters a memory preview shows. */
export const MAX_PREVIEW_CHARS = 8000;

/** How many memories may be pinned at once. */
export const MAX_PINNED_MEMORIES = 10;

export function relativeToDisplayPath(relativePath: string): string {
  if (!relativePath) {
    return MEMORY_DISPLAY_ROOT;
  }
  return `${MEMORY_DISPLAY_ROOT}/${normalizeFilePath(relativePath)}`;
}

export function toDisplayPath(storagePath: string): string {
  const relative = path.relative(WORKSPACE_STORAGE_LAYOUT.memory, storagePath);
  return relativeToDisplayPath(relative);
}

export function displayToStoragePath(displayPath: string): string {
  if (
    displayPath !== MEMORY_DISPLAY_ROOT &&
    !displayPath.startsWith(`${MEMORY_DISPLAY_ROOT}/`)
  ) {
    throw new Error(
      `Invalid path "${displayPath}". All memory paths must start with /memories (e.g., /memories or /memories/notes.md).`,
    );
  }
  const suffix =
    displayPath === MEMORY_DISPLAY_ROOT
      ? ''
      : displayPath.slice(`${MEMORY_DISPLAY_ROOT}/`.length);
  const resolved = path.resolve(WORKSPACE_STORAGE_LAYOUT.memory, suffix);
  const base = path.resolve(WORKSPACE_STORAGE_LAYOUT.memory);
  const relative = path.relative(base, resolved);
  if (!isPathWithin(base, resolved)) {
    throw new Error(`Invalid memory path: ${displayPath}`);
  }
  // Memory paths use a forward-slash display convention regardless of host
  // platform, so normalize the storage path the same way relativeToDisplayPath
  // does (path.join on Windows would otherwise emit backslashes).
  return relative
    ? normalizeFilePath(path.join(WORKSPACE_STORAGE_LAYOUT.memory, relative))
    : WORKSPACE_STORAGE_LAYOUT.memory;
}
