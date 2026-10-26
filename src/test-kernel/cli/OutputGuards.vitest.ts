import { mkdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as NodePath from '@effect/platform-node/NodePath';
import { it } from '@effect/vitest';
import { Effect, FileSystem, Layer, type Path, PlatformError } from 'effect';
import { describe, expect } from 'vitest';

import { CliUsageError } from '@cli/runtime/cliContext';
import {
  assertOutputDirAvailable,
  assertOutputFileAvailable,
  probeOutputPathForTests,
} from '@cli/runtime/workflowOutput';
import { errnoError, nodePlatformLayer } from '@test/support/fsTestUtils';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

const tempDirs = useTempDirs();

function sysError(
  tag: PlatformError.SystemErrorTag,
  method: string,
  target: string,
  code: string,
): PlatformError.PlatformError {
  return PlatformError.systemError({
    _tag: tag,
    module: 'FileSystem',
    method,
    pathOrDescriptor: target,
    cause: errnoError(code),
  });
}

// Every probe case below starts from a stat that reports the target missing;
// dirname comes from win32 path semantics.
function probeLayer(
  makeDirectory: (
    candidate: string,
  ) => Effect.Effect<void, PlatformError.PlatformError>,
): Layer.Layer<FileSystem.FileSystem | Path.Path> {
  return Layer.mergeAll(
    FileSystem.layerNoop({
      stat: (target) =>
        Effect.fail(sysError('NotFound', 'stat', target, 'ENOENT')),
      makeDirectory,
      access: () => Effect.void,
    }),
    NodePath.layerWin32,
  );
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
    (
      [
        ['ENOTDIR', 'BadResource'],
        ['EEXIST', 'AlreadyExists'],
      ] as const
    ).map(([mkdirCode, mkdirTag]) => ({ ...testCase, mkdirCode, mkdirTag })),
  );

  it.effect.each(windowsBlockedCases)(
    'maps native $mkdirCode after Windows-shaped ENOENT for a $label output path',
    ({ target, outputParent, mkdirCode, mkdirTag }) =>
      Effect.gen(function* () {
        const mkdirVisited: string[] = [];
        const error = yield* Effect.flip(
          probeOutputPathForTests(target, '--output').pipe(
            Effect.provide(
              probeLayer((candidate) => {
                mkdirVisited.push(candidate);
                return Effect.fail(
                  sysError(mkdirTag, 'makeDirectory', candidate, mkdirCode),
                );
              }),
            ),
          ),
        );
        expect(error.message).toContain(
          `--output: a parent path component is a file: ${target}`,
        );
        expect(mkdirVisited).toEqual([outputParent]);
      }),
  );

  it.effect('materializes the complete --output-dir path after ENOENT', () =>
    Effect.gen(function* () {
      const target = String.raw`C:\workspace\missing\output`;
      const mkdirVisited: string[] = [];
      const result = yield* probeOutputPathForTests(
        target,
        '--output-dir',
      ).pipe(
        Effect.provide(
          probeLayer((candidate) => {
            mkdirVisited.push(candidate);
            return Effect.void;
          }),
        ),
      );
      expect(result).toBeNull();
      expect(mkdirVisited).toEqual([target]);
    }),
  );

  it.effect.each([
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
    'reports mkdir ENOENT before run for $flagLabel',
    ({ flagLabel, expectedDirectory, expectedMessage }) =>
      Effect.gen(function* () {
        const mkdirVisited: string[] = [];
        const error = yield* Effect.flip(
          probeOutputPathForTests('/missing/output.tex', flagLabel).pipe(
            Effect.provide(
              probeLayer((candidate) => {
                mkdirVisited.push(candidate);
                return Effect.fail(
                  sysError('NotFound', 'makeDirectory', candidate, 'ENOENT'),
                );
              }),
            ),
          ),
        );
        expect(error.message).toContain(expectedMessage);
        expect(mkdirVisited).toEqual([expectedDirectory]);
      }),
  );

  it.effect.each([
    { tag: 'PermissionDenied' as const, code: 'EACCES' },
    { tag: 'Unknown' as const, code: 'EPERM' },
  ])('reports a mkdir $code as a usage error', ({ tag, code }) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        probeOutputPathForTests('/missing/output.tex', '--output').pipe(
          Effect.provide(
            probeLayer((candidate) =>
              Effect.fail(sysError(tag, 'makeDirectory', candidate, code)),
            ),
          ),
        ),
      );
      expect(error.message).toBe(
        '--output is not writable (permission denied): /missing/output.tex',
      );
    }),
  );
});

// `it.live`, not `it.effect`, for the suites below: they probe the real
// filesystem, so a TestContext clock starting at 0 would be a trap rather
// than a help.
describe('dangling output symlinks', () => {
  it.live(
    'keeps a dangling --output symlink writable and rejects a dangling --output-dir before run',
    (context) =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() =>
          makeTempDir('texra-cli-dangling-output-', tempDirs),
        );
        const fileReferent = join(root, 'absent.tex');
        const fileLink = join(root, 'file-link.tex');
        const directoryReferent = join(root, 'absent-directory');
        const directoryLink = join(root, 'directory-link');
        const linkError = yield* Effect.match(
          Effect.tryPromise({
            try: async () => {
              await symlink(fileReferent, fileLink, 'file');
              await symlink(
                directoryReferent,
                directoryLink,
                process.platform === 'win32' ? 'junction' : 'dir',
              );
            },
            catch: (error: unknown) => error,
          }),
          {
            onSuccess: () => undefined,
            onFailure: (error: unknown) => error,
          },
        );
        if (linkError !== undefined) {
          const code = (linkError as NodeJS.ErrnoException | undefined)?.code;
          if (
            typeof code === 'string' &&
            ['EACCES', 'EINVAL', 'ENOSYS', 'ENOTSUP', 'EPERM'].includes(code)
          ) {
            context.skip();
            return;
          }
          throw linkError;
        }

        expect(
          yield* assertOutputFileAvailable(fileLink, root),
        ).toBeUndefined();

        const dirError = yield* Effect.flip(
          assertOutputDirAvailable(directoryLink, root),
        );
        expect(dirError).toBeInstanceOf(CliUsageError);

        const statError = yield* Effect.flip(
          Effect.tryPromise({
            try: () => stat(directoryReferent),
            catch: (error: unknown) => error,
          }),
        );
        expect(statError).toMatchObject({ code: 'ENOENT' });
      }).pipe(Effect.provide(nodePlatformLayer)),
  );
});

describe('assertOutputDirAvailable', () => {
  it.live('rejects a --output-dir that points at a file', () =>
    Effect.gen(function* () {
      // Previously: the workflow ran for ~38s and EEXIST'd on mkdir at the end
      // (exit 1). The fast path now refuses with a Usage error (exit 2).
      const root = yield* Effect.promise(() =>
        makeTempDir('texra-cli-outdir-', tempDirs),
      );
      const filePath = join(root, 'oops.txt');
      yield* Effect.promise(() => writeFile(filePath, 'not a directory'));
      const error = yield* Effect.flip(
        assertOutputDirAvailable(filePath, root),
      );
      expect(error).toBeInstanceOf(CliUsageError);
      expect(error.message).toMatch(/--output-dir is not a directory/);
    }).pipe(Effect.provide(nodePlatformLayer)),
  );
});

describe('assertOutputFileAvailable', () => {
  it.live('rejects --output pointing at an existing directory', () =>
    Effect.gen(function* () {
      // Previously: workflow ran ~19s, then EISDIR on copyfile at the end
      // (exit 1). The fast path now refuses with a Usage error (exit 2) and
      // hints at --output-dir.
      const root = yield* Effect.promise(() =>
        makeTempDir('texra-cli-outfile-', tempDirs),
      );
      const dirPath = join(root, 'sub');
      yield* Effect.promise(() => mkdir(dirPath));
      const error = yield* Effect.flip(
        assertOutputFileAvailable(dirPath, root),
      );
      expect(error).toBeInstanceOf(CliUsageError);
      expect(error.message).toMatch(
        /--output is a directory.*use --output-dir/,
      );
    }).pipe(Effect.provide(nodePlatformLayer)),
  );
});
