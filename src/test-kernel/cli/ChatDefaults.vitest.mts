import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

import {
  BUILTIN_DEFAULT_CHAT_MODEL,
  resolveChatDefaults,
} from '../../../packages/cli/src/runtime/chatDefaults';

vi.mock('@agent/storage', () => ({
  listExecutions: vi.fn(async () => []),
}));

vi.mock('@utils/files/storageFS', () => ({
  GlobalStorageFS: {
    readJson: vi.fn(async () => {
      throw new Error('no user defaults');
    }),
  },
}));

describe('CLI chat defaults', () => {
  it('uses DeepSeek as the built-in chat model', async () => {
    expect(BUILTIN_DEFAULT_CHAT_MODEL).toBe('deepseekT');
    expect(MODEL_CONFIGS[BUILTIN_DEFAULT_CHAT_MODEL]).toBeDefined();

    await expect(
      resolveChatDefaults({ cwd: '/tmp/no-such-texra-workspace' }),
    ).resolves.toMatchObject({
      agent: 'chat',
      model: 'deepseekT',
      source: 'builtin',
    });
  });

  it('ignores non-llm-zoo model ids in workspace defaults', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'texra-chat-defaults-'));
    await mkdir(join(workspace, '.texra'), { recursive: true });
    await writeFile(
      join(workspace, '.texra', 'config.json'),
      JSON.stringify({ agent: 'chat', model: 'claude-opus-4-7' }),
    );

    await expect(
      resolveChatDefaults({ cwd: workspace }),
    ).resolves.toMatchObject({
      agent: 'chat',
      model: 'deepseekT',
      source: 'mixed',
    });
  });

  it('uses command-specific workspace defaults below environment overrides', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'texra-chat-defaults-'));
    await mkdir(join(workspace, '.texra'), { recursive: true });
    await writeFile(
      join(workspace, '.texra', 'config.json'),
      JSON.stringify({
        agent: 'generic',
        model: 'gpt55',
        chat: { agent: 'chat', model: 'deepseekT' },
      }),
    );

    await expect(
      resolveChatDefaults({ cwd: workspace, envModel: 'sonnet46T' }),
    ).resolves.toMatchObject({
      agent: 'chat',
      model: 'sonnet46T',
      source: 'mixed',
    });
  });

  it('uses prefixed command-specific workspace defaults', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'texra-chat-defaults-'));
    await mkdir(join(workspace, '.texra'), { recursive: true });
    await writeFile(
      join(workspace, '.texra', 'config.json'),
      JSON.stringify({
        'texra.agent': 'generic',
        'texra.model': 'gpt55',
        'texra.chat': { agent: 'chat', model: 'deepseekT' },
      }),
    );

    await expect(
      resolveChatDefaults({ cwd: workspace }),
    ).resolves.toMatchObject({
      agent: 'chat',
      model: 'deepseekT',
      source: 'workspace',
    });
  });
});
