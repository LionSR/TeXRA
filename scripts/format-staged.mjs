#!/usr/bin/env node
// Auto-stage Prettier output for staged files, outside pre-commit's stash
// lifecycle.
//
// Why this runs outside pre-commit: pre-commit stashes unstaged changes
// around every hook it runs, and when a hook's edits collide with that stash
// it rolls back with `git checkout -- .` — restoring the working tree from
// the index. A hook that rewrites the index (`git add` after
// `prettier --write`, as attempted in #9953) turns that rollback into data
// loss: unstaged hunks survive only in a pre-commit cache patch (#9955).
//
// Instead, scripts/install-local-hooks.mjs installs this script as a plain
// git pre-commit hook chained AHEAD of pre-commit's shim. At that point no
// stash has happened: the index holds exactly the staged content and the
// working tree still holds any unstaged edits, so formatting is staged and
// merged back without ever discarding working-tree content:
//
//   1. Format each staged file's index blob (`git cat-file blob <sha>`), not
//      the working-tree file.
//   2. Stage the formatted blob (`git update-index --cacheinfo`), so the
//      commit picks up Prettier's output with no manual re-staging.
//   3. Fold the same formatting into the working tree with a three-way
//      `git merge-file` (base = staged blob). On conflict — the #9953 case,
//      where unstaged hunks overlap the reformat — the working tree is left
//      byte-identical and a notice explains how to sync. Unstaged work is
//      never overwritten.
//
// By the time pre-commit's shim runs, staged content is already formatted,
// so the `npm-format` hook makes no changes and pre-commit's stash/restore
// has nothing to conflict with. Contributors without the chained hook keep
// the previous write-and-fail behaviour; `npm run format:check` gates in CI.
//
// Formatting assistance is best-effort: this script warns and exits 0 rather
// than blocking a commit when it cannot format a file.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import prettier from 'prettier';

const NOTICE = '[format-staged]';

/** Run a git command, returning stdout as a Buffer; throw on failure. */
function git(args, { input } = {}) {
  const result = spawnSync('git', args, {
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/** Fold the staged→formatted rewrite into the working tree, if safe. */
function mergeWorktree(path, stagedBlob, formatted) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  // Unstaged deletion or a symlink replacing the file: leave the tree alone.
  if (!stat?.isFile()) return;
  const worktree = readFileSync(path);
  // Fully staged file: the rewrite applies cleanly by construction.
  if (worktree.equals(stagedBlob)) {
    writeFileSync(path, formatted);
    return;
  }
  // Unstaged edits exist. Three-way merge (base = staged blob) so they ride
  // along with the formatting; on conflict keep the working tree untouched.
  const dir = mkdtempSync(join(tmpdir(), 'format-staged-'));
  try {
    const base = join(dir, 'base');
    const ours = join(dir, 'ours');
    const theirs = join(dir, 'theirs');
    writeFileSync(base, stagedBlob);
    writeFileSync(ours, worktree);
    writeFileSync(theirs, formatted);
    // merge-file exits with the conflict count, so any nonzero status means
    // the merge is not clean and the working tree must stay as it is.
    const result = spawnSync('git', ['merge-file', '-p', ours, base, theirs], {
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status === 0) {
      writeFileSync(path, result.stdout);
    } else {
      console.log(
        `${NOTICE} ${path}: Prettier output overlaps your unstaged edits; ` +
          'kept the working-tree copy. Run `npm run format` after committing ' +
          'to sync.',
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Format one staged path's index blob and stage the result. */
async function formatStagedFile(path) {
  const entries = git(['ls-files', '-s', '-z', '--', path])
    .toString()
    .split('\0')
    .filter(Boolean);
  if (entries.length !== 1) return; // unmerged or otherwise unusual state
  const match = /^(\d{6}) ([0-9a-f]{40}) (\d)\t/.exec(entries[0]);
  if (!match) return;
  const [, mode, sha, stage] = match;
  if (stage !== '0') return; // unmerged
  if (mode !== '100644' && mode !== '100755') return; // symlink or gitlink

  const stagedBlob = git(['cat-file', 'blob', sha]);
  if (stagedBlob.includes(0)) return; // binary
  const stagedText = stagedBlob.toString('utf8');

  // Mirror the prettier CLI: apply the repo-root .prettierignore.
  const info = await prettier.getFileInfo(
    path,
    existsSync('.prettierignore') ? { ignorePath: '.prettierignore' } : {},
  );
  if (info.ignored || !info.inferredParser) return;

  const config = (await prettier.resolveConfig(path)) ?? {};
  const formatted = await prettier.format(stagedText, {
    ...config,
    filepath: path,
  });
  if (formatted === stagedText) return;

  const newSha = git(['hash-object', '-w', '--stdin'], { input: formatted })
    .toString()
    .trim();
  git(['update-index', '--cacheinfo', `${mode},${newSha},${path}`]);
  console.log(`${NOTICE} staged Prettier output for ${path}`);

  mergeWorktree(path, stagedBlob, formatted);
}

async function main() {
  const root = git(['rev-parse', '--show-toplevel']).toString().trim();
  process.chdir(root);

  // Staged conflict resolutions during a merge are left untouched.
  const mergeHead = spawnSync('git', [
    'rev-parse',
    '--verify',
    '--quiet',
    'MERGE_HEAD',
  ]);
  if (mergeHead.status === 0) return;

  const staged = git([
    'diff',
    '--cached',
    '--name-only',
    '-z',
    '--diff-filter=ACMR',
  ])
    .toString()
    .split('\0')
    .filter(Boolean);

  for (const path of staged) {
    try {
      await formatStagedFile(path);
    } catch (error) {
      console.warn(`${NOTICE} skipping ${path}: ${error.message}`);
    }
  }
}

main().catch((error) => {
  console.warn(`${NOTICE} ${error.message}`);
});
