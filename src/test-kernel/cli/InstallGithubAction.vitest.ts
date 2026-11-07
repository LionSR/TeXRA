import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { layer } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, beforeEach, expect, vi } from 'vitest';

import { runCli } from '@cli/commands/root';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';
import { SessionGraph } from '@test/support/testKernel';
import type { ProcessRuntime } from '@texra-ai/harness/host';

const browserMocks = vi.hoisted(() => ({
  tryOpenBrowser: vi.fn(),
}));

/** The runtime the command's entry installs: the test's, while it runs. */
const installed = vi.hoisted((): { runtime: ProcessRuntime | undefined } => ({
  runtime: undefined,
}));

vi.mock('@cli/runtime/browser', () => ({
  tryOpenBrowser: browserMocks.tryOpenBrowser,
}));

// The command brings no platform up, but its entry still builds the runtime
// its program runs on. Here that runtime serves the block's services, so the
// suite never builds a real one.
vi.mock('@cli/runtime/cliProcessRuntime', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@cli/runtime/cliProcessRuntime')>();
  const { Layer } = await import('effect');
  return {
    ...actual,
    cliSecretsLayer: () => {
      if (!installed.runtime) throw new Error('No test runtime is installed.');
      return Layer.effectContext(installed.runtime.contextEffect);
    },
  };
});

/** Hand the entry the block's runtime for the test's scope. */
const useCliRuntime = Effect.acquireRelease(
  Effect.tap(SessionGraph.runtime, (runtime) =>
    Effect.sync(() => {
      installed.runtime = runtime;
    }),
  ),
  () =>
    Effect.sync(() => {
      installed.runtime = undefined;
    }),
);

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

// Live clock: the command drives real git processes.
layer(SessionGraph.hosted, { excludeTestServices: true })(
  'install-github-action command',
  (it) => {
    beforeEach(() => {
      spyOnStreamWrite(process.stdout);
      spyOnStreamWrite(process.stderr);
      browserMocks.tryOpenBrowser.mockReset();
      browserMocks.tryOpenBrowser.mockImplementation(() =>
        Effect.succeed(true),
      );
    });

    it.effect(
      'reuses an existing branch under --force without resetting its commits',
      () =>
        Effect.gen(function* () {
          yield* useCliRuntime;
          const repo = makeRepo();
          expect(yield* Effect.promise(() => runInstall(repo))).toEqual({
            exitCode: CliExitCode.Success,
          });

          writeFileSync(path.join(repo, 'custom.txt'), 'keep me\n');
          git(repo, 'add', 'custom.txt');
          git(repo, 'commit', '-m', 'custom branch edit');
          const customCommit = git(repo, 'rev-parse', 'HEAD');

          git(repo, 'checkout', 'main');

          expect(
            yield* Effect.promise(() => runInstall(repo, '--force')),
          ).toEqual({ exitCode: CliExitCode.Success });

          expect(git(repo, 'rev-parse', 'HEAD')).toBe(customCommit);
        }),
    );
  },
);
