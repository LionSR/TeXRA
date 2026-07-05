// Standard library imports
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Local imports
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { setupPlatform } from '@test/support/setupPlatform';
import {
  buildUntrackedFileDiff,
  collectReviewDiff,
  isPathInChangeSet,
  listBaseBranchCandidates,
} from '@agent/review/reviewDiff';
import { executeCommand } from '@utils/system/execUtils';

setupPlatform({ workspacePath: process.cwd() }, { fs: nodeFilesystem });

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

describe('buildUntrackedFileDiff', () => {
  it('renders text content as an added-lines pseudo-diff', () => {
    const diff = buildUntrackedFileDiff('notes.txt', Buffer.from('one\ntwo\n'));
    expect(diff).toContain('diff --git a/notes.txt b/notes.txt');
    expect(diff).toContain('new file (untracked)');
    expect(diff).toContain('@@ -0,0 +1,2 @@');
    expect(diff).toContain('+one\n+two');
  });

  it('marks binary content without dumping bytes', () => {
    const diff = buildUntrackedFileDiff(
      'store/index.db',
      Buffer.from([0x53, 0x51, 0x00, 0x69]),
    );
    expect(diff).toContain('Binary file store/index.db added');
    expect(diff).not.toContain('@@');
  });

  it('marks empty files', () => {
    expect(buildUntrackedFileDiff('empty.txt', Buffer.alloc(0))).toContain(
      '(empty file)',
    );
  });

  it('truncates very long files', () => {
    const content = Buffer.from(
      Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n'),
    );
    const diff = buildUntrackedFileDiff('big.txt', content);
    expect(diff).toContain('+line 399');
    expect(diff).not.toContain('+line 400');
    expect(diff).toContain('[... big.txt truncated]');
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

  it('diffs a feature branch against main and includes untracked files', async () => {
    await git('checkout', '-b', 'feature');
    await writeFile(path.join(repo, 'paper.tex'), 'changed line\n');
    await writeFile(path.join(repo, 'scratch.txt'), 'untracked content\n');

    const result = await collectReviewDiff({
      cwd: repo,
      includeUntracked: true,
      includeSubmodules: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.baseDescription).toBe('main branch (main)');
    expect(result.value.diff).toContain('-original line');
    expect(result.value.diff).toContain('+changed line');
    expect(result.value.diff).toContain('+untracked content');
    expect(result.value.changedFiles).toEqual(['paper.tex', 'scratch.txt']);
    expect(result.value.truncated).toBe(false);
    expect(await realpath(result.value.repoRoot)).toBe(await realpath(repo));
  });

  it('ignores inherited interactive git environment variables', async () => {
    const previousPager = process.env.PAGER;
    const previousEditor = process.env.EDITOR;
    process.env.PAGER = 'less';
    process.env.EDITOR = 'vim';
    try {
      await git('checkout', '-b', 'feature');
      await writeFile(path.join(repo, 'paper.tex'), 'changed line\n');

      const result = await collectReviewDiff({
        cwd: repo,
        includeUntracked: false,
        includeSubmodules: true,
      });
      expect(result.ok).toBe(true);
    } finally {
      if (previousPager === undefined) delete process.env.PAGER;
      else process.env.PAGER = previousPager;
      if (previousEditor === undefined) delete process.env.EDITOR;
      else process.env.EDITOR = previousEditor;
    }
  });

  it('caps oversized untracked files at a bounded prefix with a truncation marker', async () => {
    await git('checkout', '-b', 'feature');
    // Larger than MAX_UNTRACKED_FILE_BYTES (200 KB); only a prefix may load.
    await writeFile(
      path.join(repo, 'big.txt'),
      `start-of-big-file\n${'x'.repeat(300 * 1024)}\n`,
    );

    const result = await collectReviewDiff({
      cwd: repo,
      includeUntracked: true,
      includeSubmodules: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.diff).toContain('+start-of-big-file');
    // The 200 KB per-file prefix exceeds the overall diff cap, so the
    // global truncation applies and the result stays bounded.
    expect(result.value.truncated).toBe(true);
    expect(result.value.diff).toContain('[... diff truncated for review]');
    expect(result.value.diff.length).toBeLessThan(200 * 1024);
  });

  it('falls back to the origin remote-tracking branch when no local main exists', async () => {
    // Simulate a manually added remote: origin/main exists as a tracking
    // ref, origin/HEAD is unset, and there is no local main branch.
    await git('checkout', '-b', 'feature');
    await git('update-ref', 'refs/remotes/origin/main', 'refs/heads/main');
    await git('branch', '-D', 'main');
    await writeFile(path.join(repo, 'paper.tex'), 'changed line\n');

    const result = await collectReviewDiff({
      cwd: repo,
      includeUntracked: false,
      includeSubmodules: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.baseDescription).toBe('main branch (origin/main)');
    expect(result.value.diff).toContain('+changed line');
  });

  it('resolves the repository root when run from a subdirectory', async () => {
    await git('checkout', '-b', 'feature');
    await mkdir(path.join(repo, 'sub'));
    await writeFile(path.join(repo, 'sub', 'note.txt'), 'untracked content\n');

    const result = await collectReviewDiff({
      cwd: path.join(repo, 'sub'),
      includeUntracked: true,
      includeSubmodules: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await realpath(result.value.repoRoot)).toBe(await realpath(repo));
    expect(result.value.changedFiles).toEqual(['sub/note.txt']);
  });

  it('omits untracked files when disabled', async () => {
    await git('checkout', '-b', 'feature');
    await writeFile(path.join(repo, 'scratch.txt'), 'untracked content\n');

    const result = await collectReviewDiff({
      cwd: repo,
      includeUntracked: false,
      includeSubmodules: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.diff).toBe('');
    expect(result.value.changedFiles).toEqual([]);
  });

  it('reviews uncommitted changes when on the main branch', async () => {
    await writeFile(path.join(repo, 'paper.tex'), 'edited on main\n');

    const result = await collectReviewDiff({
      cwd: repo,
      includeUntracked: false,
      includeSubmodules: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.baseDescription).toContain('uncommitted changes');
    expect(result.value.diff).toContain('+edited on main');
  });

  it('reviews the latest commit when on main with a clean tree', async () => {
    await writeFile(path.join(repo, 'paper.tex'), 'committed on main\n');
    await git('commit', '-am', 'second');

    const result = await collectReviewDiff({
      cwd: repo,
      includeUntracked: false,
      includeSubmodules: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.baseDescription).toContain('latest commit');
    expect(result.value.diff).toContain('+committed on main');
    expect(result.value.diff).toContain('-original line');
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

    const result = await collectReviewDiff({
      cwd: repo,
      includeUntracked: false,
      includeSubmodules: true,
      baseBranch: 'develop',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Merge-base with develop is the initial commit, so develop's own work
    // is not part of the review — only the feature change is.
    expect(result.value.baseDescription).toBe('branch develop');
    expect(result.value.diff).toContain('+feature line');
    expect(result.value.diff).not.toContain('develop work');
    expect(result.value.changedFiles).toEqual(['paper.tex']);
  });

  it('diffs against an explicitly chosen remote ref even on the matching local branch', async () => {
    await git('update-ref', 'refs/remotes/origin/main', 'refs/heads/main');
    await writeFile(path.join(repo, 'notes.txt'), 'first unpushed commit\n');
    await git('add', '.');
    await git('commit', '-m', 'first unpushed');
    await writeFile(path.join(repo, 'paper.tex'), 'second unpushed commit\n');
    await git('commit', '-am', 'second unpushed');

    const result = await collectReviewDiff({
      cwd: repo,
      includeUntracked: false,
      includeSubmodules: true,
      baseBranch: 'origin/main',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.baseDescription).toBe('branch origin/main');
    expect(result.value.diff).toContain('+first unpushed commit');
    expect(result.value.diff).toContain('+second unpushed commit');
    expect(result.value.changedFiles).toEqual(['notes.txt', 'paper.tex']);
  });

  it('fails clearly when the chosen base branch does not exist', async () => {
    await git('checkout', '-b', 'feature');
    const result = await collectReviewDiff({
      cwd: repo,
      includeUntracked: false,
      includeSubmodules: true,
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

    const result = await collectReviewDiff({
      cwd: repo,
      includeUntracked: false,
      includeSubmodules: true,
      baseRef: previousHead,
      baseDescription: 'previous commit on main',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.baseRef).toBe(previousHead);
    expect(result.value.baseDescription).toBe('previous commit on main');
    expect(result.value.diff).toContain('+committed on main');
    expect(result.value.diff).toContain('+dirty after commit');
    expect(result.value.changedFiles).toEqual(['notes.txt', 'paper.tex']);
  });

  it('reports no changes on main with a clean tree and no parent commit', async () => {
    const result = await collectReviewDiff({
      cwd: repo,
      includeUntracked: false,
      includeSubmodules: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.diff).toBe('');
  });

  it('fails with a reason outside a git repository', async () => {
    const plain = await mkdtemp(path.join(tmpdir(), 'texra-plain-'));
    try {
      const result = await collectReviewDiff({
        cwd: plain,
        includeUntracked: true,
        includeSubmodules: true,
      });
      expect(result).toEqual({
        ok: false,
        reason: 'The workspace is not a git repository.',
      });
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
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
    const plain = await mkdtemp(path.join(tmpdir(), 'texra-plain-'));
    try {
      expect(await listBaseBranchCandidates(plain)).toEqual([]);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});
