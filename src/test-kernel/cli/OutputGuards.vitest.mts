import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CliUsageError } from '@cli/runtime/cliContext';
import {
  assertOutputDirAvailable,
  assertOutputFileAvailable,
} from '@cli/runtime/workflowOutput';

async function withTempDir<T>(
  prefix: string,
  run: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('assertOutputDirAvailable', () => {
  it('no-ops when --output-dir was not passed', async () => {
    await expect(
      assertOutputDirAvailable(undefined, tmpdir()),
    ).resolves.toBeUndefined();
  });

  it('accepts a directory that already exists', async () => {
    await withTempDir('texra-cli-outdir-', async (root) => {
      const target = join(root, 'flagged');
      await mkdir(target);
      await expect(
        assertOutputDirAvailable(target, root),
      ).resolves.toBeUndefined();
    });
  });

  it('accepts a path that does not exist yet (mkdir -p happens later)', async () => {
    await withTempDir('texra-cli-outdir-', async (root) => {
      const target = join(root, 'no-such-yet');
      await expect(
        assertOutputDirAvailable(target, root),
      ).resolves.toBeUndefined();
    });
  });

  it('rejects a --output-dir that points at a file', async () => {
    // Previously: the workflow ran for ~38s and EEXIST'd on mkdir at the end
    // (exit 1). The fast path now refuses with a Usage error (exit 2).
    await withTempDir('texra-cli-outdir-', async (root) => {
      const filePath = join(root, 'oops.txt');
      await writeFile(filePath, 'not a directory');
      await expect(
        assertOutputDirAvailable(filePath, root),
      ).rejects.toBeInstanceOf(CliUsageError);
      await expect(assertOutputDirAvailable(filePath, root)).rejects.toThrow(
        /--output-dir is not a directory/,
      );
    });
  });

  it('resolves a relative --output-dir against cwd before stat-ing', async () => {
    await withTempDir('texra-cli-outdir-', async (root) => {
      const filePath = join(root, 'relative-file.txt');
      await writeFile(filePath, 'not a dir');
      // Pass just the basename; the helper joins it with cwd.
      await expect(
        assertOutputDirAvailable('relative-file.txt', root),
      ).rejects.toThrow(/--output-dir is not a directory/);
    });
  });

  it('rejects an --output-dir whose parent path component is a file (ENOTDIR)', async () => {
    // `mkdir -p` can't fix this — `/tmp/file/sub` where `/tmp/file` is a
    // regular file — so previously the fast path treated the stat ENOTDIR as
    // "doesn't exist yet" and we paid the full agent run before mkdir failed.
    await withTempDir('texra-cli-outdir-enotdir-', async (root) => {
      const filePath = join(root, 'not-a-dir');
      await writeFile(filePath, 'just a file');
      const through = join(filePath, 'subdir');
      await expect(
        assertOutputDirAvailable(through, root),
      ).rejects.toBeInstanceOf(CliUsageError);
      await expect(assertOutputDirAvailable(through, root)).rejects.toThrow(
        /is not a directory/,
      );
    });
  });

  // Skip on Windows (no POSIX chmod semantics) and when running as root, where
  // mode-0 doesn't restrict stat.
  const skipPermissionTest =
    process.platform === 'win32' ||
    (typeof process.getuid === 'function' && process.getuid() === 0);
  (skipPermissionTest ? it.skip : it)(
    'propagates non-ENOENT/ENOTDIR stat errors with their original cause',
    async () => {
      await withTempDir('texra-cli-outdir-perm-', async (root) => {
        const blocked = join(root, 'blocked');
        const inner = join(blocked, 'dir');
        try {
          await mkdir(blocked);
          await chmod(blocked, 0o000);
          await expect(assertOutputDirAvailable(inner, root)).rejects.toThrow(
            /(EACCES|permission)/i,
          );
        } finally {
          await chmod(blocked, 0o755).catch(() => undefined);
        }
      });
    },
  );
});

describe('assertOutputFileAvailable', () => {
  it('no-ops when --output was not passed', async () => {
    await expect(
      assertOutputFileAvailable(undefined, tmpdir()),
    ).resolves.toBeUndefined();
  });

  it('accepts a path that does not exist yet (writer creates the file)', async () => {
    await withTempDir('texra-cli-outfile-', async (root) => {
      await expect(
        assertOutputFileAvailable(join(root, 'out.tex'), root),
      ).resolves.toBeUndefined();
    });
  });

  it('accepts an existing file (the writer overwrites)', async () => {
    await withTempDir('texra-cli-outfile-', async (root) => {
      const target = join(root, 'existing.tex');
      await writeFile(target, 'old content');
      await expect(
        assertOutputFileAvailable(target, root),
      ).resolves.toBeUndefined();
    });
  });

  it('rejects --output pointing at an existing directory', async () => {
    // Previously: workflow ran ~19s, then EISDIR on copyfile at the end
    // (exit 1). The fast path now refuses with a Usage error (exit 2) and
    // hints at --output-dir.
    await withTempDir('texra-cli-outfile-', async (root) => {
      const dirPath = join(root, 'sub');
      await mkdir(dirPath);
      await expect(
        assertOutputFileAvailable(dirPath, root),
      ).rejects.toBeInstanceOf(CliUsageError);
      await expect(assertOutputFileAvailable(dirPath, root)).rejects.toThrow(
        /--output is a directory.*use --output-dir/,
      );
    });
  });

  it('rejects --output whose parent path component is a file (ENOTDIR)', async () => {
    // Previously: workflow ran ~40s, then EEXIST on mkdir of the parent
    // (exit 1). `mkdir -p` can't recover this — the parent IS a file.
    await withTempDir('texra-cli-outfile-', async (root) => {
      const filePath = join(root, 'not-a-dir');
      await writeFile(filePath, 'just a file');
      const through = join(filePath, 'out.tex');
      await expect(
        assertOutputFileAvailable(through, root),
      ).rejects.toBeInstanceOf(CliUsageError);
      await expect(assertOutputFileAvailable(through, root)).rejects.toThrow(
        /parent path component is a file/,
      );
    });
  });

  it('resolves a relative --output against cwd before stat-ing', async () => {
    await withTempDir('texra-cli-outfile-', async (root) => {
      const dirPath = join(root, 'rel-dir');
      await mkdir(dirPath);
      await expect(assertOutputFileAvailable('rel-dir', root)).rejects.toThrow(
        /--output is a directory/,
      );
    });
  });
});
