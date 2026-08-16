// Suites for src/utils/system (execUtils, workspaceInfo, binaryResolver).

// Node imports
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// Third-party imports
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';

// Local imports
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createFakePlatform } from '@test/support/FakePlatform';
import { setupPlatform } from '@test/support/setupPlatform';
import { cleanupTempDirs, makeTempDir } from '@test/support/tempDirPlatform';
import { executeCommand, executeCommandSync } from '@utils/system/execUtils';
import { buildWorkspaceInfoBlock } from '@utils/system/workspaceInfo';
import { BinaryResolverService } from '@utils/system/binaryResolver';

// ---------------------------------------------------------------------------
// execUtils
// ---------------------------------------------------------------------------

async function waitFor(
  description: string,
  check: () => boolean,
  attempts = 50,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (check()) return;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

// Signal delivery to a whole process group, and the kernel reaping the members,
// is not instant — and gets markedly slower when the suite is saturating every
// core. The budget is generous (~10s) because it exists to catch a genuinely
// leaked child, not to measure teardown latency; a tight one only produces
// flakes on loaded machines.
//
// It exceeds the suite-wide `testTimeout: 10000` in vitest.config.mjs, so every
// test calling this must pass PROCESS_EXIT_TEST_TIMEOUT_MS. Without it the
// runner aborts the test mid-poll and the extra budget buys nothing.
const PROCESS_EXIT_TEST_TIMEOUT_MS = 30_000;

function waitForProcessExit(pid: number): Promise<void> {
  return waitFor(
    `process ${pid} to exit`,
    () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    },
    500,
  );
}

type ExecuteCommandOptions = NonNullable<Parameters<typeof executeCommand>[1]>;

// Backgrounds a long sleep, records its pid, then blocks on `wait` so the
// tracked shell keeps running while the descendant holds the inherited stdio.
const SLEEPER_SCRIPT = 'sleep 60 & echo $! > "$PID_FILE"; wait';

describe('executeCommand', () => {
  const tempDirs: string[] = [];

  // executeCommand resolves its cwd from the workspace; point the fake
  // platform at a directory that exists on disk so spawning succeeds.
  setupPlatform({ workspacePath: process.cwd() });

  afterEach(async () => {
    await cleanupTempDirs(tempDirs);
  });

  it('exposes only text encodings and non-transform output modes', () => {
    expectTypeOf<ExecuteCommandOptions['encoding']>().toEqualTypeOf<
      'utf8' | 'utf-8' | 'utf16le' | undefined
    >();
    expectTypeOf<ExecuteCommandOptions['maxBuffer']>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<ExecuteCommandOptions['stdout']>().toEqualTypeOf<
      'pipe' | 'ignore' | 'inherit' | 'overlapped' | undefined
    >();
    expectTypeOf<ExecuteCommandOptions['stderr']>().toEqualTypeOf<
      'pipe' | 'ignore' | 'inherit' | 'overlapped' | undefined
    >();
  });

  // Runs SLEEPER_SCRIPT in a scratch directory and resolves once the
  // backgrounded sleep has published its pid, so callers can assert on the
  // descendant's fate after an abort or timeout.
  async function startSleeper(
    command: string | string[],
    options: ExecuteCommandOptions,
  ): Promise<{
    promise: ReturnType<typeof executeCommand>;
    childPid: number;
  }> {
    const dir = await makeTempDir('texra-exec-sleeper-', tempDirs);
    const pidFile = join(dir, 'sleep.pid');
    const promise = executeCommand(command, {
      ...options,
      cwd: dir,
      env: { PID_FILE: pidFile },
    });

    await waitFor(pidFile, () => existsSync(pidFile));
    const childPid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
    assert.ok(Number.isInteger(childPid) && childPid > 0);
    return { promise, childPid };
  }

  it.each([
    {
      name: 'shell operators intact',
      command: 'node -e "process.stdout.write(\'one\')" && echo two',
      stdout: 'onetwo',
    },
    {
      name: 'fallback execution with logical OR',
      command: 'node -e "process.exit(1)" || echo fallback',
      stdout: 'fallback',
    },
  ])('runs string commands with $name', async ({ command, stdout }) => {
    const result = await executeCommand(command);

    assert.ok(result.success);
    assert.equal(result.stdout, stdout);
    assert.equal(result.stderr, '');
  });

  it('keeps stderr empty for ordinary nonzero exits with stdout only', async () => {
    const result = await executeCommand([
      process.execPath,
      '-e',
      `process.stdout.write('failure details'); process.exit(7)`,
    ]);

    assert.equal(result.success, false);
    assert.equal(result.exitCode, 7);
    assert.equal(result.stdout, 'failure details');
    assert.equal(result.stderr, '');
    assert.equal(result.outputLimitExceeded, undefined);
  });

  it('decodes streamed Unicode split across byte chunks', async () => {
    let streamed = '';
    const result = await executeCommand(
      [
        process.execPath,
        '-e',
        `process.stdout.write(Buffer.from([0xf0, 0x9f])); ` +
          `setTimeout(() => process.stdout.write(Buffer.from([0x99, 0x82])), 20);`,
      ],
      {
        buffer: false,
        onStdout: (chunk) => {
          streamed += chunk;
        },
      },
    );

    assert.equal(result.success, true);
    assert.equal(result.stdout, '');
    assert.equal(streamed, '🙂');
  });

  it('flushes pending multibyte stdout and stderr exactly once on stream close', async () => {
    let streamedStdout = '';
    let streamedStderr = '';
    const result = await executeCommand(
      [
        process.execPath,
        '-e',
        `const fs = require('node:fs'); ` +
          `fs.writeSync(1, Buffer.from([0xf0, 0x9f])); ` +
          `fs.writeSync(2, Buffer.from([0xe2, 0x82])); ` +
          `process.stdout.destroy(); process.stderr.destroy();`,
      ],
      {
        buffer: false,
        onStdout: (chunk) => {
          streamedStdout += chunk;
        },
        onStderr: (chunk) => {
          streamedStderr += chunk;
        },
      },
    );

    assert.equal(result.success, true);
    assert.equal(streamedStdout, '\ufffd');
    assert.equal(streamedStderr, '\ufffd');
  });

  it('disables maxBuffer enforcement when buffering is disabled', async () => {
    const outputChars = 10_000;
    let streamedChars = 0;
    const result = await executeCommand(
      [
        process.execPath,
        '-e',
        `process.stdout.write('x'.repeat(${outputChars}))`,
      ],
      {
        buffer: false,
        maxBuffer: 64,
        onStdout: (chunk) => {
          streamedChars += chunk.length;
        },
      },
    );

    assert.equal(result.success, true);
    assert.equal(result.stdout, '');
    assert.equal(streamedChars, outputChars);
    assert.equal(result.outputLimitExceeded, undefined);
  });

  it('reports maxBuffer overflow as an error instead of partial success', async () => {
    const result = await executeCommand(
      [process.execPath, '-e', `process.stdout.write('x'.repeat(10_000))`],
      { maxBuffer: 64 },
    );

    assert.equal(result.success, false);
    assert.equal(result.exitCode, 2);
    assert.equal(result.outputLimitExceeded, true);
    assert.ok(result.stdout && result.stdout.length > 0);
    assert.match(result.stderr ?? '', /maxBuffer exceeded/i);
  });

  it(
    'aborts shell command process groups including children',
    async () => {
      if (process.platform === 'win32') return;

      const controller = new AbortController();
      const { promise, childPid } = await startSleeper(SLEEPER_SCRIPT, {
        signal: controller.signal,
        timeout: 60_000,
      });

      controller.abort();
      const result = await promise;

      assert.equal(result.success, false);
      assert.equal(result.timedOut, false);
      assert.equal(result.stderr, 'Command aborted by user');
      await waitForProcessExit(childPid);
    },
    PROCESS_EXIT_TEST_TIMEOUT_MS,
  );

  it(
    'aborts array-form commands via execa native cancelSignal',
    async () => {
      if (process.platform === 'win32') return;

      const controller = new AbortController();
      let childPid: number | undefined;
      const promise = executeCommand(
        [process.execPath, '-e', 'setTimeout(() => {}, 60000)'],
        {
          signal: controller.signal,
          timeout: 60_000,
          onPid: (pid) => {
            childPid = pid;
          },
        },
      );

      await waitFor('child pid', () => childPid !== undefined);
      assert.ok(childPid && childPid > 0);

      controller.abort();
      const result = await promise;

      assert.equal(result.success, false);
      assert.equal(result.timedOut, false);
      assert.equal(result.exitCode, 130);
      assert.equal(result.stderr, 'Command aborted by user');
      await waitForProcessExit(childPid!);
    },
    PROCESS_EXIT_TEST_TIMEOUT_MS,
  );

  it('unblocks aborted array-form await when a descendant holds stdio', async () => {
    if (process.platform === 'win32') return;

    const controller = new AbortController();
    // The backgrounded sleep inherits stdout/stderr; execa's cancelSignal
    // only kills the tracked bash pid, so without the stream-teardown
    // backstop this await would hang until the descendant exits.
    const { promise, childPid } = await startSleeper(
      ['bash', '-c', SLEEPER_SCRIPT],
      { signal: controller.signal, timeout: 60_000 },
    );

    controller.abort();
    const result = await promise;

    assert.equal(result.success, false);
    assert.equal(result.timedOut, false);
    assert.equal(result.exitCode, 130);
    assert.equal(result.stderr, 'Command aborted by user');
    // The array form intentionally has no process-group semantics: the
    // descendant must survive the abort. Reap it so the test doesn't leak.
    assert.doesNotThrow(() => process.kill(childPid, 0));
    process.kill(childPid, 'SIGKILL');
  }, 20_000);

  it('unblocks timed-out array-form await when a descendant holds stdio', async () => {
    if (process.platform === 'win32') return;

    const { promise, childPid } = await startSleeper(
      ['bash', '-c', SLEEPER_SCRIPT],
      { timeout: 50 },
    );

    const result = await promise;

    assert.equal(result.success, false);
    assert.equal(result.timedOut, true);
    assert.doesNotThrow(() => process.kill(childPid, 0));
    process.kill(childPid, 'SIGKILL');
  }, 20_000);
});

// ---------------------------------------------------------------------------
// executeCommandSync
// ---------------------------------------------------------------------------

describe('executeCommandSync', () => {
  const tempDirs: string[] = [];

  setupPlatform(async () => {
    const storageRoot = await makeTempDir('texra-exec-utils-', tempDirs);
    return createFakePlatform(
      {
        workspacePath: process.cwd(),
        storagePath: join(storageRoot, 'storage'),
        globalStoragePath: join(storageRoot, 'global-storage'),
      },
      { fs: nodeFilesystem },
    );
  });

  afterEach(async () => {
    await cleanupTempDirs(tempDirs);
  });

  it('returns normalized stdout for successful commands', () => {
    const result = executeCommandSync([
      process.execPath,
      '-e',
      'process.stdout.write("ok\\n")',
    ]);

    expect(result).toMatchObject({
      success: true,
      stdout: 'ok',
      stderr: '',
      timedOut: false,
      exitCode: 0,
    });
  });

  it('returns stderr and exit code for failing commands', () => {
    const result = executeCommandSync([
      process.execPath,
      '-e',
      'process.stderr.write("bad\\n"); process.exit(7)',
    ]);

    expect(result).toMatchObject({
      success: false,
      stdout: '',
      stderr: 'bad',
      timedOut: false,
      exitCode: 7,
    });
  });
});

// ---------------------------------------------------------------------------
// WorkspaceInfo
// ---------------------------------------------------------------------------

describe('buildWorkspaceInfoBlock', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await cleanupTempDirs(tempDirs);
  });

  it('tells agents when the workspace is not a git repository', async () => {
    const workspace = await makeTempDir('texra-workspace-info-', tempDirs);

    const block = await buildWorkspaceInfoBlock(workspace);

    expect(block).toContain(`Workspace: ${workspace}`);
    expect(block).toContain(
      'Git: no repository detected or git could not be checked',
    );
    expect(block).toContain('avoid git history/status checks');
  });
});

// ---------------------------------------------------------------------------
// BinaryResolver
// ---------------------------------------------------------------------------

function createResolver(
  paths: Record<string, string | null>,
  isWindows = false,
): BinaryResolverService {
  return new BinaryResolverService({
    findTool: (toolName) => paths[toolName] ?? null,
    isWindows,
  });
}

describe('BinaryResolverService', () => {
  it('resolves nullable tool paths', () => {
    const resolver = createResolver({ latexmk: '/usr/bin/latexmk' });

    assert.equal(resolver.findPath('latexmk'), '/usr/bin/latexmk');
    assert.equal(resolver.findPath('missing'), null);
  });

  it('routes Perl scripts through the Perl launcher', () => {
    const resolver = createResolver({
      latexindent: '/usr/local/texlive/scripts/latexindent/latexindent.pl',
    });

    assert.deepEqual(resolver.resolveOptionalCommand('latexindent', ['-w']), {
      command: 'perl',
      args: ['/usr/local/texlive/scripts/latexindent/latexindent.pl', '-w'],
      resolvedPath: '/usr/local/texlive/scripts/latexindent/latexindent.pl',
    });
  });

  it.each([
    {
      tool: 'latexdiff',
      path: 'C:\\texlive\\texmf-dist\\scripts\\latexdiff\\latexdiff',
      args: ['a', 'b'],
    },
    {
      tool: 'latexmk',
      path: 'C:\\texlive\\texmf-dist\\scripts\\latexmk\\latexmk',
      args: ['-pdf'],
    },
    {
      tool: 'latexdiff-vc',
      path: 'C:\\texlive\\texmf-dist\\scripts\\latexdiff\\latexdiff-vc',
      args: ['--git'],
    },
  ])(
    'routes extensionless Windows $tool scripts through Perl',
    ({ tool, path, args }) => {
      const resolver = createResolver({ [tool]: path }, true);

      assert.deepEqual(resolver.resolveOptionalCommand(tool, args), {
        command: 'perl',
        args: [path, ...args],
        resolvedPath: path,
      });
    },
  );

  it('launches extensionless Windows binaries directly', () => {
    const resolver = createResolver({ sox: 'C:\\msys64\\usr\\bin\\sox' }, true);

    assert.deepEqual(resolver.resolveOptionalCommand('sox'), {
      command: 'C:\\msys64\\usr\\bin\\sox',
      args: [],
      resolvedPath: 'C:\\msys64\\usr\\bin\\sox',
    });
  });

  it('builds commands from an already-resolved path', () => {
    const resolver = createResolver({}, true);

    assert.deepEqual(
      resolver.resolveOptionalCommand('latexindent', ['-w'], {
        resolvedPath:
          'C:\\texlive\\texmf-dist\\scripts\\latexindent\\latexindent',
      }),
      {
        command: 'perl',
        args: [
          'C:\\texlive\\texmf-dist\\scripts\\latexindent\\latexindent',
          '-w',
        ],
        resolvedPath:
          'C:\\texlive\\texmf-dist\\scripts\\latexindent\\latexindent',
      },
    );
  });

  it('returns null when a command cannot be resolved', () => {
    const resolver = createResolver({});

    assert.deepEqual(resolver.resolveOptionalCommand('tex-fmt'), null);
  });
});
