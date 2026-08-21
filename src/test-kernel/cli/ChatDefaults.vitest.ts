import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

import { listExecutions } from '@agent/storage';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { resolveChatDefaults } from '@cli/runtime/chatDefaults';
import {
  CLI_BUILTIN_DEFAULT_MODEL,
  loadWorkspaceCliConfig,
} from '@cli/runtime/cliConfig';
import { BUILTIN_DEFAULT_CHAT_AGENT } from '@cli/runtime/defaultAgents';
import * as logSinks from '@cli/runtime/logSinks';
import type { ExecutionId } from '@shared/schemas';
import { AgentCategory } from '@shared/schemas';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { GlobalStorageFS } from '@utils/files/storageFS';

/** A cwd with no `.texra` directory, so the workspace tier finds nothing. */
const NO_WORKSPACE = '/tmp/no-such-texra-workspace';

/**
 * Shared config layers exercised at both the workspace and user tiers: an
 * unprefixed `texra.agent`/`texra.model` pair plus a prefixed `texra.chat`
 * override, so tests can assert the command-specific layer wins.
 */
const CHAT_TIER_CONFIG = {
  'texra.agent': 'generic',
  'texra.model': 'gpt55',
  'texra.chat': { agent: 'assistant', model: 'deepseekT' },
};

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

// Spied, not stubbed: the workspace tiers below still read real `.texra`
// config files, while the fast-path tests assert the loader is never reached.
vi.mock('@cli/runtime/cliConfig', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@cli/runtime/cliConfig')>();
  return {
    ...actual,
    loadWorkspaceCliConfig: vi.fn(actual.loadWorkspaceCliConfig),
  };
});

const mockedListExecutions = vi.mocked(listExecutions);
const mockedLoadWorkspaceCliConfig = vi.mocked(loadWorkspaceCliConfig);

function historyEntry(
  agent: string,
  overrides: Record<string, unknown> = {},
  timestamp = '2026-05-21T08:00:00.000Z',
) {
  return {
    kind: 'run',
    id: 'abc123' as ExecutionId,
    timestamp,
    identity: { kind: 'agent', agent },
    record: AgentConfigSchema.parse({
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
  mockedLoadWorkspaceCliConfig.mockClear();
  mockedListExecutions.mockReset();
  mockedListExecutions.mockResolvedValue([]);
  mockedReadJson.mockReset();
  // A missing user config (the common case) mirrors a real ENOENT rejection.
  mockedReadJson.mockRejectedValue(enoentError());
});

const tempDirs = useTempDirs();

async function workspaceWithConfig(config: unknown): Promise<string> {
  const workspace = await makeTempDir('texra-chat-defaults-', tempDirs);
  await mkdir(join(workspace, '.texra'), { recursive: true });
  await writeFile(
    join(workspace, '.texra', 'config.json'),
    JSON.stringify(config),
  );
  return workspace;
}

function expectChatDefaults(
  options: Parameters<typeof resolveChatDefaults>[0],
  expected: Record<string, unknown>,
): Promise<void> {
  return expect(resolveChatDefaults(options)).resolves.toMatchObject(expected);
}

describe('CLI chat defaults', () => {
  it('uses assistant and DeepSeek as the built-in chat defaults', async () => {
    expect(BUILTIN_DEFAULT_CHAT_AGENT).toBe('assistant');
    expect(CLI_BUILTIN_DEFAULT_MODEL).toBe('deepseekproT');
    expect(MODEL_CONFIGS[CLI_BUILTIN_DEFAULT_MODEL]).toBeDefined();

    await expectChatDefaults(
      { cwd: NO_WORKSPACE },
      {
        agent: 'assistant',
        model: 'deepseekproT',
        source: 'builtin',
        agentSource: 'builtin-default',
        modelSource: 'builtin-default',
      },
    );
  });

  it('uses the first visible tool-use agent when assistant is hidden by a roster', async () => {
    await expectChatDefaults(
      {
        cwd: NO_WORKSPACE,
        visibleToolUseAgents: [{ name: 'research' }, { name: 'review' }],
      },
      {
        agent: 'research',
        model: 'deepseekproT',
        source: 'builtin',
        agentSource: 'builtin-default',
      },
    );
  });

  it('ignores non-llm-zoo model ids in workspace defaults', async () => {
    const workspace = await workspaceWithConfig({
      'texra.agent': 'assistant',
      'texra.model': 'claude-opus-4-7',
    });

    await expectChatDefaults(
      { cwd: workspace },
      {
        agent: 'assistant',
        model: 'deepseekproT',
        source: 'mixed',
        agentSource: 'workspace-config',
        modelSource: 'builtin-default',
      },
    );
  });

  it('uses command-specific workspace defaults below environment overrides', async () => {
    const workspace = await workspaceWithConfig(CHAT_TIER_CONFIG);

    await expectChatDefaults(
      { cwd: workspace, envModel: 'sonnet46T' },
      {
        agent: 'assistant',
        model: 'sonnet46T',
        source: 'mixed',
        agentSource: 'workspace-config',
        modelSource: 'environment',
      },
    );
  });

  it('inherits only the model from recent single-agent tool-use history', async () => {
    mockedListExecutions.mockResolvedValueOnce([historyEntry('research')]);

    await expectChatDefaults(
      { cwd: NO_WORKSPACE },
      {
        // History contributes the model only; the agent stays on the built-in
        // default rather than the history row's agent.
        agent: 'assistant',
        model: 'sonnet46T',
        source: 'mixed',
        agentSource: 'builtin-default',
        modelSource: 'history',
      },
    );
  });

  it('ignores a history model that the CLI cannot run', async () => {
    mockedListExecutions.mockResolvedValueOnce([
      historyEntry('research', { model: 'Copilot GPT-4o' }),
    ]);

    await expectChatDefaults(
      { cwd: NO_WORKSPACE },
      {
        agent: 'assistant',
        model: 'deepseekproT',
        source: 'builtin',
        modelSource: 'builtin-default',
      },
    );
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

    await expectChatDefaults(
      { cwd: NO_WORKSPACE },
      {
        agent: 'assistant',
        model: 'deepseekproT',
        source: 'builtin',
      },
    );
  });

  // A stale `bash` row used to win the agent tier and crash on first submit
  // with "Could not find agent: bash" — see #4397. History is now model-only,
  // so the single-chat agent stays on the built-in `assistant` default; the
  // same holds for `simplifier`, which is never a default chat agent.
  it.each(['bash', 'simplifier'])(
    'does not inherit %s as the default single-chat agent',
    async (agent) => {
      mockedListExecutions.mockResolvedValueOnce([
        historyEntry(agent, {}, '2026-05-21T08:02:00.000Z'),
        historyEntry('research', {}, '2026-05-21T08:01:00.000Z'),
      ]);

      await expectChatDefaults(
        { cwd: NO_WORKSPACE },
        {
          agent: 'assistant',
          model: 'sonnet46T',
          agentSource: 'builtin-default',
          modelSource: 'history',
        },
      );
    },
  );

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

    await expectChatDefaults(
      { cwd: NO_WORKSPACE },
      {
        agent: 'assistant',
        model: 'sonnet46T',
        agentSource: 'builtin-default',
        modelSource: 'history',
      },
    );
  });

  it('ignores simplifier from configured chat default tiers', async () => {
    const workspace = await workspaceWithConfig({
      'texra.chat': { agent: 'simplifier', model: 'sonnet46T' },
    });

    await expectChatDefaults(
      { cwd: workspace },
      {
        agent: 'assistant',
        model: 'sonnet46T',
        agentSource: 'builtin-default',
        modelSource: 'workspace-config',
      },
    );

    mockedReadJson.mockResolvedValueOnce({
      'texra.agent': 'simplifier',
      'texra.model': 'sonnet46T',
    });
    await expectChatDefaults(
      { cwd: NO_WORKSPACE },
      {
        agent: 'assistant',
        model: 'sonnet46T',
        agentSource: 'builtin-default',
        modelSource: 'user-config',
      },
    );
  });

  it('does not honor TEXRA_AGENT=simplifier as a default agent', async () => {
    await expectChatDefaults(
      { cwd: NO_WORKSPACE, envAgent: 'simplifier' },
      {
        agent: 'assistant',
        agentSource: 'builtin-default',
      },
    );
  });

  it('still honors an explicit simplifier agent override', async () => {
    await expectChatDefaults(
      {
        cwd: NO_WORKSPACE,
        agentOverride: 'simplifier',
        modelOverride: 'deepseekT',
      },
      {
        agent: 'simplifier',
        agentSource: 'explicit-override',
      },
    );
  });

  it('skips workspace, user, and history I/O when explicit overrides resolve agent and model', async () => {
    const workspace = await workspaceWithConfig({
      'texra.chat': { agent: 'assistant', model: 'sonnet46T' },
    });

    await expectChatDefaults(
      {
        cwd: workspace,
        agentOverride: 'simplifier',
        modelOverride: 'deepseekT',
      },
      {
        agent: 'simplifier',
        model: 'deepseekT',
        source: 'mixed',
        agentSource: 'explicit-override',
        modelSource: 'explicit-override',
      },
    );
    expect(mockedLoadWorkspaceCliConfig).not.toHaveBeenCalled();
    expect(mockedReadJson).not.toHaveBeenCalled();
    expect(mockedListExecutions).not.toHaveBeenCalled();
  });

  it('keeps default-tier loading when only the model is directly resolved', async () => {
    const workspace = await workspaceWithConfig({
      'texra.chat': { agent: 'assistant', model: 'sonnet46T' },
    });

    await expectChatDefaults(
      { cwd: workspace, modelOverride: 'deepseekT' },
      {
        agent: 'assistant',
        model: 'deepseekT',
        agentSource: 'workspace-config',
        modelSource: 'explicit-override',
      },
    );
    expect(mockedLoadWorkspaceCliConfig).toHaveBeenCalledOnce();
  });

  it('skips user and history I/O when environment resolves agent and model', async () => {
    await expectChatDefaults(
      { cwd: NO_WORKSPACE, envAgent: 'assistant', envModel: 'sonnet46T' },
      {
        agent: 'assistant',
        model: 'sonnet46T',
        source: 'mixed',
        agentSource: 'environment',
        modelSource: 'environment',
      },
    );
    expect(mockedReadJson).not.toHaveBeenCalled();
    expect(mockedListExecutions).not.toHaveBeenCalled();
  });

  it('still loads history when only the agent is directly resolved', async () => {
    mockedListExecutions.mockResolvedValueOnce([historyEntry('research')]);

    await expectChatDefaults(
      { cwd: NO_WORKSPACE, agentOverride: 'simplifier' },
      {
        agent: 'simplifier',
        model: 'sonnet46T',
        agentSource: 'explicit-override',
        modelSource: 'history',
      },
    );
    expect(mockedListExecutions).toHaveBeenCalledOnce();
  });

  it('uses prefixed command-specific workspace defaults', async () => {
    const workspace = await workspaceWithConfig(CHAT_TIER_CONFIG);

    await expectChatDefaults(
      { cwd: workspace },
      {
        agent: 'assistant',
        model: 'deepseekT',
        source: 'workspace',
      },
    );
  });

  it('uses the shared config parser for prefixed user chat defaults', async () => {
    mockedReadJson.mockResolvedValueOnce(CHAT_TIER_CONFIG);

    await expectChatDefaults(
      { cwd: NO_WORKSPACE },
      {
        agent: 'assistant',
        model: 'deepseekT',
        source: 'user',
        agentSource: 'user-config',
        modelSource: 'user-config',
      },
    );
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

    await expectChatDefaults(
      { cwd: NO_WORKSPACE },
      {
        agent: 'assistant',
        model: 'deepseekproT',
        source: 'builtin',
      },
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('config.json'),
    );
    warnSpy.mockRestore();
  });
});
