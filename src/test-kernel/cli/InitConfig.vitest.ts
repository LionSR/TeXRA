// Node imports
import { readFile as nodeReadFile, writeFile } from 'node:fs/promises';
import path, { join } from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, FileSystem, PlatformError } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import {
  buildInitConfig,
  ensureTexraGitignored,
  writeInitConfig,
  type InitAnswers,
} from '@cli/runtime/initConfig';
import { setWorkspaceCliChatAgent } from '@cli/runtime/cliConfig';
import { workspaceTexraConfigPath } from '@platform/defaults/nodeStorage';
import { errnoError, nodePlatformLayer } from '@test/support/fsTestUtils';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { FakeConfigProvider } from '@test/support/FakePlatform';
import { installPlatform } from '@test/support/setupPlatform';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { readSettingFrom } from '@utils/config/platformSettings';

const tempDirs = useTempDirs();

const ANSWERS: InitAnswers = {
  agent: 'chat',
  model: 'deepseekT',
  approvalPolicy: 'ask',
  outputFormat: 'json',
};

describe('writeInitConfig', () => {
  it.effect('writes pretty JSON with a trailing newline', () =>
    Effect.gen(function* () {
      const workspace = yield* Effect.promise(() =>
        makeTempDir('texra-init-config-', tempDirs),
      );
      const configPath = workspaceTexraConfigPath(workspace);

      yield* writeInitConfig(configPath, buildInitConfig(ANSWERS)).pipe(
        Effect.provide(nodePlatformLayer),
      );

      const text = yield* Effect.promise(() =>
        nodeReadFile(configPath, 'utf8'),
      );
      expect(text.endsWith('\n')).toBe(true);
      expect(JSON.parse(text)).toEqual(buildInitConfig(ANSWERS));
      expect(text).toContain('  "texra.chat": {');
    }),
  );
});

describe('setWorkspaceCliChatAgent', () => {
  it.effect(
    'updates only chat.agent and preserves the other command defaults',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          installPlatform(
            {},
            {
              config: new FakeConfigProvider({
                'texra.model': 'deepseekT',
                'texra.chat': { agent: 'chat', model: 'deepseekT' },
              }),
            },
          ),
        );
        const chatSection = () =>
          readSettingFrom(testWorkspaceRoots(), 'texra.chat');

        yield* setWorkspaceCliChatAgent(
          testWorkspaceRoots(),
          'builtInToolUse:review',
        );
        expect(yield* chatSection()).toEqual({
          agent: 'builtInToolUse:review',
          model: 'deepseekT',
        });
        expect(
          yield* readSettingFrom(testWorkspaceRoots(), 'texra.model'),
        ).toBe('deepseekT');

        yield* setWorkspaceCliChatAgent(testWorkspaceRoots(), undefined);
        expect(yield* chatSection()).toEqual({ model: 'deepseekT' });
      }),
  );

  it.effect('leaves a user-level model out of the workspace section', () =>
    Effect.gen(function* () {
      const config = new FakeConfigProvider();
      yield* Effect.promise(() => installPlatform({}, { config }));
      yield* config.update('texra.chat', { model: 'deepseekT' }, 'global');

      yield* setWorkspaceCliChatAgent(
        testWorkspaceRoots(),
        'builtInToolUse:review',
      );

      expect(config.inspect('texra.chat')?.workspaceValue).toEqual({
        agent: 'builtInToolUse:review',
      });
    }),
  );

  it.effect('refuses an empty agent rather than clearing the default', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        installPlatform({}, { config: new FakeConfigProvider() }),
      );
      const error = yield* Effect.flip(
        setWorkspaceCliChatAgent(testWorkspaceRoots(), '   '),
      );
      expect(error.message).toContain('must not be empty');
    }),
  );
});

describe('ensureTexraGitignored', () => {
  it.effect.each([
    ['creates an absent file', undefined, 'created', '.texra/\n'],
    [
      'appends to existing content',
      'node_modules\ndist\n',
      'added',
      'node_modules\ndist\n.texra/\n',
    ],
    [
      'leaves a file that already ignores .texra/ untouched',
      'node_modules\n.texra/\n',
      'present',
      'node_modules\n.texra/\n',
    ],
    ['recognizes a bare .texra entry', '.texra\n', 'present', '.texra\n'],
  ] as const)('%s', ([_case, existing, outcome, expected]) =>
    Effect.gen(function* () {
      const workspace = yield* Effect.promise(() =>
        makeTempDir('texra-gitignore-', tempDirs),
      );
      const gitignorePath = join(workspace, '.gitignore');
      if (existing !== undefined)
        yield* Effect.promise(() => writeFile(gitignorePath, existing, 'utf8'));

      const result = yield* ensureTexraGitignored(workspace).pipe(
        Effect.provide(nodePlatformLayer),
      );
      expect(result).toBe(outcome);
      const text = yield* Effect.promise(() =>
        nodeReadFile(gitignorePath, 'utf8'),
      );
      expect(text).toBe(expected);
    }),
  );

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
