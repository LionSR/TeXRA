/**
 * Repo file-discovery shared by the architecture ratchet tests under
 * src/test-kernel/architecture/. Each ratchet keeps its own baseline-diff and
 * AST logic; only the file-scanning plumbing lives here.
 */
import { readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect } from 'vitest';

export const REPO_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);

/** The four host production roots most architecture ratchets scan. */
export const ALL_HOST_PRODUCTION_ROOTS = [
  'packages/cli/src',
  'packages/desktop/src',
  'packages/extension/src',
  'src',
] as const;

export const SOURCE_FILE = /\.(?:ts|tsx|mts|cts)$/;

export function toRepoPath(path: string): string {
  return relative(REPO_ROOT, resolve(REPO_ROOT, path)).replaceAll('\\', '/');
}

export function sourceFilesUnder(
  dir: string,
  opts?: {
    /** Return [] instead of throwing when `dir` doesn't exist. */
    readonly missingDirReturnsEmpty?: boolean;
    /** Return repo-relative paths instead of absolute ones. */
    readonly repoRelative?: boolean;
    /** Drop files under src/test-kernel/. */
    readonly excludeTestKernel?: boolean;
  },
): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir, { recursive: true }) as string[];
  } catch (error) {
    if (opts?.missingDirReturnsEmpty) return [];
    throw error;
  }

  return entries
    .filter((entry) => SOURCE_FILE.test(entry) && !entry.endsWith('.d.ts'))
    .map((entry) => join(dir, entry))
    .filter(
      (file) =>
        !opts?.excludeTestKernel ||
        !toRepoPath(file).startsWith('src/test-kernel/'),
    )
    .map((file) => (opts?.repoRelative ? toRepoPath(file) : file));
}

/** repo-relative, test-kernel-excluded source files under `root`, missing dir -> []. */
export function productionFilesUnder(root: string): string[] {
  return sourceFilesUnder(resolve(REPO_ROOT, root), {
    missingDirReturnsEmpty: true,
    repoRelative: true,
    excludeTestKernel: true,
  });
}

/** Guards against a silently-vacuous scan across `roots` matching none of `min`. */
export function expectRealCoverage(roots: readonly string[], min = 100): void {
  const scanned = roots.reduce(
    (total, root) => total + productionFilesUnder(root).length,
    0,
  );
  expect(scanned).toBeGreaterThan(min);
}

/** Drop comments so a prose mention like "do not import from 'vscode'" can't
 *  trip a source-pattern check. Naive `//` stripping is fine here: a real
 *  import precedes any trailing comment, and cutting mid-string only matters
 *  on lines that never contain the pattern being checked for anyway. */
export function stripComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const commentStart = line.indexOf('//');
      return commentStart === -1 ? line : line.slice(0, commentStart);
    })
    .join('\n');
}
