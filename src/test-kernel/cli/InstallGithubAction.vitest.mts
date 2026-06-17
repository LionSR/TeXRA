import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '@cli/commands/root';
import { parseGitHubSlug } from '@cli/runtime/gitOps';
import { CliExitCode } from '@cli/runtime/exitCodes';

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function makeRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'texra-install-action-'));
  git(repo, 'init');
  git(repo, 'config', 'user.email', 'texra@example.com');
  git(repo, 'config', 'user.name', 'TeXRA Test');
  writeFileSync(path.join(repo, 'README.md'), '# Test\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'initial');
  return repo;
}

describe('install-github-action command', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('commits only the generated workflow file', async () => {
    const repo = makeRepo();
    writeFileSync(path.join(repo, 'already-staged.txt'), 'keep staged\n');
    git(repo, 'add', 'already-staged.txt');

    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = await runCli([
      '--cwd',
      repo,
      'install-github-action',
      '--no-pr',
      '--no-color',
    ]);

    expect(result.exitCode).toBe(CliExitCode.Success);
    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD')).toBe(
      '.github/workflows/texra-code-review.yml',
    );
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe(
      'already-staged.txt',
    );
  });
});

describe('parseGitHubSlug', () => {
  it.each([
    ['https://github.com/owner/repo.git', { owner: 'owner', repo: 'repo' }],
    ['git@github.com:owner/repo.git', { owner: 'owner', repo: 'repo' }],
    ['https://github.com/owner/repo/', { owner: 'owner', repo: 'repo' }],
  ])('parses %s', (url, expected) => {
    expect(parseGitHubSlug(url)).toEqual(expected);
  });

  it('rejects remotes outside GitHub', () => {
    expect(parseGitHubSlug('https://gitlab.com/owner/repo.git')).toBeNull();
  });
});
