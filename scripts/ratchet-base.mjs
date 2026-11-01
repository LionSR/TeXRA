// The commit a ratchet judges the working tree against: its merge base with
// the target branch, named by `--base <ref>` or TEXRA_RATCHET_BASE
// (origin/main by default; CI passes the pull request's target).
// check-ratchet-baselines.mjs compares the committed allowlists with the
// base's copies; check-core-quality.mjs measures the base's tree.

// Node imports
import { execFileSync } from 'node:child_process';
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
 * Every file the working tree renamed since `base`, as `[from, to]` paths.
 * The `-z` stream is records: a status, then one path, or two for a rename
 * or copy (`R`/`C` plus a score). A rename counts once it is staged.
 */
export function renamesSince(base) {
  const fields = git('diff', '--find-renames', '--name-status', '-z', base)
    .split('\0')
    .filter(Boolean);
  const renames = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i];
    const paths = /^[RC]/.test(status) ? 2 : 1;
    if (status.startsWith('R')) renames.push([fields[i + 1], fields[i + 2]]);
    i += 1 + paths;
  }
  return renames;
}
