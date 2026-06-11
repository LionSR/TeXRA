// Standard library imports
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Local imports
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createFakePlatform } from '@test/support/FakePlatform';
import {
  buildUntrackedFileDiff,
  collectReviewDiff,
  isPathInChangeSet,
} from '@agent/review/reviewDiff';
import { executeCommand } from '@utils/system/execUtils';

beforeAll(async () => {
  const { initPlatform } = await import('@platform/platform');
  initPlatform(
    createFakePlatform(
      { workspacePath: process.cwd() },
      { fs: nodeFilesystem },
    ),
  );
});

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

  async function git(...args: string[]): Promise<void> {
    const result = await executeCommand(['git', ...args], { cwd: repo });
    expect(result.success, `git ${args.join(' ')}: ${result.stderr}`).toBe(
      true,
    );
  }

  async function gitOutput(...args: string[]): Promise<string> {
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

  it('uses an explicit base ref for commit-triggered reviews', async () => {
    await writeFile(path.join(repo, 'notes.txt'), 'notes before\n');
    await git('add', '.');
    await git('commit', '-m', 'add notes');
    const previousHead = await gitOutput('rev-parse', 'HEAD');

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
});
