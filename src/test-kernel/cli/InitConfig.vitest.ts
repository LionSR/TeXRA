// Node imports
import { readFile as nodeReadFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, FileSystem, PlatformError } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import { ensureTexraGitignored } from '@cli/runtime/platform/initConfig';
import { errnoError } from '@test/support/fsTestUtils';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

const tempDirs = useTempDirs();

describe('ensureTexraGitignored', () => {
  it.effect('does not overwrite .gitignore on a non-ENOENT read failure', () =>
    Effect.gen(function* () {
      // Reproduces #7470: a transient EACCES (or any non-missing-file error)
      // must not be treated as "file absent" — that would fall through to the
      // write below and clobber the user's existing .gitignore content.
      const workspace = yield* Effect.promise(() =>
        makeTempDir('texra-gitignore-', tempDirs),
      );
      const gitignorePath = join(workspace, '.gitignore');
      yield* Effect.promise(() =>
        writeFile(gitignorePath, 'node_modules\ndist\n', 'utf8'),
      );

      const denied = PlatformError.systemError({
        _tag: 'PermissionDenied',
        module: 'FileSystem',
        method: 'readFile',
        pathOrDescriptor: gitignorePath,
        cause: errnoError('EACCES', 'EACCES: permission denied'),
      });

      const error = yield* Effect.flip(
        ensureTexraGitignored(workspace).pipe(
          Effect.provide(
            FileSystem.layerNoop({
              readFileString: () => Effect.fail(denied),
            }),
          ),
        ),
      );
      expect(error).toBe(denied);

      // Original content survives — the old bug silently overwrote it with
      // just `.texra/\n`.
      const text = yield* Effect.promise(() =>
        nodeReadFile(gitignorePath, 'utf8'),
      );
      expect(text).toBe('node_modules\ndist\n');
    }),
  );
});
