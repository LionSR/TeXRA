/**
 * The repo root, and the production source files under it, for tests that
 * read the repository from disk.
 */
import { existsSync, readdirSync } from 'node:fs';
import { posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);

/** Every workspace package's `src`, derived from the tree, so a new package is covered the day it lands. */
export function productionRoots(): string[] {
  return readdirSync(resolve(REPO_ROOT, 'packages'))
    .filter((name) => existsSync(resolve(REPO_ROOT, 'packages', name, 'src')))
    .map((name) => posix.join('packages', name, 'src'))
    .toSorted((a, b) => a.localeCompare(b));
}

/** Repo-relative TypeScript source files under `root`, declarations excluded. A missing directory throws, so a scan never passes by reading nothing. */
export function productionFilesUnder(root: string): string[] {
  return readdirSync(resolve(REPO_ROOT, root), {
    recursive: true,
    encoding: 'utf8',
  })
    .filter(
      (entry) =>
        /\.(?:ts|tsx|mts|cts)$/.test(entry) && !entry.endsWith('.d.ts'),
    )
    .map((entry) =>
      relative(REPO_ROOT, resolve(REPO_ROOT, root, entry)).replaceAll(
        '\\',
        '/',
      ),
    );
}
