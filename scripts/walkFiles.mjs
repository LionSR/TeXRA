// Shared recursive file listing for the repo's build/CI scripts.
//
// One primitive behind the scripts that walk a directory tree: callers supply
// an optional file filter over the walk-relative path and map the result to
// whatever shape (relative/absolute, sorted or not) they report. Walk-relative paths are always '/'-joined so filters behave the
// same on Windows and Linux CI.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Recursively list the files under `startDir`, dotfiles included.
 *
 * @param {string} startDir Directory to walk (absolute or relative).
 * @param {object} [options]
 * @param {(relativePath: string) => boolean} [options.include] File filter;
 *   defaults to keeping every file.
 * @returns {Array<{ absolutePath: string, relativePath: string }>} Entries in
 *   readdir order; `relativePath` is '/'-joined from `startDir` on every OS.
 */
export function walkFiles(startDir, { include } = {}) {
  return fs
    .readdirSync(startDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const absolutePath = path.join(entry.parentPath, entry.name);
      const relativePath = path
        .relative(startDir, absolutePath)
        .replaceAll(path.sep, '/');
      return { absolutePath, relativePath };
    })
    .filter(({ relativePath }) => !include || include(relativePath));
}
