import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { it } from '@effect/vitest';
import { Effect, FileSystem, PlatformError } from 'effect';
import { Glob } from 'glob';

import { describe, expect, vi } from 'vitest';
import type { ToolServices } from '@agent/runtime/ToolServices';

import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { installPlatform } from '@test/support/setupPlatform';
import { withTempDirEffect } from '@test/support/tempDirPlatform';
import { GlobTool } from '@tools/glob';

/**
 * A glob run in which one match's `stat` fails: the tool's own failure policy
 * is what these cases exercise, and a match that stops being stat-able
 * between the walk and the stat cannot be staged on disk.
 */
const globWithFailedStat = (
  targetPath: string,
  tag: PlatformError.SystemErrorTag,
  input: { readonly pattern: string },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const failure = PlatformError.systemError({
      _tag: tag,
      module: 'FileSystem',
      method: 'stat',
      pathOrDescriptor: targetPath,
      description: 'match is gone',
    });
    return yield* GlobTool.call(input).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        stat: (candidate: string) =>
          candidate === targetPath ? Effect.fail(failure) : fs.stat(candidate),
      }),
    );
  });

function withGlobWorkspace(
  run: (workspacePath: string) => Effect.Effect<void, unknown, ToolServices>,
) {
  return withTempDirEffect('texra-glob-tool-', (workspacePath) =>
    Effect.gen(function* () {
      yield* Effect.promise(async () => {
        await installPlatform({ workspacePath });
        await Promise.all(
          ['vanished.tex', 'blocked.tex'].map((name) =>
            writeFile(path.join(workspacePath, name), name),
          ),
        );
        // An ignored `dist/` an external search must not be matched against.
        await writeFile(path.join(workspacePath, '.gitignore'), 'dist/\n');
      });
      yield* run(workspacePath).pipe(Effect.provide(nativeToolTestLayer()));
    }).pipe(
      Effect.ensuring(
        Effect.promise(() => {
          vi.restoreAllMocks();
          return installPlatform();
        }),
      ),
    ),
  );
}

describe('GlobTool match metadata', () => {
  it.live.each([
    { fileName: 'vanished.tex', tag: 'NotFound' as const },
    { fileName: 'blocked.tex', tag: 'BadResource' as const },
  ])(
    'omits a match whose metadata lookup fails with $tag',
    ({ fileName, tag }) =>
      Effect.gen(function* () {
        yield* withGlobWorkspace((workspacePath) =>
          Effect.gen(function* () {
            const result = yield* globWithFailedStat(
              path.join(workspacePath, fileName),
              tag,
              { pattern: fileName },
            );

            expect(result).toMatchObject({ status: 'executed' });
            expect(result.output).toContain('(no matches)');
          }),
        );
      }),
  );

  it.live(
    'rejects a pattern that leaves the search directory without walking',
    () =>
      Effect.gen(function* () {
        yield* withGlobWorkspace(() =>
          Effect.gen(function* () {
            const walk = vi.spyOn(Glob.prototype, 'walk');

            const result = yield* GlobTool.call({ pattern: '../*' });

            expect(result.status).toBe('error');
            expect(result.error).toContain(
              'must stay under the search directory',
            );
            expect(walk).not.toHaveBeenCalled();
          }),
        );
      }),
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
                yield* testWorkspaceRoots().workspaceState.update(
                  WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED,
                  false,
                );

                const result = yield* GlobTool.call({
                  pattern: '**/*.tex',
                  path: externalPath,
                });

                expect(result).toMatchObject({ status: 'executed' });
                expect(result.output).toContain('external.tex');
              }),
            );
          }),
        );
      }),
  );
});
