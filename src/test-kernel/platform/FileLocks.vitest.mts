import { mkdtemp, rm } from 'node:fs/promises';
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
  it('serializes independent callers using the same shared path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'texra-file-lock-'));
    tempDirs.push(root);
    const lockPath = join(root, 'execution-locks', 'a8644a');
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
