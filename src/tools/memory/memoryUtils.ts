import * as path from 'node:path';

import { MEMORY_STORAGE_DIR } from '@platform/defaults/workspaceStorage';
import { normalizeFilePath } from '@utils/core';
import { isPathWithin } from '@utils/core/pathCore';

import { MEMORY_DISPLAY_ROOT } from './constants';

export function relativeToDisplayPath(relativePath: string): string {
  if (!relativePath) {
    return MEMORY_DISPLAY_ROOT;
  }
  return `${MEMORY_DISPLAY_ROOT}/${normalizeFilePath(relativePath)}`;
}

export function toDisplayPath(storagePath: string): string {
  const relative = path.relative(MEMORY_STORAGE_DIR, storagePath);
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
  const resolved = path.resolve(MEMORY_STORAGE_DIR, suffix);
  const base = path.resolve(MEMORY_STORAGE_DIR);
  const relative = path.relative(base, resolved);
  if (!isPathWithin(base, resolved)) {
    throw new Error(`Invalid memory path: ${displayPath}`);
  }
  // Memory paths use a forward-slash display convention regardless of host
  // platform, so normalize the storage path the same way relativeToDisplayPath
  // does (path.join on Windows would otherwise emit backslashes).
  return relative
    ? normalizeFilePath(path.join(MEMORY_STORAGE_DIR, relative))
    : MEMORY_STORAGE_DIR;
}
