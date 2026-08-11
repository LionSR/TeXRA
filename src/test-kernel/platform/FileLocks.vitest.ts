import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate, setTimeout as sleep } from 'node:timers/promises';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createNodeFileLocks,
  nodeFileLocks,
} from '@platform/defaults/fileLocks';
import { cleanupTempDirs, makeTempDir } from '@test/support/tempDirPlatform';

const tempDirs: string[] = [];

afterEach(async () => {
  await cleanupTempDirs(tempDirs);
});

describe('nodeFileLocks', () => {
  it('refreshes a lock while a long critical section is still held', async () => {
    const root = await makeTempDir('texra-file-lock-refresh-', tempDirs);
    const lockPath = join(root, 'executionLocks', 'a8644b');
    // A short refresh interval exercises the same mtime-refresh mechanism as
    // the default tuning without holding the critical section for seconds.
    const locks = createNodeFileLocks({
      staleMs: 5_000,
      updateMs: 50,
      retries: 0,
    });

    await locks.runExclusive(lockPath, async () => {
      const lockDirectory = `${lockPath}.lock`;
      const initialMtime = (await stat(lockDirectory)).mtimeMs;
      // Poll for the mtime bump instead of sleeping a fixed window, so a slow
      // CI scheduler delays the assertion rather than failing it.
      const deadline = Date.now() + 5_000;
      let refreshedMtime = initialMtime;
      while (refreshedMtime <= initialMtime && Date.now() < deadline) {
        await sleep(20);
        refreshedMtime = (await stat(lockDirectory)).mtimeMs;
      }
      expect(refreshedMtime).toBeGreaterThan(initialMtime);
    });
  });

  it('serializes independent callers using the same shared path', async () => {
    const root = await makeTempDir('texra-file-lock-', tempDirs);
    const lockPath = join(root, 'executionLocks', 'a8644a');
    let releaseFirst!: () => void;
    const firstPaused = new Promise<void>(
      (resolve) => (releaseFirst = resolve),
    );
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => (firstEntered = resolve));
    let secondEntered = false;

    const first = nodeFileLocks.runExclusive(lockPath, async () => {
      firstEntered();
      await firstPaused;
    });
    await entered;
    const second = nodeFileLocks.runExclusive(lockPath, async () => {
      secondEntered = true;
    });
    // The keyed mutex chains the second caller behind the first's promise, so
    // no timer can admit it early; flushing macrotask turns gives any pending
    // scheduling a deterministic chance to run instead of a wall-clock sleep.
    for (let turn = 0; turn < 5; turn += 1) {
      await setImmediate();
    }
    expect(secondEntered).toBe(false);

    releaseFirst();
    await Promise.all([first, second]);
    expect(secondEntered).toBe(true);
  });
});
