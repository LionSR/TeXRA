/**
 * Repo file-discovery shared by the architecture ratchet tests under
 * src/test-kernel/architecture/. Each ratchet keeps its own baseline-diff and
 * AST logic; only the file-scanning plumbing lives here.
 */
import { readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);

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
