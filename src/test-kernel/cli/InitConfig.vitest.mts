import {
  chmod,
  mkdtemp,
  readFile as nodeReadFile,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { workspaceTexraConfigPath } from '@platform/defaults/nodeStorage';
import {
  buildInitConfig,
  ensureTexraGitignored,
  gitignoreWithTexra,
  serializeInitConfig,
  writeInitConfig,
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
    const workspace = await mkdtemp(join(tmpdir(), 'texra-gitignore-'));
    const gitignorePath = join(workspace, '.gitignore');
    if (existing !== undefined)
      await writeFile(gitignorePath, existing, 'utf8');

    await expect(ensureTexraGitignored(workspace)).resolves.toBe(outcome);
    await expect(nodeReadFile(gitignorePath, 'utf8')).resolves.toBe(expected);
  });

  const skipPermissionTest =
    process.platform === 'win32' ||
    (typeof process.getuid === 'function' && process.getuid() === 0);
  (skipPermissionTest ? it.skip : it)(
    'does not atomically replace a read-only .gitignore',
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), 'texra-gitignore-'));
      const gitignorePath = join(workspace, '.gitignore');
      await writeFile(gitignorePath, 'node_modules\n', 'utf8');
      await chmod(gitignorePath, 0o444);

      try {
        await expect(ensureTexraGitignored(workspace)).rejects.toThrow(
          /(EACCES|permission)/i,
        );
        await expect(nodeReadFile(gitignorePath, 'utf8')).resolves.toBe(
          'node_modules\n',
        );
      } finally {
        await chmod(gitignorePath, 0o644);
      }
    },
  );

  (skipPermissionTest ? it.skip : it)(
    'still atomically replaces a write-only config',
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), 'texra-config-'));
      const configPath = workspaceTexraConfigPath(workspace);
      await writeInitConfig(configPath, buildInitConfig(ANSWERS));
      await chmod(configPath, 0o200);

      try {
        const updated = buildInitConfig({ ...ANSWERS, model: 'gemini35f' });
        await expect(
          writeInitConfig(configPath, updated),
        ).resolves.toBeUndefined();
        await chmod(configPath, 0o600);
        await expect(nodeReadFile(configPath, 'utf8')).resolves.toContain(
          '"model": "gemini35f"',
        );
      } finally {
        await chmod(configPath, 0o600);
      }
    },
  );

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
