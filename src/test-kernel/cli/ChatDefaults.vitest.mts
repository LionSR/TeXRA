import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

import { listExecutions } from '@agent/storage';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  BUILTIN_DEFAULT_CHAT_AGENT,
  BUILTIN_DEFAULT_CHAT_MODEL,
  resolveChatDefaults,
} from '@cli/runtime/chatDefaults';

vi.mock('@agent/storage', () => ({
  listExecutions: vi.fn(async () => []),
}));

const mockedListExecutions = vi.mocked(listExecutions);

function historyEntry(
  agent: string,
  overrides: Record<string, unknown> = {},
  timestamp = '2026-05-21T08:00:00.000Z',
) {
  return {
    timestamp,
    agentConfig: {
      agent,
      model: 'sonnet46T',
      agentCategory: AgentCategory.ToolUse,
      ...overrides,
    },
  } as unknown as Awaited<ReturnType<typeof listExecutions>>[number];
}

vi.mock('@utils/files/storageFS', () => ({
  GlobalStorageFS: {
    readJson: vi.fn(async () => {
      throw new Error('no user defaults');
    }),
  },
}));

describe('CLI chat defaults', () => {
  it('uses chat and DeepSeek as the built-in chat defaults', async () => {
    expect(BUILTIN_DEFAULT_CHAT_AGENT).toBe('chat');
    expect(BUILTIN_DEFAULT_CHAT_MODEL).toBe('deepseekT');
    expect(MODEL_CONFIGS[BUILTIN_DEFAULT_CHAT_MODEL]).toBeDefined();

    await expect(
      resolveChatDefaults({ cwd: '/tmp/no-such-texra-workspace' }),
    ).resolves.toMatchObject({
      agent: 'chat',
      model: 'deepseekT',
      source: 'builtin',
      agentSource: 'builtin',
      modelSource: 'builtin',
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
      agentSource: 'workspace',
      modelSource: 'builtin',
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
      agentSource: 'workspace',
      modelSource: 'env',
    });
  });

  it('inherits only the model from recent single-agent tool-use history', async () => {
    mockedListExecutions.mockResolvedValueOnce([historyEntry('research')]);

    await expect(
      resolveChatDefaults({ cwd: '/tmp/no-such-texra-workspace' }),
    ).resolves.toMatchObject({
      agent: 'chat',
      model: 'sonnet46T',
      source: 'mixed',
      agentSource: 'builtin',
      modelSource: 'history',
    });
  });

  it('does not inherit the model from a multi-agent team run', async () => {
    // A `texra multi-agent run physicist` is stored as a tool-use execution
    // whose root is the team orchestrator. It must not affect plain
    // `texra chat` defaults — fall back to the built-ins instead.
    mockedListExecutions.mockResolvedValueOnce([
      historyEntry('leanOrchestrator', {
        cliMultiAgentPresetId: 'lean-project',
      }),
    ]);

    await expect(
      resolveChatDefaults({ cwd: '/tmp/no-such-texra-workspace' }),
    ).resolves.toMatchObject({
      agent: 'chat',
      model: 'deepseekT',
      source: 'builtin',
    });
  });

  it('does not inherit stale history agent names', async () => {
    // A stale `bash` row used to win the agent tier and crash on first submit
    // with "Could not find agent: bash" — see #4397. History is now model-only,
    // so the single-chat agent stays on the built-in `chat` default.
    mockedListExecutions.mockResolvedValueOnce([
      historyEntry('bash', {}, '2026-05-21T08:02:00.000Z'),
      historyEntry('research', {}, '2026-05-21T08:01:00.000Z'),
    ]);

    await expect(
      resolveChatDefaults({ cwd: '/tmp/no-such-texra-workspace' }),
    ).resolves.toMatchObject({
      agent: 'chat',
      model: 'sonnet46T',
      agentSource: 'builtin',
      modelSource: 'history',
    });
  });

  it('skips a team run to reach an earlier single-agent model', async () => {
    mockedListExecutions.mockResolvedValueOnce([
      historyEntry(
        'orchestrator',
        {
          cliMultiAgentPresetId: 'physicist',
        },
        '2026-05-21T08:02:00.000Z',
      ),
      historyEntry('research', {}, '2026-05-21T08:01:00.000Z'),
    ]);

    await expect(
      resolveChatDefaults({ cwd: '/tmp/no-such-texra-workspace' }),
    ).resolves.toMatchObject({
      agent: 'chat',
      model: 'sonnet46T',
      agentSource: 'builtin',
      modelSource: 'history',
    });
  });

  it('does not inherit simplifier as the default single-chat agent', async () => {
    mockedListExecutions.mockResolvedValueOnce([
      historyEntry('simplifier', {}, '2026-05-21T08:02:00.000Z'),
      historyEntry('research', {}, '2026-05-21T08:01:00.000Z'),
    ]);

    await expect(
      resolveChatDefaults({ cwd: '/tmp/no-such-texra-workspace' }),
    ).resolves.toMatchObject({
      agent: 'chat',
      model: 'sonnet46T',
      agentSource: 'builtin',
      modelSource: 'history',
    });
  });

  it('still honors an explicit simplifier agent override', async () => {
    await expect(
      resolveChatDefaults({
        cwd: '/tmp/no-such-texra-workspace',
        agentOverride: 'simplifier',
        modelOverride: 'deepseekT',
      }),
    ).resolves.toMatchObject({
      agent: 'simplifier',
      agentSource: 'override',
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
