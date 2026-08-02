import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CliUsageError } from '@cli/runtime/cliContext';
import {
  assertOutputDirAvailable,
  assertOutputFileAvailable,
  probeOutputPathForTests,
} from '@cli/runtime/workflowOutput';
import { cleanupTempDirs, makeTempDir } from '@test/support/tempDirPlatform';

const tempDirs: string[] = [];

afterEach(async () => {
  await cleanupTempDirs(tempDirs);
});

function missingError(message = 'missing'): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: 'ENOENT' });
}

const outputFlagCases = [
  {
    flagLabel: '--output-dir' as const,
    fileMessage:
      '--output-dir is not a directory (a parent path component is a file)',
    danglingMessage: '--output-dir is a dangling symbolic link',
  },
  {
    flagLabel: '--output' as const,
    fileMessage: '--output: a parent path component is a file',
    danglingMessage: '--output is a dangling symbolic link',
  },
];

const windowsAncestorCases = [
  {
    label: 'drive',
    fileAncestor: String.raw`C:\workspace\blocked`,
    target: String.raw`C:\workspace\blocked\missing-one\missing-two\output.tex`,
  },
  {
    label: 'UNC',
    fileAncestor: String.raw`\\server\share\workspace\blocked`,
    target: String.raw`\\server\share\workspace\blocked\missing-one\missing-two\output.tex`,
  },
];

const rootCases = [
  {
    label: 'POSIX',
    dirname: posix.dirname,
    target: '/missing/output.tex',
    candidates: ['/missing/output.tex', '/missing', '/'],
  },
  {
    label: 'Windows drive',
    dirname: win32.dirname,
    target: String.raw`C:\missing\output.tex`,
    candidates: [
      String.raw`C:\missing\output.tex`,
      String.raw`C:\missing`,
      'C:\\',
    ],
  },
  {
    label: 'Windows UNC',
    dirname: win32.dirname,
    target: String.raw`\\server\share\missing\output.tex`,
    candidates: [
      String.raw`\\server\share\missing\output.tex`,
      String.raw`\\server\share\missing`,
      '\\\\server\\share\\',
    ],
  },
];

describe('probeOutputPath', () => {
  describe.each(windowsAncestorCases)(
    '$label paths',
    ({ fileAncestor, target }) => {
      it.each(outputFlagCases)(
        'walks past Windows-shaped ENOENT and reports a file ancestor for $flagLabel',
        async ({ flagLabel, fileMessage }) => {
          const missingCandidates = [
            target,
            win32.dirname(target),
            win32.dirname(win32.dirname(target)),
          ];
          const statVisited: string[] = [];
          const lstatVisited: string[] = [];

          await expect(
            probeOutputPathForTests(target, flagLabel, {
              dirname: win32.dirname,
              stat: async (candidate) => {
                statVisited.push(candidate);
                if (candidate === fileAncestor) {
                  return { isDirectory: () => false };
                }
                throw missingError();
              },
              lstat: async (candidate) => {
                lstatVisited.push(candidate);
                throw missingError();
              },
            }),
          ).rejects.toThrow(`${fileMessage}: ${target}`);
          expect(statVisited).toEqual([...missingCandidates, fileAncestor]);
          expect(lstatVisited).toEqual(missingCandidates);
        },
      );
    },
  );

  it('stops at the nearest existing directory for a creatable target', async () => {
    const ancestor = String.raw`C:\workspace`;
    const target = String.raw`C:\workspace\missing\output.tex`;
    const statVisited: string[] = [];
    const lstatVisited: string[] = [];

    await expect(
      probeOutputPathForTests(target, '--output', {
        dirname: win32.dirname,
        stat: async (candidate) => {
          statVisited.push(candidate);
          if (candidate === ancestor) return { isDirectory: () => true };
          throw missingError();
        },
        lstat: async (candidate) => {
          lstatVisited.push(candidate);
          throw missingError();
        },
      }),
    ).resolves.toBeUndefined();
    expect(statVisited).toEqual([
      target,
      String.raw`C:\workspace\missing`,
      ancestor,
    ]);
    expect(lstatVisited).toEqual([target, String.raw`C:\workspace\missing`]);
  });

  it.each(rootCases)(
    'propagates ENOENT after exhausting a $label root',
    async ({ dirname, target, candidates }) => {
      const rootError = missingError('missing root');
      const statVisited: string[] = [];
      const lstatVisited: string[] = [];

      await expect(
        probeOutputPathForTests(target, '--output', {
          dirname,
          stat: async (candidate) => {
            statVisited.push(candidate);
            throw missingError();
          },
          lstat: async (candidate) => {
            lstatVisited.push(candidate);
            if (candidate === candidates.at(-1)) throw rootError;
            throw missingError();
          },
        }),
      ).rejects.toBe(rootError);
      expect(statVisited).toEqual(candidates);
      expect(lstatVisited).toEqual(candidates);
    },
  );

  it.each(outputFlagCases)(
    'rejects a dangling target symlink for $flagLabel',
    async ({ flagLabel, danglingMessage }) => {
      const target = String.raw`C:\workspace\dangling`;
      const statVisited: string[] = [];
      const lstatVisited: string[] = [];

      await expect(
        probeOutputPathForTests(target, flagLabel, {
          dirname: win32.dirname,
          stat: async (candidate) => {
            statVisited.push(candidate);
            throw missingError();
          },
          lstat: async (candidate) => {
            lstatVisited.push(candidate);
            return {
              isDirectory: () => false,
              isSymbolicLink: () => true,
            };
          },
        }),
      ).rejects.toThrow(`${danglingMessage}: ${target}`);
      expect(statVisited).toEqual([target, target]);
      expect(lstatVisited).toEqual([target]);
    },
  );

  it('rejects a dangling symlink ancestor without walking past it', async () => {
    const dangling = String.raw`C:\workspace\dangling`;
    const target = String.raw`C:\workspace\dangling\missing\output.tex`;
    const statVisited: string[] = [];
    const lstatVisited: string[] = [];

    await expect(
      probeOutputPathForTests(target, '--output', {
        dirname: win32.dirname,
        stat: async (candidate) => {
          statVisited.push(candidate);
          throw missingError();
        },
        lstat: async (candidate) => {
          lstatVisited.push(candidate);
          if (candidate === dangling) {
            return {
              isDirectory: () => false,
              isSymbolicLink: () => true,
            };
          }
          throw missingError();
        },
      }),
    ).rejects.toThrow(
      `--output: a parent path component is a dangling symbolic link: ${target}`,
    );
    expect(statVisited).toEqual([
      target,
      win32.dirname(target),
      dangling,
      dangling,
    ]);
    expect(lstatVisited).toEqual([target, win32.dirname(target), dangling]);
  });

  it('propagates unexpected lstat errors', async () => {
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    await expect(
      probeOutputPathForTests('/missing/output.tex', '--output', {
        dirname: win32.dirname,
        stat: async () => {
          throw missingError();
        },
        lstat: async () => {
          throw denied;
        },
      }),
    ).rejects.toBe(denied);
  });
});

describe('dangling output symlinks', () => {
  it('rejects a real dangling symlink for both output modes', async (context) => {
    const root = await makeTempDir('texra-cli-dangling-output-', tempDirs);
    const dangling = join(root, 'dangling');
    try {
      await symlink(
        join(root, 'absent'),
        dangling,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error: unknown) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? error.code
          : undefined;
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
      assertOutputDirAvailable(dangling, root),
    ).rejects.toBeInstanceOf(CliUsageError);
    await expect(assertOutputDirAvailable(dangling, root)).rejects.toThrow(
      `--output-dir is a dangling symbolic link: ${dangling}`,
    );
    await expect(
      assertOutputFileAvailable(dangling, root),
    ).rejects.toBeInstanceOf(CliUsageError);
    await expect(assertOutputFileAvailable(dangling, root)).rejects.toThrow(
      `--output is a dangling symbolic link: ${dangling}`,
    );
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

  it('accepts a path that does not exist yet (mkdir -p happens later)', async () => {
    const root = await makeTempDir('texra-cli-outdir-', tempDirs);
    const target = join(root, 'no-such-yet');
    await expect(
      assertOutputDirAvailable(target, root),
    ).resolves.toBeUndefined();
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

  // Skip on Windows (no POSIX chmod semantics) and when running as root, where
  // mode-0 doesn't restrict stat.
  const skipPermissionTest =
    process.platform === 'win32' ||
    (typeof process.getuid === 'function' && process.getuid() === 0);
  (skipPermissionTest ? it.skip : it)(
    'propagates non-ENOENT/ENOTDIR stat errors with their original cause',
    async () => {
      const root = await makeTempDir('texra-cli-outdir-perm-', tempDirs);
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
