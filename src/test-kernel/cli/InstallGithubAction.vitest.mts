import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '@cli/commands/root';
import { defaultBranch, parseGitHubSlug } from '@cli/runtime/gitOps';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';

const repos: string[] = [];

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function makeRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'texra-install-action-'));
  repos.push(repo);
  git(repo, 'init');
  git(repo, 'config', 'user.email', 'texra@example.com');
  git(repo, 'config', 'user.name', 'TeXRA Test');
  writeFileSync(path.join(repo, 'README.md'), '# Test\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'initial');
  git(repo, 'branch', '-M', 'main');
  return repo;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const repo of repos.splice(0)) {
    rmSync(repo, { recursive: true, force: true });
  }
});

describe('install-github-action command', () => {
  beforeEach(() => {
    spyOnStreamWrite(process.stdout);
    spyOnStreamWrite(process.stderr);
  });

  it('commits only the generated workflow file', async () => {
    const repo = makeRepo();
    writeFileSync(path.join(repo, 'already-staged.txt'), 'keep staged\n');
    git(repo, 'add', 'already-staged.txt');

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

  it('creates the install branch from the requested base', async () => {
    const repo = makeRepo();
    git(repo, 'checkout', '-b', 'feature');
    writeFileSync(path.join(repo, 'feature.txt'), 'feature work\n');
    git(repo, 'add', 'feature.txt');
    git(repo, 'commit', '-m', 'feature work');

    const result = await runCli([
      '--cwd',
      repo,
      'install-github-action',
      '--branch',
      'texra/install-from-main',
      '--base',
      'main',
      '--no-pr',
      '--no-color',
    ]);

    expect(result.exitCode).toBe(CliExitCode.Success);
    expect(git(repo, 'diff', '--name-only', 'main...HEAD')).toBe(
      '.github/workflows/texra-code-review.yml',
    );
  });

  it('reuses an existing branch under --force without resetting its commits', async () => {
    const repo = makeRepo();
    await expect(
      runCli(['--cwd', repo, 'install-github-action', '--no-pr', '--no-color']),
    ).resolves.toEqual({ exitCode: CliExitCode.Success });

    writeFileSync(path.join(repo, 'custom.txt'), 'keep me\n');
    git(repo, 'add', 'custom.txt');
    git(repo, 'commit', '-m', 'custom branch edit');
    const customCommit = git(repo, 'rev-parse', 'HEAD');

    git(repo, 'checkout', 'main');

    await expect(
      runCli([
        '--cwd',
        repo,
        'install-github-action',
        '--force',
        '--no-pr',
        '--no-color',
      ]),
    ).resolves.toEqual({ exitCode: CliExitCode.Success });

    expect(git(repo, 'rev-parse', 'HEAD')).toBe(customCommit);
    expect(git(repo, 'log', '--format=%s', '-1')).toBe('custom branch edit');
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

describe('defaultBranch', () => {
  it('preserves slash-containing origin default branch names', () => {
    const repo = makeRepo();
    git(repo, 'update-ref', 'refs/remotes/origin/feature/default', 'HEAD');
    git(
      repo,
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/feature/default',
    );

    expect(defaultBranch(repo)).toBe('feature/default');
  });
});
