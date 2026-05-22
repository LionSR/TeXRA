import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

import { listExecutions } from '@agent/storage';
import { AgentCategory } from '@agent/core/AgentDataclass';

import {
  BUILTIN_DEFAULT_CHAT_MODEL,
  resolveChatDefaults,
} from '../../../packages/cli/src/runtime/chatDefaults';

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

  it('inherits the agent from the most recent single-agent tool-use execution', async () => {
    mockedListExecutions.mockResolvedValueOnce([historyEntry('research')]);

    await expect(
      resolveChatDefaults({ cwd: '/tmp/no-such-texra-workspace' }),
    ).resolves.toMatchObject({ agent: 'research', source: 'history' });
  });

  it('does not inherit the orchestrator from a multi-agent team run', async () => {
    // A `texra multi-agent run physicist` is stored as a tool-use execution
    // whose root is the team orchestrator. It must not become the default
    // agent for a plain `texra chat` — fall back to the built-in instead.
    mockedListExecutions.mockResolvedValueOnce([
      historyEntry('leanOrchestrator', {
        cliMultiAgentPresetId: 'lean-project',
      }),
    ]);

    await expect(
      resolveChatDefaults({ cwd: '/tmp/no-such-texra-workspace' }),
    ).resolves.toMatchObject({ agent: 'chat', source: 'builtin' });
  });

  it('skips a team run to reach an earlier single-agent execution', async () => {
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
    ).resolves.toMatchObject({ agent: 'research', source: 'history' });
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
