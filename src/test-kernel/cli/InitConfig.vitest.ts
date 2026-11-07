// Node imports
import { readFile as nodeReadFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Third-party imports
import { it, layer } from '@effect/vitest';
import { Effect, FileSystem, PlatformError } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import { Settings } from '@texra-ai/harness/host';
import { ensureTexraGitignored } from '@cli/runtime/platform/initConfig';
import { setWorkspaceCliChatAgent } from '@cli/runtime/platform/cliConfig';
import { errnoError } from '@test/support/fsTestUtils';
import { FakeHost } from '@test/support/testKernel';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { TEXRA_APP } from '@test/support/texraApp';

const tempDirs = useTempDirs();

layer(
  FakeHost.layer({
    app: TEXRA_APP,
    config: {
      model: 'deepseek/deepseek-v4-flash',
      chat: {
        agent: 'chat',
        model: 'deepseek/deepseek-v4-flash',
      },
    },
  }),
)('setWorkspaceCliChatAgent', (it) => {
  it.effect(
    'updates only chat.agent and preserves the other command defaults',
    () =>
      Effect.gen(function* () {
        const { roots } = yield* FakeHost;
        const chatSection = () => Settings.get(roots, 'chat');

        yield* setWorkspaceCliChatAgent(roots, 'builtIn:review');
        expect(yield* chatSection()).toEqual({
          agent: 'builtIn:review',
          model: 'deepseek/deepseek-v4-flash',
        });
        expect(yield* Settings.get(roots, 'model')).toBe(
          'deepseek/deepseek-v4-flash',
        );

        yield* setWorkspaceCliChatAgent(roots, undefined);
        expect(yield* chatSection()).toEqual({
          model: 'deepseek/deepseek-v4-flash',
        });
      }),
  );
});

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
