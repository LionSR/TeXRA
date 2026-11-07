// The commit a ratchet judges the working tree against: its merge base with
// the target branch, named by `--base <ref>` or TEXRA_RATCHET_BASE
// (origin/main by default; CI passes the pull request's target).
// check-fact-spread.mjs measures the base's tree
// (`withBaseTree`); check-row-kinds-ever.mjs reads the base's row-kind list.

// Node imports
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

/** Runs git at the repo root and returns what it printed. */
export const git = (...args) =>
  execFileSync('git', args, {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/**
 * The target ref and the commit where this tree forked from it. A target
 * git cannot find (a fresh clone without origin/main) is an error naming the
 * flag, never a pass.
 */
export function ratchetBase(ref) {
  const target = ref ?? process.env.TEXRA_RATCHET_BASE ?? 'origin/main';
  try {
    return { target, base: git('merge-base', target, 'HEAD').trim() };
  } catch (cause) {
    throw new Error(
      `no merge base between ${target} and HEAD (${String(cause.stderr ?? cause.message).trim()}); fetch ${target} and enough history, or name the branch to compare with (--base <ref> or TEXRA_RATCHET_BASE)`,
      { cause },
    );
  }
}

/**
 * `use(tree)` over the files of commit `base`, extracted into a temporary
 * directory that is removed after. The directory is given by its real path:
 * a measurement compares resolved paths with its root, and the temp
 * directory is a symlink on macOS.
 */
export async function withBaseTree(base, use) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'ratchet-base-')));
  try {
    const tar = path.join(dir, 'base.tar');
    git('archive', '--format=tar', '--output', tar, base);
    const tree = path.join(dir, 'tree');
    mkdirSync(tree);
    execFileSync('tar', ['-xf', tar, '-C', tree]);
    return await use(tree);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
