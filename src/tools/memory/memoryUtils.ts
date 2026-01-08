/**
 * Shared utilities for memory tool and memory view.
 */
import * as path from 'path';

import { MEMORY_DISPLAY_ROOT, MEMORY_STORAGE_ROOT } from './constants';

/**
 * Convert a storage path to a display path.
 * @param storagePath - Path relative to storage root (e.g., "memories/notes.md")
 * @returns Display path with virtual prefix (e.g., "/memories/notes.md")
 */
export function toDisplayPath(storagePath: string): string {
  const relative = path.relative(MEMORY_STORAGE_ROOT, storagePath);
  if (!relative || relative === '') {
    return MEMORY_DISPLAY_ROOT;
  }
  const normalized = relative.split(path.sep).join('/');
  return `${MEMORY_DISPLAY_ROOT}/${normalized}`;
}

/**
 * Convert a relative path (within memories) to a display path.
 * @param relativePath - Path relative to memories folder (e.g., "notes.md")
 * @returns Display path with virtual prefix (e.g., "/memories/notes.md")
 */
export function relativeToDisplayPath(relativePath: string): string {
  if (!relativePath) {
    return MEMORY_DISPLAY_ROOT;
  }
  const normalized = relativePath.split(path.sep).join('/');
  return `${MEMORY_DISPLAY_ROOT}/${normalized}`;
}

/**
 * Format bytes to human-readable size string.
 * @param bytes - Size in bytes
 * @returns Formatted string (e.g., "1.5K", "2.3M")
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }

  const units = ['K', 'M', 'G', 'T'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)}${units[unitIndex]}`;
}

/**
 * Validate and resolve a storage path, ensuring it stays within MEMORY_STORAGE_ROOT.
 * @param storagePath - Path to validate (should be within memories/)
 * @returns Resolved path within MEMORY_STORAGE_ROOT
 * @throws Error if path escapes the memory storage root
 */
export function resolveMemoryStoragePath(storagePath: string): string {
  const normalized = path.normalize(storagePath);
  const relative = path.relative(MEMORY_STORAGE_ROOT, normalized);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Invalid memory path: ${storagePath}`);
  }
  return path.join(MEMORY_STORAGE_ROOT, relative);
}

/**
 * Convert a display path to a storage path.
 * @param displayPath - Virtual path (e.g., "/memories/notes.md")
 * @returns Storage path (e.g., "memories/notes.md")
 * @throws Error if path is outside the memory namespace
 */
export function displayToStoragePath(displayPath: string): string {
  if (
    displayPath !== MEMORY_DISPLAY_ROOT &&
    !displayPath.startsWith(`${MEMORY_DISPLAY_ROOT}/`)
  ) {
    throw new Error(
      `The path ${displayPath} does not exist. Please provide a valid path.`,
    );
  }
  const suffix =
    displayPath === MEMORY_DISPLAY_ROOT
      ? ''
      : displayPath.slice(`${MEMORY_DISPLAY_ROOT}/`.length);
  const resolved = path.resolve(MEMORY_STORAGE_ROOT, suffix);
  const base = path.resolve(MEMORY_STORAGE_ROOT);
  if (!resolved.startsWith(`${base}${path.sep}`) && resolved !== base) {
    throw new Error(
      `The path ${displayPath} does not exist. Please provide a valid path.`,
    );
  }
  const relative = path.relative(base, resolved);
  return relative
    ? path.join(MEMORY_STORAGE_ROOT, relative)
    : MEMORY_STORAGE_ROOT;
}
