import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFakePlatform } from '@test/support/FakePlatform';
import { setupPlatform } from '@test/support/setupPlatform';
import { cleanupTempDirs, makeTempDir } from '@test/support/tempDirPlatform';
import { isGitRepository } from '@utils/git/isGitRepository';

const execFileAsync = promisify(execFile);

describe('isGitRepository', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await cleanupTempDirs(tempDirs);
  });

  function tempRepoDir(): Promise<string> {
    return makeTempDir('texra-is-git-repo-', tempDirs);
  }

  it('returns true for a real git repository', async () => {
    const dir = await tempRepoDir();
    await execFileAsync('git', ['init'], { cwd: dir });

    await expect(isGitRepository(dir)).resolves.toBe(true);
  });

  it('returns false for a plain directory that is not a git repository', async () => {
    const dir = await tempRepoDir();

    await expect(isGitRepository(dir)).resolves.toBe(false);
  });

  describe('with no workspace configured', () => {
    setupPlatform({ workspacePath: undefined });

    it('returns false when no rootPath is given', async () => {
      await expect(isGitRepository()).resolves.toBe(false);
    });
  });

  describe('falling back to the workspace path', () => {
    let dir: string;

    beforeEach(async () => {
      dir = await tempRepoDir();
      await execFileAsync('git', ['init'], { cwd: dir });
    });

    // Builder form: re-reads `dir` at beforeEach time, after the block above
    // (registered first in this describe) has already set it.
    setupPlatform(() => createFakePlatform({ workspacePath: dir }));

    it('returns true when no rootPath is given', async () => {
      await expect(isGitRepository()).resolves.toBe(true);
    });
  });
});
