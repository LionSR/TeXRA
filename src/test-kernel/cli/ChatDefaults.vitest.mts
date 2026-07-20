import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

import { listExecutions } from '@agent/storage';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  BUILTIN_DEFAULT_CHAT_MODEL,
  resolveChatDefaults,
} from '@cli/runtime/chatDefaults';
import { BUILTIN_DEFAULT_CHAT_AGENT } from '@cli/runtime/defaultAgents';
import * as logSinks from '@cli/runtime/logSinks';
import type { ExecutionId } from '@shared/schemas';
import { GlobalStorageFS } from '@utils/files/storageFS';

/** A missing user config, shaped like a genuine `fs` ENOENT rejection. */
function enoentError(): NodeJS.ErrnoException {
  const error = new Error(
    'ENOENT: no such file or directory',
  ) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

vi.mock('@agent/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/storage')>()),
  listExecutions: vi.fn(async () => []),
}));

const mockedListExecutions = vi.mocked(listExecutions);

function historyEntry(
  agent: string,
  overrides: Record<string, unknown> = {},
  timestamp = '2026-05-21T08:00:00.000Z',
) {
  return {
    kind: 'agent',
    id: 'abc123' as ExecutionId,
    timestamp,
    agentConfig: AgentConfigSchema.parse({
      agent,
      model: 'sonnet46T',
      agentCategory: AgentCategory.ToolUse,
      ...overrides,
    }),
  } satisfies Awaited<ReturnType<typeof listExecutions>>[number];
}

vi.mock('@utils/files/storageFS', () => ({
  GlobalStorageFS: {
    readJson: vi.fn(async () => {
      throw new Error('no user defaults');
    }),
  },
}));

const mockedReadJson = vi.mocked(GlobalStorageFS.readJson);

beforeEach(() => {
  mockedListExecutions.mockReset();
  mockedListExecutions.mockResolvedValue([]);
  mockedReadJson.mockReset();
  // A missing user config (the common case) mirrors a real ENOENT rejection.
  mockedReadJson.mockRejectedValue(enoentError());
});

async function workspaceWithConfig(config: unknown): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'texra-chat-defaults-'));
  await mkdir(join(workspace, '.texra'), { recursive: true });
  await writeFile(
    join(workspace, '.texra', 'config.json'),
    JSON.stringify(config),
  );
  return workspace;
}

describe('CLI chat defaults', () => {
  it('uses assistant and DeepSeek as the built-in chat defaults', async () => {
    expect(BUILTIN_DEFAULT_CHAT_AGENT).toBe('assistant');
    expect(BUILTIN_DEFAULT_CHAT_MODEL).toBe('deepseekproT');
    expect(MODEL_CONFIGS[BUILTIN_DEFAULT_CHAT_MODEL]).toBeDefined();

    await expect(
      resolveChatDefaults({ cwd: '/tmp/no-such-texra-workspace' }),
    ).resolves.toMatchObject({
      agent: 'assistant',
      model: 'deepseekproT',
      source: 'builtin',
      agentSource: 'builtin-default',
      modelSource: 'builtin-default',
    });
  });

  it('uses the first visible tool-use agent when assistant is hidden by a roster', async () => {
    await expect(
      resolveChatDefaults({
        cwd: '/tmp/no-such-texra-workspace',
        visibleToolUseAgents: [{ name: 'research' }, { name: 'review' }],
      }),
    ).resolves.toMatchObject({
      agent: 'research',
      model: 'deepseekproT',
      source: 'builtin',
      agentSource: 'builtin-default',
    });
  });

  it('ignores non-llm-zoo model ids in workspace defaults', async () => {
    const workspace = await workspaceWithConfig({
      agent: 'assistant',
      model: 'claude-opus-4-7',
    });

    await expect(
      resolveChatDefaults({ cwd: workspace }),
    ).resolves.toMatchObject({
      agent: 'assistant',
      model: 'deepseekproT',
      source: 'mixed',
      agentSource: 'workspace-config',
      modelSource: 'builtin-default',
    });
  });

  it('uses command-specific workspace defaults below environment overrides', async () => {
    const workspace = await workspaceWithConfig({
      agent: 'generic',
      model: 'gpt55',
      chat: { agent: 'assistant', model: 'deepseekT' },
    });

    await expect(
      resolveChatDefaults({ cwd: workspace, envModel: 'sonnet46T' }),
    ).resolves.toMatchObject({
      agent: 'assistant',
      model: 'sonnet46T',
      source: 'mixed',
      agentSource: 'workspace-config',
      modelSource: 'environment',
    });
  });

  it('inherits only the model from recent single-agent tool-use history', async () => {
    mockedListExecutions.mockResolvedValueOnce([historyEntry('research')]);

    await expect(
      resolveChatDefaults({ cwd: '/tmp/no-such-texra-workspace' }),
    ).resolves.toMatchObject({
      // History contributes the model only; the agent stays on the built-in
      // default rather than the history row's agent.
      agent: 'assistant',
      model: 'sonnet46T',
      source: 'mixed',
      agentSource: 'builtin-default',
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
      agent: 'assistant',
      model: 'deepseekproT',
      source: 'builtin',
    });
  });

  it('does not inherit stale history agent names', async () => {
    // A stale `bash` row used to win the agent tier and crash on first submit
    // with "Could not find agent: bash" — see #4397. History is now model-only,
    // so the single-chat agent stays on the built-in `assistant` default.
    mockedListExecutions.mockResolvedValueOnce([
      historyEntry('bash', {}, '2026-05-21T08:02:00.000Z'),
      historyEntry('research', {}, '2026-05-21T08:01:00.000Z'),
    ]);

    await expect(
      resolveChatDefaults({ cwd: '/tmp/no-such-texra-workspace' }),
    ).resolves.toMatchObject({
      agent: 'assistant',
      model: 'sonnet46T',
      agentSource: 'builtin-default',
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
      agent: 'assistant',
      model: 'sonnet46T',
      agentSource: 'builtin-default',
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
      agent: 'assistant',
      model: 'sonnet46T',
      agentSource: 'builtin-default',
      modelSource: 'history',
    });
  });

  it('ignores simplifier from configured chat default tiers', async () => {
    const workspace = await workspaceWithConfig({
      chat: { agent: 'simplifier', model: 'sonnet46T' },
    });

    await expect(
      resolveChatDefaults({ cwd: workspace }),
    ).resolves.toMatchObject({
      agent: 'assistant',
      model: 'sonnet46T',
      agentSource: 'builtin-default',
      modelSource: 'workspace-config',
    });

    mockedReadJson.mockResolvedValueOnce({
      agent: 'simplifier',
      model: 'sonnet46T',
    });
    await expect(
      resolveChatDefaults({
        cwd: '/tmp/no-such-texra-workspace',
      }),
    ).resolves.toMatchObject({
      agent: 'assistant',
      model: 'sonnet46T',
      agentSource: 'builtin-default',
      modelSource: 'user-config',
    });
  });

  it('does not honor TEXRA_AGENT=simplifier as a default agent', async () => {
    await expect(
      resolveChatDefaults({
        cwd: '/tmp/no-such-texra-workspace',
        envAgent: 'simplifier',
      }),
    ).resolves.toMatchObject({
      agent: 'assistant',
      agentSource: 'builtin-default',
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
      agentSource: 'explicit-override',
    });
  });

  it('skips user and history I/O when explicit overrides resolve agent and model', async () => {
    const workspace = await workspaceWithConfig({
      chat: { agent: 'assistant', model: 'sonnet46T' },
    });

    await expect(
      resolveChatDefaults({
        cwd: workspace,
        agentOverride: 'simplifier',
        modelOverride: 'deepseekT',
      }),
    ).resolves.toMatchObject({
      agent: 'simplifier',
      model: 'deepseekT',
      source: 'mixed',
      agentSource: 'explicit-override',
      modelSource: 'explicit-override',
    });
    expect(mockedReadJson).not.toHaveBeenCalled();
    expect(mockedListExecutions).not.toHaveBeenCalled();
  });

  it('skips user and history I/O when environment resolves agent and model', async () => {
    await expect(
      resolveChatDefaults({
        cwd: '/tmp/no-such-texra-workspace',
        envAgent: 'assistant',
        envModel: 'sonnet46T',
      }),
    ).resolves.toMatchObject({
      agent: 'assistant',
      model: 'sonnet46T',
      source: 'mixed',
      agentSource: 'environment',
      modelSource: 'environment',
    });
    expect(mockedReadJson).not.toHaveBeenCalled();
    expect(mockedListExecutions).not.toHaveBeenCalled();
  });

  it('still loads history when only the agent is directly resolved', async () => {
    mockedListExecutions.mockResolvedValueOnce([historyEntry('research')]);

    await expect(
      resolveChatDefaults({
        cwd: '/tmp/no-such-texra-workspace',
        agentOverride: 'simplifier',
      }),
    ).resolves.toMatchObject({
      agent: 'simplifier',
      model: 'sonnet46T',
      agentSource: 'explicit-override',
      modelSource: 'history',
    });
    expect(mockedListExecutions).toHaveBeenCalledOnce();
  });

  it('uses prefixed command-specific workspace defaults', async () => {
    const workspace = await workspaceWithConfig({
      'texra.agent': 'generic',
      'texra.model': 'gpt55',
      'texra.chat': { agent: 'assistant', model: 'deepseekT' },
    });

    await expect(
      resolveChatDefaults({ cwd: workspace }),
    ).resolves.toMatchObject({
      agent: 'assistant',
      model: 'deepseekT',
      source: 'workspace',
    });
  });

  it('uses the shared config parser for prefixed user chat defaults', async () => {
    mockedReadJson.mockResolvedValueOnce({
      'texra.agent': 'generic',
      'texra.model': 'gpt55',
      'texra.chat': { agent: 'assistant', model: 'deepseekT' },
    });

    await expect(
      resolveChatDefaults({
        cwd: '/tmp/no-such-texra-workspace',
      }),
    ).resolves.toMatchObject({
      agent: 'assistant',
      model: 'deepseekT',
      source: 'user',
      agentSource: 'user-config',
      modelSource: 'user-config',
    });
  });

  it('warns instead of silently dropping defaults when the user config is corrupt', async () => {
    // Not an ENOENT — e.g. truncated/hand-edited JSON, or a permission error.
    // The old behavior caught every readJson failure alike and silently fell
    // through to {}, indistinguishable from "no user config".
    const corrupt = new Error('Failed to parse JSON from config.json');
    mockedReadJson.mockRejectedValueOnce(corrupt);
    const warnSpy = vi
      .spyOn(logSinks, 'writeTextStderr')
      .mockImplementation(() => {});

    await expect(
      resolveChatDefaults({ cwd: '/tmp/no-such-texra-workspace' }),
    ).resolves.toMatchObject({
      agent: 'assistant',
      model: 'deepseekproT',
      source: 'builtin',
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('config.json'),
    );
    warnSpy.mockRestore();
  });
});
