import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CliUsageError } from '../../../packages/cli/src/runtime/cliContext';
import { assertOutputDirAvailable } from '../../../packages/cli/src/commands/_helpers/workflowOutput';

describe('assertOutputDirAvailable', () => {
  it('no-ops when --output-dir was not passed', async () => {
    await expect(
      assertOutputDirAvailable(undefined, tmpdir()),
    ).resolves.toBeUndefined();
  });

  it('accepts a directory that already exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'texra-cli-outdir-'));
    try {
      const target = join(root, 'flagged');
      await mkdir(target);
      await expect(
        assertOutputDirAvailable(target, root),
      ).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts a path that does not exist yet (mkdir -p happens later)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'texra-cli-outdir-'));
    try {
      const target = join(root, 'no-such-yet');
      await expect(
        assertOutputDirAvailable(target, root),
      ).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a --output-dir that points at a file', async () => {
    // Previously: the workflow ran for ~38s and EEXIST'd on mkdir at the end
    // (exit 1). The fast path now refuses with a Usage error (exit 2).
    const root = await mkdtemp(join(tmpdir(), 'texra-cli-outdir-'));
    try {
      const filePath = join(root, 'oops.txt');
      await writeFile(filePath, 'not a directory');
      await expect(
        assertOutputDirAvailable(filePath, root),
      ).rejects.toBeInstanceOf(CliUsageError);
      await expect(
        assertOutputDirAvailable(filePath, root),
      ).rejects.toThrow(/--output-dir is not a directory/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves a relative --output-dir against cwd before stat-ing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'texra-cli-outdir-'));
    try {
      const filePath = join(root, 'relative-file.txt');
      await writeFile(filePath, 'not a dir');
      // Pass just the basename; the helper joins it with cwd.
      await expect(
        assertOutputDirAvailable('relative-file.txt', root),
      ).rejects.toThrow(/--output-dir is not a directory/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
