// Suites for src/utils/system (execUtils, workspaceInfo, binaryResolver).

import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import * as fs from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { setupPlatform } from '@test/support/setupPlatform';
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createFakePlatform } from '@test/support/FakePlatform';
import { executeCommand, executeCommandSync } from '@utils/system/execUtils';
import { buildWorkspaceInfoBlock } from '@utils/system/workspaceInfo';
import { BinaryResolverService } from '@utils/system/binaryResolver';

// ---------------------------------------------------------------------------
// execUtils
// ---------------------------------------------------------------------------

// Node imports

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (existsSync(filePath)) return;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await sleep(20);
  }
  throw new Error(`Process ${pid} was still running after abort`);
}

type ExecuteCommandOptions = NonNullable<Parameters<typeof executeCommand>[1]>;

describe('executeCommand', () => {
  const tempDirs: string[] = [];

  it('exposes only text encodings and non-transform output modes', () => {
    expectTypeOf<ExecuteCommandOptions['encoding']>().toEqualTypeOf<
      'utf8' | 'utf-8' | 'utf16le' | undefined
    >();
    expectTypeOf<ExecuteCommandOptions['stdout']>().toEqualTypeOf<
      'pipe' | 'ignore' | 'inherit' | 'overlapped' | undefined
    >();
    expectTypeOf<ExecuteCommandOptions['stderr']>().toEqualTypeOf<
      'pipe' | 'ignore' | 'inherit' | 'overlapped' | undefined
    >();
  });

  // executeCommand resolves its cwd from the workspace; point the fake
  // platform at a directory that exists on disk so spawning succeeds.
  setupPlatform({ workspacePath: process.cwd() });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs string commands with shell operators intact', async () => {
    const result = await executeCommand(
      'node -e "process.stdout.write(\'one\')" && echo two',
    );

    assert.ok(result.success);
    assert.strictEqual(result.stdout, 'onetwo');
    assert.strictEqual(result.stderr, null);
  });

  it('preserves fallback execution with logical OR', async () => {
    const result = await executeCommand(
      'node -e "process.exit(1)" || echo fallback',
    );

    assert.ok(result.success);
    assert.strictEqual(result.stdout, 'fallback');
    assert.strictEqual(result.stderr, null);
  });

  it('aborts shell command process groups including children', async () => {
    if (process.platform === 'win32') return;

    const dir = mkdtempSync(join(tmpdir(), 'texra-exec-abort-'));
    tempDirs.push(dir);
    const pidFile = join(dir, 'sleep.pid');
    const controller = new AbortController();
    const promise = executeCommand('sleep 60 & echo $! > "$PID_FILE"; wait', {
      cwd: dir,
      env: { PID_FILE: pidFile },
      signal: controller.signal,
      timeout: 60_000,
    });

    await waitForFile(pidFile);
    const childPid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
    assert.ok(Number.isInteger(childPid) && childPid > 0);

    controller.abort();
    const result = await promise;

    assert.equal(result.success, false);
    assert.equal(result.timedOut, false);
    assert.equal(result.stderr, 'Command aborted by user');
    await waitForProcessExit(childPid);
  });

  it('aborts array-form commands via execa native cancelSignal', async () => {
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

    for (
      let attempt = 0;
      attempt < 50 && childPid === undefined;
      attempt += 1
    ) {
      await sleep(20);
    }
    assert.ok(childPid && childPid > 0);

    controller.abort();
    const result = await promise;

    assert.equal(result.success, false);
    assert.equal(result.timedOut, false);
    assert.equal(result.exitCode, 130);
    assert.equal(result.stderr, 'Command aborted by user');
    await waitForProcessExit(childPid!);
  });

  it('unblocks aborted array-form await when a descendant holds stdio', async () => {
    if (process.platform === 'win32') return;

    const dir = mkdtempSync(join(tmpdir(), 'texra-exec-abort-array-'));
    tempDirs.push(dir);
    const pidFile = join(dir, 'sleep.pid');
    const controller = new AbortController();
    // The backgrounded sleep inherits stdout/stderr; execa's cancelSignal
    // only kills the tracked bash pid, so without the stream-teardown
    // backstop this await would hang until the descendant exits.
    const promise = executeCommand(
      ['bash', '-c', 'sleep 60 & echo $! > "$PID_FILE"; wait'],
      {
        cwd: dir,
        env: { PID_FILE: pidFile },
        signal: controller.signal,
        timeout: 60_000,
      },
    );

    await waitForFile(pidFile);
    const childPid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
    assert.ok(Number.isInteger(childPid) && childPid > 0);

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

    const dir = mkdtempSync(join(tmpdir(), 'texra-exec-timeout-array-'));
    tempDirs.push(dir);
    const pidFile = join(dir, 'sleep.pid');
    const promise = executeCommand(
      ['bash', '-c', 'sleep 60 & echo $! > "$PID_FILE"; wait'],
      {
        cwd: dir,
        env: { PID_FILE: pidFile },
        timeout: 50,
      },
    );

    await waitForFile(pidFile);
    const childPid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
    assert.ok(Number.isInteger(childPid) && childPid > 0);

    const result = await promise;

    assert.equal(result.success, false);
    assert.equal(result.timedOut, true);
    assert.doesNotThrow(() => process.kill(childPid, 0));
    process.kill(childPid, 'SIGKILL');
  }, 20_000);
});

// ---------------------------------------------------------------------------
// ExecUtils
// ---------------------------------------------------------------------------

describe('executeCommandSync', () => {
  let platformStorageRoot = '';

  setupPlatform(async () => {
    platformStorageRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'texra-exec-utils-'),
    );
    return createFakePlatform(
      {
        workspacePath: process.cwd(),
        storagePath: path.join(platformStorageRoot, 'storage'),
        globalStoragePath: path.join(platformStorageRoot, 'global-storage'),
      },
      { fs: nodeFilesystem },
    );
  });

  afterEach(async () => {
    if (platformStorageRoot) {
      await fs.rm(platformStorageRoot, { recursive: true, force: true });
      platformStorageRoot = '';
    }
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
      stderr: null,
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
      stdout: null,
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
  it('tells agents when the workspace is not a git repository', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'texra-workspace-info-'));
    try {
      const block = await buildWorkspaceInfoBlock(workspace);

      expect(block).toContain(`Workspace: ${workspace}`);
      expect(block).toContain(
        'Git: no repository detected or git could not be checked',
      );
      expect(block).toContain('avoid git history/status checks');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
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
