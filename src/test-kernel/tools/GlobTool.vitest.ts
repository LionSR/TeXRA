import { mkdir, utimes, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';

import { describe, expect, vi } from 'vitest';
import type { ToolServices } from '@agent/runtime/ToolServices';

import { platform } from '@platform/platform';
import { workspaceRoots } from '@platform/workspaceRoots';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { installPlatform } from '@test/support/setupPlatform';
import { errnoError } from '@test/support/fsTestUtils';
import { withTempDirEffect } from '@test/support/tempDirPlatform';
import { GlobTool } from '@tools/glob';

function failStatFor(
  workspacePath: string,
  fileName: string,
  error: Error,
): void {
  const fs = platform().fs;
  const stat = fs.stat.bind(fs);
  const targetPath = path.join(workspacePath, fileName);
  vi.spyOn(fs, 'stat').mockImplementation(async (candidate) => {
    if (candidate === targetPath) throw error;
    return stat(candidate);
  });
}

function withGlobWorkspace(
  run: (workspacePath: string) => Effect.Effect<void, unknown, ToolServices>,
) {
  return Effect.gen(function* () {
    yield* withTempDirEffect('texra-glob-tool-', (workspacePath) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          installPlatform({ workspacePath }, { fs: nodeFilesystem }),
        );
        try {
          yield* Effect.promise(() =>
            Promise.all(
              [
                'new.tex',
                'old.tex',
                'vanished.tex',
                'blocked.tex',
                'unreadable.tex',
              ].map((name) => writeFile(path.join(workspacePath, name), name)),
            ),
          );
          yield* Effect.promise(() =>
            writeFile(path.join(workspacePath, '.gitignore'), 'dist/\n'),
          );
          yield* Effect.promise(() =>
            utimes(path.join(workspacePath, 'old.tex'), 1, 1),
          );
          yield* Effect.promise(() =>
            utimes(path.join(workspacePath, 'new.tex'), 2, 2),
          );
          yield* run(workspacePath);
        } finally {
          vi.restoreAllMocks();
          yield* Effect.promise(() => installPlatform());
        }
      }),
    );
  });
}

describe('GlobTool match metadata', () => {
  it.live('orders matches by modification time', () =>
    Effect.gen(function* () {
      yield* withGlobWorkspace(() =>
        Effect.gen(function* () {
          const result = yield* new GlobTool().call({
            pattern: '{old,new}.tex',
          });

          expect(result.status).toBe('executed');
          expect(result.output).toContain('new.tex');
          expect(result.output).toContain('old.tex');
          const output = result.output ?? '';
          expect(output.indexOf('new.tex')).toBeLessThan(
            output.indexOf('old.tex'),
          );
        }),
      );
    }).pipe(Effect.provide(nativeToolTestLayer())),
  );

  it.live.each([
    {
      fileName: 'vanished.tex',
      error: errnoError('ENOENT', 'match disappeared'),
    },
    {
      fileName: 'blocked.tex',
      error: errnoError('ENOTDIR', 'parent changed'),
    },
  ])(
    'omits a match whose metadata lookup fails with $error.code',
    ({ fileName, error }) =>
      Effect.gen(function* () {
        yield* withGlobWorkspace((workspacePath) =>
          Effect.gen(function* () {
            failStatFor(workspacePath, fileName, error);

            const result = yield* new GlobTool().call({ pattern: fileName });

            expect(result).toMatchObject({ status: 'executed' });
            expect(result.output).toContain('(no matches)');
          }),
        );
      }).pipe(Effect.provide(nativeToolTestLayer())),
  );

  it.live('surfaces operational stat failures through the tool boundary', () =>
    Effect.gen(function* () {
      yield* withGlobWorkspace((workspacePath) =>
        Effect.gen(function* () {
          failStatFor(
            workspacePath,
            'unreadable.tex',
            errnoError('EACCES', 'match is unreadable'),
          );

          expect(
            yield* new GlobTool().call({ pattern: 'unreadable.tex' }),
          ).toMatchObject({
            status: 'error',
            error: 'match is unreadable',
          });
        }),
      );
    }).pipe(Effect.provide(nativeToolTestLayer())),
  );

  it.live(
    'does not pass unrestricted external paths to the workspace ignore matcher',
    () =>
      Effect.gen(function* () {
        yield* withGlobWorkspace(() =>
          Effect.gen(function* () {
            yield* withTempDirEffect('texra-glob-external-', (externalPath) =>
              Effect.gen(function* () {
                const externalDistPath = path.join(externalPath, 'dist');
                yield* Effect.promise(() => mkdir(externalDistPath));
                yield* Effect.promise(() =>
                  writeFile(
                    path.join(externalDistPath, 'external.tex'),
                    'external',
                  ),
                );
                yield* Effect.promise(() =>
                  workspaceRoots().workspaceState.update(
                    WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED,
                    false,
                  ),
                );

                const result = yield* new GlobTool().call({
                  pattern: '**/*.tex',
                  path: externalPath,
                });

                expect(result).toMatchObject({ status: 'executed' });
                expect(result.output).toContain('external.tex');
              }),
            );
          }),
        );
      }).pipe(Effect.provide(nativeToolTestLayer())),
  );
});
