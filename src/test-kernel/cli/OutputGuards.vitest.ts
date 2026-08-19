import { mkdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CliUsageError } from '@cli/runtime/cliContext';
import {
  assertOutputDirAvailable,
  assertOutputFileAvailable,
  probeOutputPathForTests,
} from '@cli/runtime/workflowOutput';
import { errnoError } from '@test/support/fsTestUtils';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

const tempDirs = useTempDirs();

// Every probe case below starts from a stat that reports the target missing.
function probeDeps(
  mkdir: (candidate: string) => Promise<string | undefined>,
): Parameters<typeof probeOutputPathForTests>[2] {
  return {
    dirname: win32.dirname,
    stat: async () => {
      throw errnoError('ENOENT');
    },
    mkdir,
  };
}

describe('probeOutputPath', () => {
  const windowsCases = [
    {
      label: 'drive',
      target: String.raw`C:\workspace\blocked\missing\output.tex`,
      outputParent: String.raw`C:\workspace\blocked\missing`,
    },
    {
      label: 'UNC',
      target: String.raw`\\server\share\blocked\missing\output.tex`,
      outputParent: String.raw`\\server\share\blocked\missing`,
    },
  ];

  const windowsBlockedCases = windowsCases.flatMap((testCase) =>
    ['ENOTDIR', 'EEXIST'].map((mkdirCode) => ({ ...testCase, mkdirCode })),
  );

  it.each(windowsBlockedCases)(
    'maps native $mkdirCode after Windows-shaped ENOENT for a $label output path',
    async ({ target, outputParent, mkdirCode }) => {
      const mkdirVisited: string[] = [];
      await expect(
        probeOutputPathForTests(
          target,
          '--output',
          probeDeps(async (candidate) => {
            mkdirVisited.push(candidate);
            throw errnoError(mkdirCode);
          }),
        ),
      ).rejects.toThrow(
        `--output: a parent path component is a file: ${target}`,
      );
      expect(mkdirVisited).toEqual([outputParent]);
    },
  );

  it('materializes the complete --output-dir path after ENOENT', async () => {
    const target = String.raw`C:\workspace\missing\output`;
    const mkdirVisited: string[] = [];
    await expect(
      probeOutputPathForTests(
        target,
        '--output-dir',
        probeDeps(async (candidate) => {
          mkdirVisited.push(candidate);
          return candidate;
        }),
      ),
    ).resolves.toBeNull();
    expect(mkdirVisited).toEqual([target]);
  });

  it.each([
    {
      flagLabel: '--output' as const,
      expectedDirectory: '/missing',
      expectedMessage:
        '--output parent directory cannot be created: /missing/output.tex',
    },
    {
      flagLabel: '--output-dir' as const,
      expectedDirectory: '/missing/output.tex',
      expectedMessage: '--output-dir cannot be created: /missing/output.tex',
    },
  ])(
    'reports mkdir ENOENT before execution for $flagLabel',
    async ({ flagLabel, expectedDirectory, expectedMessage }) => {
      const mkdirVisited: string[] = [];
      await expect(
        probeOutputPathForTests(
          '/missing/output.tex',
          flagLabel,
          probeDeps(async (candidate) => {
            mkdirVisited.push(candidate);
            throw errnoError('ENOENT');
          }),
        ),
      ).rejects.toThrow(expectedMessage);
      expect(mkdirVisited).toEqual([expectedDirectory]);
    },
  );

  it('preserves unexpected mkdir failures', async () => {
    const denied = errnoError('EACCES', 'denied');
    await expect(
      probeOutputPathForTests(
        '/missing/output.tex',
        '--output',
        probeDeps(async () => {
          throw denied;
        }),
      ),
    ).rejects.toBe(denied);
  });
});

describe('dangling output symlinks', () => {
  it('keeps a dangling --output symlink writable and rejects a dangling --output-dir before execution', async (context) => {
    const root = await makeTempDir('texra-cli-dangling-output-', tempDirs);
    const fileReferent = join(root, 'absent.tex');
    const fileLink = join(root, 'file-link.tex');
    const directoryReferent = join(root, 'absent-directory');
    const directoryLink = join(root, 'directory-link');
    try {
      await symlink(fileReferent, fileLink, 'file');
      await symlink(
        directoryReferent,
        directoryLink,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (
        typeof code === 'string' &&
        ['EACCES', 'EINVAL', 'ENOSYS', 'ENOTSUP', 'EPERM'].includes(code)
      ) {
        context.skip();
        return;
      }
      throw error;
    }

    await expect(
      assertOutputFileAvailable(fileLink, root),
    ).resolves.toBeUndefined();
    await expect(
      assertOutputDirAvailable(directoryLink, root),
    ).rejects.toBeInstanceOf(CliUsageError);
    await expect(stat(directoryReferent)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('assertOutputDirAvailable', () => {
  it('no-ops when --output-dir was not passed', async () => {
    await expect(
      assertOutputDirAvailable(undefined, tmpdir()),
    ).resolves.toBeUndefined();
  });

  it('accepts a directory that already exists', async () => {
    const root = await makeTempDir('texra-cli-outdir-', tempDirs);
    const target = join(root, 'flagged');
    await mkdir(target);
    await expect(
      assertOutputDirAvailable(target, root),
    ).resolves.toBeUndefined();
  });

  it('creates and accepts a path that does not exist yet', async () => {
    const root = await makeTempDir('texra-cli-outdir-', tempDirs);
    const target = join(root, 'no-such-yet');
    await expect(
      assertOutputDirAvailable(target, root),
    ).resolves.toBeUndefined();
    expect((await stat(target)).isDirectory()).toBe(true);
  });

  it('rejects a --output-dir that points at a file', async () => {
    // Previously: the workflow ran for ~38s and EEXIST'd on mkdir at the end
    // (exit 1). The fast path now refuses with a Usage error (exit 2).
    const root = await makeTempDir('texra-cli-outdir-', tempDirs);
    const filePath = join(root, 'oops.txt');
    await writeFile(filePath, 'not a directory');
    await expect(
      assertOutputDirAvailable(filePath, root),
    ).rejects.toBeInstanceOf(CliUsageError);
    await expect(assertOutputDirAvailable(filePath, root)).rejects.toThrow(
      /--output-dir is not a directory/,
    );
  });

  it('resolves a relative --output-dir against cwd before stat-ing', async () => {
    const root = await makeTempDir('texra-cli-outdir-', tempDirs);
    const filePath = join(root, 'relative-file.txt');
    await writeFile(filePath, 'not a dir');
    // Pass just the basename; the helper joins it with cwd.
    await expect(
      assertOutputDirAvailable('relative-file.txt', root),
    ).rejects.toThrow(/--output-dir is not a directory/);
  });

  it('rejects an --output-dir whose parent path component is a file (ENOTDIR)', async () => {
    // `mkdir -p` can't fix this — `/tmp/file/sub` where `/tmp/file` is a
    // regular file — so previously the fast path treated the stat ENOTDIR as
    // "doesn't exist yet" and we paid the full agent run before mkdir failed.
    const root = await makeTempDir('texra-cli-outdir-enotdir-', tempDirs);
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

describe('assertOutputFileAvailable', () => {
  it('no-ops when --output was not passed', async () => {
    await expect(
      assertOutputFileAvailable(undefined, tmpdir()),
    ).resolves.toBeUndefined();
  });

  it('accepts a path that does not exist yet (writer creates the file)', async () => {
    const root = await makeTempDir('texra-cli-outfile-', tempDirs);
    await expect(
      assertOutputFileAvailable(join(root, 'out.tex'), root),
    ).resolves.toBeUndefined();
  });

  it('accepts an existing file (the writer overwrites)', async () => {
    const root = await makeTempDir('texra-cli-outfile-', tempDirs);
    const target = join(root, 'existing.tex');
    await writeFile(target, 'old content');
    await expect(
      assertOutputFileAvailable(target, root),
    ).resolves.toBeUndefined();
  });

  it('rejects --output pointing at an existing directory', async () => {
    // Previously: workflow ran ~19s, then EISDIR on copyfile at the end
    // (exit 1). The fast path now refuses with a Usage error (exit 2) and
    // hints at --output-dir.
    const root = await makeTempDir('texra-cli-outfile-', tempDirs);
    const dirPath = join(root, 'sub');
    await mkdir(dirPath);
    await expect(
      assertOutputFileAvailable(dirPath, root),
    ).rejects.toBeInstanceOf(CliUsageError);
    await expect(assertOutputFileAvailable(dirPath, root)).rejects.toThrow(
      /--output is a directory.*use --output-dir/,
    );
  });

  it('rejects --output whose parent path component is a file (ENOTDIR)', async () => {
    // Previously: workflow ran ~40s, then EEXIST on mkdir of the parent
    // (exit 1). `mkdir -p` can't recover this — the parent IS a file.
    const root = await makeTempDir('texra-cli-outfile-', tempDirs);
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

  it('resolves a relative --output against cwd before stat-ing', async () => {
    const root = await makeTempDir('texra-cli-outfile-', tempDirs);
    const dirPath = join(root, 'rel-dir');
    await mkdir(dirPath);
    await expect(assertOutputFileAvailable('rel-dir', root)).rejects.toThrow(
      /--output is a directory/,
    );
  });
});
