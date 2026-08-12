// Node imports
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Local imports
import {
  collectReviewDiff,
  isPathInChangeSet,
  listBaseBranchCandidates,
  type CollectReviewDiffOptions,
} from '@agent/review/reviewDiff';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { setupPlatform } from '@test/support/setupPlatform';
import { executeCommand } from '@utils/system/execUtils';

setupPlatform({ workspacePath: process.cwd() }, { fs: nodeFilesystem });

async function withPlainDir(
  run: (dir: string) => Promise<void>,
): Promise<void> {
  const plain = await mkdtemp(path.join(tmpdir(), 'texra-plain-'));
  try {
    await run(plain);
  } finally {
    await rm(plain, { recursive: true, force: true });
  }
}

describe('isPathInChangeSet', () => {
  it('matches exact files and paths under changed directories', () => {
    const changed = ['src/x.ts', 'vendor'];
    expect(isPathInChangeSet(changed, 'src/x.ts')).toBe(true);
    expect(isPathInChangeSet(changed, 'b/src/x.ts')).toBe(true);
    expect(isPathInChangeSet(changed, 'vendor/lib.c')).toBe(true);
    expect(isPathInChangeSet(changed, 'unrelated.ts')).toBe(false);
    expect(isPathInChangeSet(changed, 'vendored.ts')).toBe(false);
  });
});

describe('collectReviewDiff (real git repository)', () => {
  let repo: string;

  async function git(...args: string[]): Promise<string> {
    const result = await executeCommand(['git', ...args], { cwd: repo });
    expect(result.success, `git ${args.join(' ')}: ${result.stderr}`).toBe(
      true,
    );
    return (result.stdout ?? '').trim();
  }

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'texra-review-'));
    await git('init', '-b', 'main');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test');
    // Host environments may enforce commit signing globally; the fixture
    // repo must commit without external signing helpers.
    await git('config', 'commit.gpgsign', 'false');
    await writeFile(path.join(repo, 'paper.tex'), 'original line\n');
    await git('add', '.');
    await git('commit', '-m', 'initial');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function collectDiff(options: Partial<CollectReviewDiffOptions> = {}) {
    return collectReviewDiff({
      cwd: repo,
      ...options,
    });
  }

  async function collectDiffOrFail(
    options: Partial<CollectReviewDiffOptions> = {},
  ) {
    const result = await collectDiff(options);
    if (!result.ok) {
      throw new Error(
        `expected collectReviewDiff to succeed: ${result.reason}`,
      );
    }
    return result.value;
  }

  it('diffs a feature branch against main using ordinary Git semantics', async () => {
    await git('checkout', '-b', 'feature');
    await writeFile(path.join(repo, 'paper.tex'), 'changed line\n');
    await writeFile(path.join(repo, 'scratch.txt'), 'untracked content\n');

    const value = await collectDiffOrFail();
    expect(value.baseDescription).toBe('main branch (main)');
    expect(value.diff).toContain('-original line');
    expect(value.diff).toContain('+changed line');
    expect(value.diff).not.toContain('untracked content');
    expect(value.changedFiles).toEqual(['paper.tex']);
    expect(value.truncated).toBe(false);
    expect(await realpath(value.repoRoot)).toBe(await realpath(repo));
  });

  it('ignores inherited interactive git environment variables', async () => {
    const previousPager = process.env.PAGER;
    const previousEditor = process.env.EDITOR;
    process.env.PAGER = 'less';
    process.env.EDITOR = 'vim';
    try {
      await git('checkout', '-b', 'feature');
      await writeFile(path.join(repo, 'paper.tex'), 'changed line\n');

      await collectDiffOrFail();
    } finally {
      if (previousPager === undefined) delete process.env.PAGER;
      else process.env.PAGER = previousPager;
      if (previousEditor === undefined) delete process.env.EDITOR;
      else process.env.EDITOR = previousEditor;
    }
  });

  it('falls back to the origin remote-tracking branch when no local main exists', async () => {
    // Simulate a manually added remote: origin/main exists as a tracking
    // ref, origin/HEAD is unset, and there is no local main branch.
    await git('checkout', '-b', 'feature');
    await git('update-ref', 'refs/remotes/origin/main', 'refs/heads/main');
    await git('branch', '-D', 'main');
    await writeFile(path.join(repo, 'paper.tex'), 'changed line\n');

    const value = await collectDiffOrFail();
    expect(value.baseDescription).toBe('main branch (origin/main)');
    expect(value.diff).toContain('+changed line');
  });

  it('resolves the repository root when run from a subdirectory', async () => {
    await git('checkout', '-b', 'feature');
    await mkdir(path.join(repo, 'sub'));
    await writeFile(path.join(repo, 'sub', 'note.txt'), 'original\n');
    await git('add', '.');
    await git('commit', '-m', 'add subdirectory');
    await writeFile(path.join(repo, 'sub', 'note.txt'), 'changed\n');

    const value = await collectDiffOrFail({
      cwd: path.join(repo, 'sub'),
    });
    expect(await realpath(value.repoRoot)).toBe(await realpath(repo));
    expect(value.changedFiles).toEqual(['sub/note.txt']);
  });

  it('reviews uncommitted changes when on the main branch', async () => {
    await writeFile(path.join(repo, 'paper.tex'), 'edited on main\n');

    const value = await collectDiffOrFail();
    expect(value.baseDescription).toContain('uncommitted changes');
    expect(value.diff).toContain('+edited on main');
  });

  it('reviews the latest commit when on main with a clean tree', async () => {
    await writeFile(path.join(repo, 'paper.tex'), 'committed on main\n');
    await git('commit', '-am', 'second');

    const value = await collectDiffOrFail();
    expect(value.baseDescription).toContain('latest commit');
    expect(value.diff).toContain('+committed on main');
    expect(value.diff).toContain('-original line');
  });

  it('diffs against a chosen base branch (merge-base) from the picker', async () => {
    // A second long-lived branch the user can pick as the diff base.
    await git('checkout', '-b', 'develop');
    await writeFile(path.join(repo, 'dev-only.txt'), 'develop work\n');
    await git('add', '.');
    await git('commit', '-m', 'develop work');

    await git('checkout', 'main');
    await git('checkout', '-b', 'feature');
    await writeFile(path.join(repo, 'paper.tex'), 'feature line\n');

    const value = await collectDiffOrFail({
      baseBranch: 'develop',
    });
    // Merge-base with develop is the initial commit, so develop's own work
    // is not part of the review — only the feature change is.
    expect(value.baseDescription).toBe('branch develop');
    expect(value.diff).toContain('+feature line');
    expect(value.diff).not.toContain('develop work');
    expect(value.changedFiles).toEqual(['paper.tex']);
  });

  it('diffs against an explicitly chosen remote ref even on the matching local branch', async () => {
    await git('update-ref', 'refs/remotes/origin/main', 'refs/heads/main');
    await writeFile(path.join(repo, 'notes.txt'), 'first unpushed commit\n');
    await git('add', '.');
    await git('commit', '-m', 'first unpushed');
    await writeFile(path.join(repo, 'paper.tex'), 'second unpushed commit\n');
    await git('commit', '-am', 'second unpushed');

    const value = await collectDiffOrFail({
      baseBranch: 'origin/main',
    });
    expect(value.baseDescription).toBe('branch origin/main');
    expect(value.diff).toContain('+first unpushed commit');
    expect(value.diff).toContain('+second unpushed commit');
    expect(value.changedFiles).toEqual(['notes.txt', 'paper.tex']);
  });

  it('fails clearly when the chosen base branch does not exist', async () => {
    await git('checkout', '-b', 'feature');
    const result = await collectDiff({
      baseBranch: 'no-such-branch',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('no-such-branch');
  });

  it('uses an explicit base ref for commit-triggered reviews', async () => {
    await writeFile(path.join(repo, 'notes.txt'), 'notes before\n');
    await git('add', '.');
    await git('commit', '-m', 'add notes');
    const previousHead = await git('rev-parse', 'HEAD');

    await writeFile(path.join(repo, 'paper.tex'), 'committed on main\n');
    await git('commit', '-am', 'second');
    await writeFile(path.join(repo, 'notes.txt'), 'dirty after commit\n');

    const value = await collectDiffOrFail({
      baseRef: previousHead,
      baseDescription: 'previous commit on main',
    });
    expect(value.baseRef).toBe(previousHead);
    expect(value.baseDescription).toBe('previous commit on main');
    expect(value.diff).toContain('+committed on main');
    expect(value.diff).toContain('+dirty after commit');
    expect(value.changedFiles).toEqual(['notes.txt', 'paper.tex']);
  });

  it('reports no changes on main with a clean tree and no parent commit', async () => {
    const value = await collectDiffOrFail();
    expect(value.diff).toBe('');
  });

  it('fails with a reason outside a git repository', async () => {
    await withPlainDir(async (plain) => {
      const result = await collectDiff({ cwd: plain });
      expect(result).toEqual({
        ok: false,
        reason: 'The workspace is not a git repository.',
      });
    });
  });

  it('lists local and origin branches for the picker, flagging the current one', async () => {
    await git('branch', 'develop');
    await git('update-ref', 'refs/remotes/origin/release', 'refs/heads/main');
    await git('update-ref', 'refs/remotes/origin/HEAD', 'refs/heads/main');
    await git('checkout', '-b', 'feature');

    const candidates = await listBaseBranchCandidates(repo);
    const byRef = new Map(candidates.map((c) => [c.ref, c]));
    expect([...byRef.keys()]).toEqual(
      expect.arrayContaining(['main', 'develop', 'feature', 'origin/release']),
    );
    // origin/HEAD is a symbolic alias, not a diffable branch.
    expect(byRef.has('origin/HEAD')).toBe(false);
    expect(byRef.get('feature')?.current).toBe(true);
    expect(byRef.get('main')?.current).toBe(false);
  });

  it('returns no branch candidates outside a git repository', async () => {
    await withPlainDir(async (plain) => {
      expect(await listBaseBranchCandidates(plain)).toEqual([]);
    });
  });
});
