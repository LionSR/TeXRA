/**
 * `lake` result mapping for states that are impractical to produce with a
 * real subprocess, on the scripted spawner. Kept separate from
 * LeanTools.vitest.ts, whose mutex cases run real Node subprocesses.
 */

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import * as PlatformError from 'effect/PlatformError';
import { describe, expect } from 'vitest';

// Local imports
import { scriptedSpawnerLayer } from '@test/support/childProcessTestLayer';
import { runLakeCommand } from '@tools/lean/direct/lakeCommands';

describe('runLakeCommand output failures', () => {
  const LAKE_BUILD = {
    workspaceRoot: '/workspace',
    lakeCommand: 'lake',
    args: ['build'],
  };

  it.effect(
    'keeps stderr empty for ordinary nonzero exits with stdout only',
    () =>
      Effect.gen(function* () {
        const spawner = scriptedSpawnerLayer(() => ({
          exitCode: 7,
          stdout: 'build failed in target A\n',
        }));

        const result = yield* runLakeCommand(LAKE_BUILD).pipe(
          Effect.provide(spawner.layer),
        );

        expect(result).toEqual({
          exitCode: 7,
          stdout: 'build failed in target A',
          stderr: '',
        });
        expect(spawner.calls[0]).toMatchObject({
          command: 'lake',
          args: ['build'],
          options: { cwd: '/workspace', detached: false },
        });
      }),
  );

  it.effect('names the exit code when a failing lake prints nothing', () =>
    Effect.gen(function* () {
      const spawner = scriptedSpawnerLayer(() => ({ exitCode: 3 }));

      const result = yield* runLakeCommand(LAKE_BUILD).pipe(
        Effect.provide(spawner.layer),
      );

      expect(result).toEqual({
        exitCode: 3,
        stdout: '',
        stderr: 'lake exited with code 3: lake build',
      });
    }),
  );

  it.effect('reports a lake killed by a signal as exit -1', () =>
    Effect.gen(function* () {
      const spawner = scriptedSpawnerLayer(() => ({
        exitCode: PlatformError.systemError({
          _tag: 'Unknown',
          module: 'ChildProcess',
          method: 'exitCode',
        }),
      }));

      const result = yield* runLakeCommand(LAKE_BUILD).pipe(
        Effect.provide(spawner.layer),
      );

      expect(result.exitCode).toBe(-1);
      expect(result.stderr).toMatch(/^Command was killed: /);
    }),
  );

  it.effect('reports a lake that cannot start as exit -1', () =>
    Effect.gen(function* () {
      const spawner = scriptedSpawnerLayer(() =>
        PlatformError.systemError({
          _tag: 'NotFound',
          module: 'ChildProcess',
          method: 'spawn',
        }),
      );

      const result = yield* runLakeCommand(LAKE_BUILD).pipe(
        Effect.provide(spawner.layer),
      );

      expect(result.exitCode).toBe(-1);
      expect(result.stderr).toBe('Command could not start: NotFound');
    }),
  );
});
