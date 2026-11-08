import * as path from 'node:path';

import { layer } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, beforeEach, expect, vi } from 'vitest';

import { runCli } from '@cli/commands/root';
import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';
import { createFakeHost } from '@test/support/setupPlatform';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { FakeHost, SessionGraph, TestSession } from '@test/support/testKernel';

// Live clock: the CLI's entry runs in real time.
layer(SessionGraph.hosted, { excludeTestServices: true })(
  'runCli usage output stream routing',
  (it) => {
    // Capture every byte the CLI writes. Usage on an ERROR flows through
    // writeRawStderr -> process.stderr.write; citty's showUsage (the explicit
    // --help path) flows through console.log -> process.stdout.write. We stub
    // both stream writers AND console.* so nothing leaks to the real terminal.
    let stdout = '';
    let stderr = '';
    let stdoutSpy: ReturnType<typeof vi.spyOn>;
    let stderrSpy: ReturnType<typeof vi.spyOn>;
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    const tempDirs = useTempDirs();
    let platformStorageRoot = '';

    beforeEach(async () => {
      platformStorageRoot = await makeTempDir('texra-cli-root-', tempDirs);
      stdout = '';
      stderr = '';
      stdoutSpy = spyOnStreamWrite(process.stdout, (chunk) => {
        stdout += chunk;
      });
      stderrSpy = spyOnStreamWrite(process.stderr, (chunk) => {
        stderr += chunk;
      });
      // citty's showUsage writes via console.log; its errors via console.error.
      consoleLogSpy = vi
        .spyOn(console, 'log')
        .mockImplementation((...args: unknown[]) => {
          stdout += `${args.join(' ')}\n`;
        });
      consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation((...args: unknown[]) => {
          stderr += `${args.join(' ')}\n`;
        });
    });

    afterEach(() => {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      consoleLogSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    // A host over the test's temp storage, and the process session over its
    // roots' own store, as the CLI's entry would open it.
    it.layer(
      FakeHost.layer(() =>
        createFakeHost({
          workspaceRoot: process.cwd(),
          storagePath: path.join(platformStorageRoot, 'storage'),
          globalStoragePath: path.join(platformStorageRoot, 'global-storage'),
        }),
      ),
      { buildPerTest: true },
    )((it) => {
      it.layer(TestSession.layer(undefined, { persistent: true }))((it) => {
        it.effect(
          'routes usage text to stderr (not stdout) on a usage error',
          () =>
            Effect.gen(function* () {
              // Regression guard for the headless-parity contract: usage
              // shown because of an ERROR must not land on STDOUT, or it
              // pollutes `--output-format json|ndjson` (e.g. `texra run
              // ... | jq`). Mirrors the documented repro: a usage error
              // under --output-format json.
              const result = yield* Effect.promise(() =>
                runCli(['run', '--output-format', 'json']),
              );
              expect(result.exitCode).toBe(2);
              expect(stdout).toBe('');
              // The error leads, followed by a pointer to the usage rather
              // than the full help screen that used to bury it.
              expect(stderr).toMatch(
                /^Missing required positional argument: AGENT\nRun `texra run --help` for usage\.\n$/,
              );
            }),
        );
      });
    });
  },
);
