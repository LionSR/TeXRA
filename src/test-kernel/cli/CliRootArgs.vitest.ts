import '@test/support/defaultSessionTestSetup';
import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { runCli } from '@cli/commands/root';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { openTestDefaultSession } from '@test/support/sessionEnd';

async function initNodeBackedPlatform(options: {
  storagePath: string;
  globalStoragePath: string;
}): Promise<void> {
  const { installPlatform } = await import('@test/support/setupPlatform');
  await installPlatform({
    workspacePath: process.cwd(),
    storagePath: options.storagePath,
    globalStoragePath: options.globalStoragePath,
  });
  await Effect.runPromise(
    openTestDefaultSession({ roots: testWorkspaceRoots() }),
  );
}

async function initDefaultFakePlatform(): Promise<void> {
  const { installPlatform } = await import('@test/support/setupPlatform');
  await installPlatform();
}

describe('runCli usage output stream routing', () => {
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
    await initNodeBackedPlatform({
      storagePath: path.join(platformStorageRoot, 'storage'),
      globalStoragePath: path.join(platformStorageRoot, 'global-storage'),
    });
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

  afterEach(async () => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    await initDefaultFakePlatform();
  });

  function expectUsageError(
    result: { exitCode: number },
    message: string,
  ): void {
    expect(result.exitCode).toBe(2);
    expect(stderr).toContain(message);
    expect(stdout).toBe('');
  }

  it('routes usage text to stderr (not stdout) on a usage error', async () => {
    // Regression guard for the headless-parity contract: usage shown because
    // of an ERROR must not land on STDOUT, or it pollutes
    // `--output-format json|ndjson` (e.g. `texra run ... | jq`).
    // Mirrors the documented repro: a usage error under --output-format json.
    const result = await runCli(['run', '--output-format', 'json']);
    expectUsageError(result, 'Missing required positional argument: AGENT');
    // The error leads, followed by a pointer to the usage rather than the
    // full help screen that used to bury it.
    expect(stderr).toMatch(
      /^Missing required positional argument: AGENT\nRun `texra run --help` for usage\.\n$/,
    );
  });
});
