import { mkdtemp, readFile as nodeReadFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { workspaceTexraConfigPath } from '@platform/defaults/nodeStorage';
import {
  buildInitConfig,
  ensureTexraGitignored,
  gitignoreWithTexra,
  serializeInitConfig,
  type InitAnswers,
} from '@cli/runtime/initConfig';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const mockedReadFile = vi.mocked(nodeReadFile);

afterEach(() => {
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
      model: 'deepseekT',
      outputFormat: 'json',
      approvalPolicy: 'ask',
      chat: { agent: 'chat', model: 'deepseekT' },
    });
  });
});

describe('serializeInitConfig', () => {
  it('produces pretty JSON with a trailing newline', () => {
    const text = serializeInitConfig(buildInitConfig(ANSWERS));
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual(buildInitConfig(ANSWERS));
    expect(text).toContain('  "chat": {');
  });
});

describe('workspaceTexraConfigPath', () => {
  it('resolves the workspace path under cwd', () => {
    expect(workspaceTexraConfigPath('/projects/paper')).toBe(
      path.join('/projects/paper', '.texra', 'config.json'),
    );
  });
});

describe('gitignoreWithTexra', () => {
  it('appends .texra/ to a non-empty file', () => {
    expect(gitignoreWithTexra('node_modules\ndist\n')).toBe(
      'node_modules\ndist\n.texra/\n',
    );
  });

  it('creates content from an empty file', () => {
    expect(gitignoreWithTexra('')).toBe('.texra/\n');
  });

  it('returns null when .texra/ is already ignored', () => {
    expect(gitignoreWithTexra('node_modules\n.texra/\n')).toBeNull();
  });

  it('treats a bare .texra entry as already ignored', () => {
    expect(gitignoreWithTexra('.texra\n')).toBeNull();
  });
});

describe('ensureTexraGitignored', () => {
  it('creates .gitignore when absent', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'texra-gitignore-'));

    await expect(ensureTexraGitignored(workspace)).resolves.toBe('created');
    await expect(
      nodeReadFile(join(workspace, '.gitignore'), 'utf8'),
    ).resolves.toBe('.texra/\n');
  });

  it('appends to an existing .gitignore that does not yet ignore .texra', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'texra-gitignore-'));
    await writeFile(join(workspace, '.gitignore'), 'node_modules\n', 'utf8');

    await expect(ensureTexraGitignored(workspace)).resolves.toBe('added');
    await expect(
      nodeReadFile(join(workspace, '.gitignore'), 'utf8'),
    ).resolves.toBe('node_modules\n.texra/\n');
  });

  it('does not overwrite .gitignore on a non-ENOENT read failure', async () => {
    // Reproduces #7470: a transient EACCES (or any non-missing-file error)
    // must not be treated as "file absent" — that would fall through to the
    // write below and clobber the user's existing .gitignore content.
    const workspace = await mkdtemp(join(tmpdir(), 'texra-gitignore-'));
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
