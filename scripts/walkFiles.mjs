// Shared recursive file listing for the repo's build/CI scripts.
//
// One primitive behind the scripts that walk a directory tree: callers supply
// an optional file filter and directory prune over the walk-relative path and
// map the result to whatever shape (relative/absolute, sorted or not) they
// report. Walk-relative paths are always '/'-joined so filters behave the
// same on Windows and Linux CI.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Recursively list files under `startDir` in depth-first readdir order.
 *
 * @param {string} startDir Directory to walk (absolute or relative).
 * @param {object} [options]
 * @param {(relativePath: string) => boolean} [options.include] File filter;
 *   defaults to keeping every file.
 * @param {(relativePath: string) => boolean} [options.prune] Directory prune;
 *   return true to skip descending into that directory.
 * @param {number} [options.limit] Stop after this many files (short-circuit).
 * @returns {Array<{ absolutePath: string, relativePath: string }>} Entries in
 *   walk order; `relativePath` is '/'-joined from `startDir` on every OS.
 */
export function walkFiles(startDir, options = {}) {
  const { include, prune, limit } = options;
  const results = [];
  const visit = (absoluteDir, relativeDir) => {
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      if (limit !== undefined && results.length >= limit) return;
      const absolutePath = path.join(absoluteDir, entry.name);
      const relativePath = relativeDir
        ? `${relativeDir}/${entry.name}`
        : entry.name;
      if (entry.isDirectory()) {
        if (prune?.(relativePath)) continue;
        visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        if (!include || include(relativePath)) {
          results.push({ absolutePath, relativePath });
        }
      }
    }
  };
  visit(startDir, '');
  return results;
}
