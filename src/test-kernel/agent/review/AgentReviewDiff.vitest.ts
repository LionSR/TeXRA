// Standard library imports
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Local imports
import {
  buildUntrackedFileDiff,
  collectReviewDiff,
} from '@agent/review/reviewDiff';
import { executeCommand } from '@utils/system/execUtils';

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
