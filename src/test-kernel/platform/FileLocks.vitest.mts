import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { nodeFileLocks } from '@platform/defaults/fileLocks';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('nodeFileLocks', () => {
  it('refreshes a lock while a long critical section is still held', async () => {
    const root = await mkdtemp(join(tmpdir(), 'texra-file-lock-refresh-'));
    tempDirs.push(root);
    const lockPath = join(root, 'executionLocks', 'a8644b');

    await nodeFileLocks.runExclusive(lockPath, async () => {
      const lockDirectory = `${lockPath}.lock`;
      const initialMtime = (await stat(lockDirectory)).mtimeMs;
      await sleep(2_500);
      expect((await stat(lockDirectory)).mtimeMs).toBeGreaterThan(initialMtime);
    });
  });

  it('serializes independent callers using the same shared path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'texra-file-lock-'));
    tempDirs.push(root);
    const lockPath = join(root, 'executionLocks', 'a8644a');
    let releaseFirst: (() => void) | undefined;
    const firstPaused = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let secondEntered = false;

    const first = nodeFileLocks.runExclusive(lockPath, async () => {
      firstEntered?.();
      await firstPaused;
    });
    await entered;
    const second = nodeFileLocks.runExclusive(lockPath, async () => {
      secondEntered = true;
    });
    await sleep(20);
    expect(secondEntered).toBe(false);

    releaseFirst?.();
    await Promise.all([first, second]);
    expect(secondEntered).toBe(true);
  });
});
