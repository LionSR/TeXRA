import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { runCli } from '@cli/commands/root';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';

const browserMocks = vi.hoisted(() => ({
  tryOpenBrowser: vi.fn(),
}));

vi.mock('@cli/runtime/browser', () => ({
  tryOpenBrowser: browserMocks.tryOpenBrowser,
}));

// The command brings no platform up, but its entry still installs the process
// runtime its program runs on. Here that is the harness's, so the suite never
// builds a real one.
vi.mock('@cli/runtime/cliProcessRuntime', async (importOriginal) => {
  const { testRuntime } = await import('@test/support/testProcessRuntime');
  const actual =
    await importOriginal<typeof import('@cli/runtime/cliProcessRuntime')>();
  return { ...actual, installCliProcessRuntime: () => testRuntime() };
});

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

function runInstall(repo: string, ...args: readonly string[]) {
  return runCli([
    '--cwd',
    repo,
    'install-github-action',
    ...args,
    '--no-pr',
    '--no-color',
  ]);
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
    browserMocks.tryOpenBrowser.mockReset();
    browserMocks.tryOpenBrowser.mockImplementation(() => Effect.succeed(true));
  });

  it('reuses an existing branch under --force without resetting its commits', async () => {
    const repo = makeRepo();
    await expect(runInstall(repo)).resolves.toEqual({
      exitCode: CliExitCode.Success,
    });

    writeFileSync(path.join(repo, 'custom.txt'), 'keep me\n');
    git(repo, 'add', 'custom.txt');
    git(repo, 'commit', '-m', 'custom branch edit');
    const customCommit = git(repo, 'rev-parse', 'HEAD');

    git(repo, 'checkout', 'main');

    await expect(runInstall(repo, '--force')).resolves.toEqual({
      exitCode: CliExitCode.Success,
    });

    expect(git(repo, 'rev-parse', 'HEAD')).toBe(customCommit);
  });
});
