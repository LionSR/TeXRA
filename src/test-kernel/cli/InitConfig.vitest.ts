import { readFile as nodeReadFile, writeFile } from 'node:fs/promises';
import path, { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildInitConfig,
  ensureTexraGitignored,
  gitignoreWithTexra,
  serializeInitConfig,
  writeInitConfig,
  type InitAnswers,
} from '@cli/runtime/initConfig';
import {
  loadWorkspaceCliConfig,
  setWorkspaceCliChatAgent,
} from '@cli/runtime/cliConfig';
import { workspaceTexraConfigPath } from '@platform/defaults/nodeStorage';
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

describe('buildInitConfig', () => {
  it('maps answers to the canonical config shape', () => {
    expect(buildInitConfig(ANSWERS)).toEqual({
      'texra.model': 'deepseekT',
      'texra.outputFormat': 'json',
      'texra.approvalPolicy': 'ask',
      'texra.chat': { agent: 'chat', model: 'deepseekT' },
    });
  });
});

describe('serializeInitConfig', () => {
  it('produces pretty JSON with a trailing newline', () => {
    const text = serializeInitConfig(buildInitConfig(ANSWERS));
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual(buildInitConfig(ANSWERS));
    expect(text).toContain('  "texra.chat": {');
  });
});

describe('workspaceTexraConfigPath', () => {
  it('resolves the workspace path under cwd', () => {
    expect(workspaceTexraConfigPath('/projects/paper')).toBe(
      path.join('/projects/paper', '.texra', 'config.json'),
    );
  });
});

describe('setWorkspaceCliChatAgent', () => {
  it('updates only chat.agent and preserves other workspace defaults', async () => {
    const workspace = await makeTempDir('texra-chat-default-', tempDirs);
    const configPath = workspaceTexraConfigPath(workspace);
    await writeInitConfig(configPath, buildInitConfig(ANSWERS));

    await setWorkspaceCliChatAgent(workspace, 'builtInToolUse:review');

    const raw = JSON.parse(await nodeReadFile(configPath, 'utf8')) as {
      'texra.model': string;
      'texra.chat': { agent: string; model: string };
    };
    expect(raw['texra.model']).toBe('deepseekT');
    expect(raw['texra.chat']).toEqual({
      agent: 'builtInToolUse:review',
      model: 'deepseekT',
    });
    expect((await loadWorkspaceCliConfig(workspace)).values.chat?.agent).toBe(
      'builtInToolUse:review',
    );

    await setWorkspaceCliChatAgent(workspace, undefined);
    expect((await loadWorkspaceCliConfig(workspace)).values.chat).toEqual({
      model: 'deepseekT',
    });
  });
});

describe('gitignoreWithTexra', () => {
  it.each([
    [
      'appends to content',
      'node_modules\ndist\n',
      'node_modules\ndist\n.texra/\n',
    ],
    ['creates content', '', '.texra/\n'],
    ['recognizes .texra/', 'node_modules\n.texra/\n', null],
    ['recognizes bare .texra', '.texra\n', null],
  ])('%s', (_case, existing, expected) => {
    expect(gitignoreWithTexra(existing)).toBe(expected);
  });
});

describe('ensureTexraGitignored', () => {
  it.each([
    ['creates an absent file', undefined, 'created', '.texra/\n'],
    [
      'appends to existing content',
      'node_modules\n',
      'added',
      'node_modules\n.texra/\n',
    ],
  ] as const)('%s', async (_case, existing, outcome, expected) => {
    const workspace = await makeTempDir('texra-gitignore-', tempDirs);
    const gitignorePath = join(workspace, '.gitignore');
    if (existing !== undefined)
      await writeFile(gitignorePath, existing, 'utf8');

    await expect(ensureTexraGitignored(workspace)).resolves.toBe(outcome);
    await expect(nodeReadFile(gitignorePath, 'utf8')).resolves.toBe(expected);
  });

  it('does not overwrite .gitignore on a non-ENOENT read failure', async () => {
    // Reproduces #7470: a transient EACCES (or any non-missing-file error)
    // must not be treated as "file absent" — that would fall through to the
    // write below and clobber the user's existing .gitignore content.
    const workspace = await makeTempDir('texra-gitignore-', tempDirs);
    const gitignorePath = join(workspace, '.gitignore');
    await writeFile(gitignorePath, 'node_modules\ndist\n', 'utf8');

    const eacces = Object.assign(new Error('EACCES: permission denied'), {
      code: 'EACCES',
    });
    mockedReadFile.mockImplementationOnce(async () => {
      throw eacces;
    });

    await expect(ensureTexraGitignored(workspace)).rejects.toBe(eacces);

    // Original content survives — the old bug silently overwrote it with
    // just `.texra/\n`.
    await expect(nodeReadFile(gitignorePath, 'utf8')).resolves.toBe(
      'node_modules\ndist\n',
    );
  });
});
