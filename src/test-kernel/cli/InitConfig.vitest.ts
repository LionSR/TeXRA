// Node imports
import { readFile as nodeReadFile, writeFile } from 'node:fs/promises';
import path, { join } from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

// Local imports
import {
  buildInitConfig,
  ensureTexraGitignored,
  writeInitConfig,
  type InitAnswers,
} from '@cli/runtime/initConfig';
import { setWorkspaceCliChatAgent } from '@cli/runtime/cliConfig';
import { workspaceTexraConfigPath } from '@platform/defaults/nodeStorage';
import { readSettingFrom } from '@utils/config/platformSettings';
import { FakeConfigProvider } from '@test/support/FakePlatform';
import { installPlatform } from '@test/support/setupPlatform';
import { platformSettingsStores } from '@utils/config/platformSettings';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const mockedReadFile = vi.mocked(nodeReadFile);

const tempDirs = useTempDirs();

afterEach(async () => {
  mockedReadFile.mockClear();
});

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

      yield* Effect.promise(() =>
        writeInitConfig(configPath, buildInitConfig(ANSWERS)),
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
  it('updates only chat.agent and preserves the other command defaults', async () => {
    await installPlatform(
      {},
      {
        config: new FakeConfigProvider({
          'texra.model': 'deepseekT',
          'texra.chat': { agent: 'chat', model: 'deepseekT' },
        }),
      },
    );
    const chatSection = () =>
      readSettingFrom(platformSettingsStores(), 'texra.chat');

    await Effect.runPromise(setWorkspaceCliChatAgent('builtInToolUse:review'));
    expect(chatSection()).toEqual({
      agent: 'builtInToolUse:review',
      model: 'deepseekT',
    });
    expect(readSettingFrom(platformSettingsStores(), 'texra.model')).toBe(
      'deepseekT',
    );

    await Effect.runPromise(setWorkspaceCliChatAgent(undefined));
    expect(chatSection()).toEqual({ model: 'deepseekT' });
  });

  it('refuses an empty agent rather than clearing the default', async () => {
    await installPlatform({}, { config: new FakeConfigProvider() });

    await expect(
      Effect.runPromise(setWorkspaceCliChatAgent('   ')),
    ).rejects.toThrow('must not be empty');
  });
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

      const result = yield* Effect.promise(() =>
        ensureTexraGitignored(workspace),
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

      const eacces = Object.assign(new Error('EACCES: permission denied'), {
        code: 'EACCES',
      });
      mockedReadFile.mockImplementationOnce(async () => {
        throw eacces;
      });

      const error = yield* Effect.flip(
        Effect.tryPromise({
          try: () => ensureTexraGitignored(workspace),
          catch: (thrown) => thrown,
        }),
      );
      expect(error).toBe(eacces);

      // Original content survives — the old bug silently overwrote it with
      // just `.texra/\n`.
      const text = yield* Effect.promise(() =>
        nodeReadFile(gitignorePath, 'utf8'),
      );
      expect(text).toBe('node_modules\ndist\n');
    }),
  );
});
