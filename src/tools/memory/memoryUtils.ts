import * as path from 'node:path';

import { relativeToRoot } from '@platform/defaults/nodeWorkspace';
import { MEMORY_STORAGE_DIR } from '@platform/defaults/workspaceStorage';
import { normalizeFilePath } from '@utils/core';

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
  // `relativeToRoot` is the shared symlink-aware containment helper (see
  // `src/tools/pathResolution.ts`): a lexical pass, then a realpath
  // comparison, so a storage dir reached through a symlink still resolves.
  const relative = relativeToRoot(MEMORY_STORAGE_DIR, resolved);
  if (relative === undefined) {
    throw new Error(`Invalid memory path: ${displayPath}`);
  }
  // Memory paths use a forward-slash display convention regardless of host
  // platform, so normalize the storage path the same way relativeToDisplayPath
  // does (path.join on Windows would otherwise emit backslashes).
  return relative
    ? normalizeFilePath(path.join(MEMORY_STORAGE_DIR, relative))
    : MEMORY_STORAGE_DIR;
}
