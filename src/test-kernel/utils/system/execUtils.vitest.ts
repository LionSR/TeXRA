// Node imports
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// Third-party imports
import { afterEach, describe, it } from 'vitest';

// Local imports - test support
import { setupPlatform } from '@test/support/setupPlatform';

// Local imports - utils
import { executeCommand } from '@utils/system/execUtils';

const tempDirs: string[] = [];

// executeCommand resolves its cwd from the workspace; point the fake
// platform at a directory that exists on disk so spawning succeeds.
setupPlatform({ workspacePath: process.cwd() });

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

describe('executeCommand', () => {
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
});
