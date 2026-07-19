// Node imports
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Third-party imports
import { beforeAll, describe, expect, it, vi } from 'vitest';

// Local imports
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  computeAgentOptionsData,
  getAgent,
  getAgentsBySource,
  getVisibleAgent,
  getVisibleAgents,
  isAgentRegistryReady,
  invalidateRemoteAgentsAfterSignOut,
  loadAgents,
  refresh,
  resolveAgentKey,
} from '@agent/index/agentRegistry';
import * as logger from '@logger/logUtils';
import { platform } from '@platform/platform';
import type { AgentDirectoriesPort } from '@platform/interfaces';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { createFakePlatform } from '@test/support/FakePlatform';

const listRemoteAgents = vi.hoisted(() =>
  vi.fn(async () => [
    {
      id: 'remote-orchestrator',
      name: 'orchestrator',
      description: 'Remote team root',
      visibility: ['researcher'],
      tools: ['delegate_agent'],
      agentCategory: 'toolUse',
    },
  ]),
);

vi.mock('@agent/remote/RemoteAgentLoader', () => ({
  RemoteAgentLoader: {
    listRemoteAgents,
  },
}));

const REPO_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);
const BUILTIN_AGENTS_DIR = resolve(
  REPO_ROOT,
  'packages/extension/resources/agents',
);
const BUILTIN_TOOL_USE_AGENTS_DIR = resolve(
  REPO_ROOT,
  'packages/extension/resources/tool_use_agents',
);

function testAgentDirectories(
  overrides: Partial<AgentDirectoriesPort> = {},
): AgentDirectoriesPort {
  return {
    custom: async () => '',
    builtIn: async () => BUILTIN_AGENTS_DIR,
    builtInToolUse: async () => BUILTIN_TOOL_USE_AGENTS_DIR,
    ...overrides,
  };
}

let activeAgentDirectories: AgentDirectoriesPort = testAgentDirectories();

const mutableAgentDirectories: AgentDirectoriesPort = {
  custom: () => activeAgentDirectories.custom(),
  builtIn: () => activeAgentDirectories.builtIn(),
  builtInToolUse: () => activeAgentDirectories.builtInToolUse(),
};

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Point the platform at the real bundled agent YAMLs, overriding any dir. */
function useAgentDirectories(
  overrides: Partial<AgentDirectoriesPort> = {},
): void {
  activeAgentDirectories = testAgentDirectories(overrides);
}

/** Install a fresh fake platform seeded with the given workspace state. */
async function initPlatformWithState(
  workspaceState: Record<string, unknown>,
): Promise<void> {
  const { initPlatform } = await import('@platform/platform');
  initPlatform(
    createFakePlatform(
      { workspaceState },
      { fs: nodeFilesystem, agentDirectories: mutableAgentDirectories },
    ),
  );
}

describe('agent registry legacy aliases', () => {
  beforeAll(async () => {
    // Real bundled agent YAMLs on disk, so the test exercises the actual
    // rename (chat → assistant) rather than synthetic fixtures.
    // Pre-seed legacy keys to exercise the load-time state migration.
    await initPlatformWithState({
      [WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS]: [
        'chat',
        'builtInToolUse:chat',
        'review',
      ],
    });
    useAgentDirectories();
    await refresh({ includeRemote: false });
  });

  it('keeps unknown names unresolved', () => {
    expect(getAgent('no-such-agent')).toBeUndefined();
    expect(getVisibleAgent('toolUse', 'no-such-agent')).toBeUndefined();
  });

  it('resolves the legacy chat identifier to the assistant entry', () => {
    const entry = getAgent('chat');
    expect(entry?.name).toBe('assistant');
    expect(getAgent('assistant')?.name).toBe('assistant');
    expect(resolveAgentKey('chat', AgentCategory.ToolUse)).toBe(
      'builtInToolUse:assistant',
    );
  });

  it('exposes workflow round counts from local agent YAML', () => {
    expect(getAgent('polish')?.rounds).toBe(2);
    expect(getAgent('correct')?.rounds).toBe(1);
    expect(getAgent('assistant')?.rounds).toBeUndefined();
  });

  it('resolves source-qualified legacy keys', () => {
    expect(getAgent('builtInToolUse:chat')?.name).toBe('assistant');
    expect(getAgent('builtInToolUse:assistant')?.name).toBe('assistant');
    expect(getAgent('custom:no-such-agent')).toBeUndefined();
  });

  it('treats lookup category as priority, not a filter', () => {
    const workflow = getAgent('builtInWorkflow:polish', AgentCategory.ToolUse);
    expect(workflow?.name).toBe('polish');
    expect(workflow?.category).toBe(AgentCategory.Workflow);
  });

  it('keeps the current cache visible while a refresh is pending', async () => {
    expect(getAgent('assistant')?.name).toBe('assistant');

    let releaseBuiltInToolUseDir: (() => void) | undefined;
    const waitForBuiltInToolUseDir = new Promise<void>((resolveWait) => {
      releaseBuiltInToolUseDir = resolveWait;
    });
    useAgentDirectories({
      builtInToolUse: async () => {
        await waitForBuiltInToolUseDir;
        return BUILTIN_TOOL_USE_AGENTS_DIR;
      },
    });

    const pendingRefresh = refresh({ includeRemote: false });
    await new Promise((resolveNextTick) => setTimeout(resolveNextTick, 0));

    expect(getAgent('assistant')?.name).toBe('assistant');

    releaseBuiltInToolUseDir?.();
    await pendingRefresh;
  });

  it('forces a new remote fetch after an older initialization settles', async () => {
    useAgentDirectories();
    await refresh({ includeRemote: false });

    let releaseStaleLoad: (() => void) | undefined;
    const staleLoadGate = new Promise<void>((resolveLoad) => {
      releaseStaleLoad = resolveLoad;
    });
    let remoteCall = 0;
    listRemoteAgents.mockImplementation(async () => {
      remoteCall += 1;
      if (remoteCall === 1) {
        await staleLoadGate;
        return [
          {
            id: 'stale-agent',
            name: 'staleAgent',
            description: 'Stale',
            visibility: [],
            tools: [],
            agentCategory: 'toolUse',
          },
        ];
      }
      return [
        {
          id: 'fresh-agent',
          name: 'freshAgent',
          description: 'Fresh',
          visibility: [],
          tools: [],
          agentCategory: 'toolUse',
        },
      ];
    });

    const staleInitialization = loadAgents({ includeRemote: true });
    await vi.waitFor(() => expect(listRemoteAgents).toHaveBeenCalledOnce());
    const forcedRefresh = refresh({ includeRemote: true });

    releaseStaleLoad?.();
    await staleInitialization;
    await forcedRefresh;

    expect(listRemoteAgents).toHaveBeenCalledTimes(2);
    expect(getAgent('freshAgent')?.source).toBe('remote');
    expect(getAgent('staleAgent')).toBeUndefined();

    listRemoteAgents.mockReset();
    listRemoteAgents.mockResolvedValue([
      {
        id: 'remote-orchestrator',
        name: 'orchestrator',
        description: 'Remote team root',
        visibility: ['researcher'],
        tools: ['delegate_agent'],
        agentCategory: 'toolUse',
      },
    ]);
    await refresh({ includeRemote: false });
  });

  it('reloads local-only definitions after sign-out invalidation', async () => {
    useAgentDirectories();
    await refresh({ includeRemote: true });
    expect(getAgentsBySource('remote')).not.toHaveLength(0);
    const remoteFetchCount = listRemoteAgents.mock.calls.length;

    await invalidateRemoteAgentsAfterSignOut();

    expect(getAgentsBySource('remote')).toEqual([]);
    expect(listRemoteAgents).toHaveBeenCalledTimes(remoteFetchCount);
  });

  it('removes remote definitions even when the local rebuild fails', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    useAgentDirectories();
    await refresh({ includeRemote: true });
    expect(getAgentsBySource('remote')).not.toHaveLength(0);
    useAgentDirectories({
      builtIn: async () => {
        throw new Error('local catalog unavailable');
      },
    });

    const invalidation = invalidateRemoteAgentsAfterSignOut();
    expect(getAgentsBySource('remote')).toEqual([]);
    await expect(invalidation).resolves.toBeUndefined();
    expect(getAgentsBySource('remote')).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      'agentRegistry',
      expect.stringContaining(
        'Local agent catalog rebuild failed after sign-out',
      ),
    );

    useAgentDirectories();
    await refresh({ includeRemote: false });
    warn.mockRestore();
  });

  it('fences an in-flight remote load before rebuilding locally', async () => {
    useAgentDirectories();
    await refresh({ includeRemote: false });
    const remoteLoad = createDeferred<void>();
    const localRebuild = createDeferred<void>();
    let builtInCalls = 0;
    useAgentDirectories({
      builtIn: async () => {
        builtInCalls += 1;
        if (builtInCalls === 2) await localRebuild.promise;
        return BUILTIN_AGENTS_DIR;
      },
    });
    listRemoteAgents.mockImplementationOnce(async () => {
      await remoteLoad.promise;
      return [
        {
          id: 'late-remote',
          name: 'lateRemote',
          description: 'Late remote result',
          visibility: [],
          tools: [],
          agentCategory: 'toolUse',
        },
      ];
    });

    const staleLoad = loadAgents({ includeRemote: true });
    await vi.waitFor(() => expect(listRemoteAgents).toHaveBeenCalled());
    const invalidation = invalidateRemoteAgentsAfterSignOut();
    remoteLoad.resolve();
    await staleLoad;

    expect(getAgent('lateRemote')).toBeUndefined();
    expect(getAgentsBySource('remote')).toEqual([]);

    localRebuild.resolve();
    await invalidation;
  });

  it('keeps the registry marked ready when a later refresh fails', async () => {
    expect(isAgentRegistryReady()).toBe(true);
    expect(getAgent('assistant')?.name).toBe('assistant');

    useAgentDirectories({
      builtInToolUse: async () => {
        throw new Error('refresh failed');
      },
    });

    await expect(loadAgents()).rejects.toThrow('refresh failed');

    expect(isAgentRegistryReady()).toBe(true);
    expect(getAgent('assistant')?.name).toBe('assistant');

    useAgentDirectories();
  });

  it('includes remote agents in launcher options after local-only startup load', async () => {
    const originalEnabledToolUseAgents = platform().workspaceState.get<
      string[]
    >(WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS);

    try {
      await platform().workspaceState.update(
        WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
        ['orchestrator', 'research', 'review'],
      );

      await refresh({ includeRemote: false });
      expect(
        getVisibleAgents('toolUse').map((agent) => agent.name),
      ).not.toContain('orchestrator');

      const options = await computeAgentOptionsData();

      expect(options.toolUse.map((option) => option.label)).toContain(
        'orchestrator',
      );
    } finally {
      await platform().workspaceState.update(
        WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
        originalEnabledToolUseAgents,
      );
      await refresh({ includeRemote: false });
    }
  });

  it('includes remote agents in launcher options after pending local-only startup load', async () => {
    const originalEnabledToolUseAgents = platform().workspaceState.get<
      string[]
    >(WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS);

    let releaseBuiltInToolUseDir: (() => void) | undefined;
    const waitForBuiltInToolUseDir = new Promise<void>((resolveWait) => {
      releaseBuiltInToolUseDir = resolveWait;
    });

    try {
      await platform().workspaceState.update(
        WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
        ['orchestrator', 'research', 'review'],
      );
      useAgentDirectories({
        builtInToolUse: async () => {
          await waitForBuiltInToolUseDir;
          return BUILTIN_TOOL_USE_AGENTS_DIR;
        },
      });

      const pendingRefresh = refresh({ includeRemote: false });
      await new Promise((resolveNextTick) => setTimeout(resolveNextTick, 0));
      const optionsPromise = computeAgentOptionsData();

      releaseBuiltInToolUseDir?.();
      await pendingRefresh;
      const options = await optionsPromise;

      expect(options.toolUse.map((option) => option.label)).toContain(
        'orchestrator',
      );
    } finally {
      releaseBuiltInToolUseDir?.();
      await platform().workspaceState.update(
        WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
        originalEnabledToolUseAgents,
      );
      useAgentDirectories();
      await refresh({ includeRemote: false });
    }
  });

  it('migrates persisted legacy keys at load time', () => {
    // Stale chat keys would desync the Agents settings UI (which matches
    // keys literally) from picker visibility — loadAgents rewrites them.
    const stored = platform().workspaceState.get<string[]>(
      WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
    );
    expect(stored).toEqual(['assistant', 'builtInToolUse:assistant', 'review']);
  });

  it('keeps assistant visible for workspaces that opted into chat', async () => {
    await platform().workspaceState.update(
      WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
      ['chat'],
    );

    const visible = getVisibleAgents('toolUse').map((a) => a.name);
    expect(visible).toContain('assistant');
    expect(getVisibleAgent('toolUse', 'chat')?.name).toBe('assistant');
  });

  it('drops workflow round metadata when category is overridden to tool-use', async () => {
    await platform().workspaceState.update(
      WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
      ['polish'],
    );
    await refresh({ includeRemote: false });

    const entry = getAgent('polish');
    expect(entry?.category).toBe(AgentCategory.ToolUse);
    expect(entry?.rounds).toBeUndefined();
  });

  it('preserves bare custom chat while migrating qualified built-in chat keys', async () => {
    const customDir = await mkdtemp(resolve(tmpdir(), 'texra-custom-agent-'));
    await writeFile(
      resolve(customDir, 'chat.yaml'),
      [
        'name: chat',
        'description: Custom chat agent',
        'settings:',
        '  agentCategory: toolUse',
        '  tools: []',
        'prompts:',
        '  systemPrompt: Custom chat agent.',
        '',
      ].join('\n'),
    );

    await initPlatformWithState({
      [WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS]: [
        'chat',
        'builtInToolUse:chat',
      ],
    });
    useAgentDirectories({ custom: async () => customDir });

    await refresh({ includeRemote: false });

    expect(
      platform().workspaceState.get<string[]>(
        WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
      ),
    ).toEqual(['chat', 'builtInToolUse:assistant']);
    expect(getAgent('chat')?.source).toBe('custom');
    expect(getAgent('builtInToolUse:chat')?.name).toBe('assistant');

    // Visible resolution must agree with getAgent: the bare name picks the
    // custom agent, while the qualified key names the renamed built-in.
    expect(getVisibleAgent('toolUse', 'chat')?.source).toBe('custom');
    expect(getVisibleAgent('toolUse', 'builtInToolUse:chat')?.name).toBe(
      'assistant',
    );
  });

  it('migrates a cross-source legacy key to the canonical key in its category', async () => {
    // A stale `builtInWorkflow:chat` in the tool-use list aliases to
    // `assistant`, which only exists as a built-in tool-use agent. Rewriting
    // only the name part would yield `builtInWorkflow:assistant`, a dangling
    // key; the migration resolves the alias within the list's category and
    // persists the canonical `builtInToolUse:assistant` instead.
    await initPlatformWithState({
      [WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS]: ['builtInWorkflow:chat'],
    });
    useAgentDirectories();

    await refresh({ includeRemote: false });

    const migrated = platform().workspaceState.get<string[]>(
      WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
    );
    expect(migrated).toEqual(['builtInToolUse:assistant']);
    // The migrated key must resolve — no dangling enabled entry.
    expect(getAgent(migrated![0]!)?.name).toBe('assistant');
  });

  it('migrates within category when a custom agent shadows a built-in name', async () => {
    // Collision: a custom *workflow* `assistant` shadows the built-in tool-use
    // `assistant`. A category-blind fallback would pick the custom workflow
    // entry by source priority and wrongly persist `custom:assistant` into the
    // tool-use list. Migration must resolve within each list's own category.
    const customDir = await mkdtemp(resolve(tmpdir(), 'texra-custom-agent-'));
    await writeFile(
      resolve(customDir, 'assistant.yaml'),
      [
        'name: assistant',
        'description: Custom workflow agent shadowing a built-in name.',
        'settings:',
        '  agentCategory: workflow',
        'prompts:',
        '  systemPrompt: Custom workflow assistant.',
        '',
      ].join('\n'),
    );

    await initPlatformWithState({
      [WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS]: ['builtInWorkflow:chat'],
      [WorkspaceStateKey.ENABLED_AGENTS]: ['remote:chat'],
    });
    useAgentDirectories({ custom: async () => customDir });

    await refresh({ includeRemote: false });

    // Tool-use list → the tool-use assistant, never the custom workflow shadow.
    expect(
      platform().workspaceState.get<string[]>(
        WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
      ),
    ).toEqual(['builtInToolUse:assistant']);
    // Workflow list → the custom workflow assistant (its own category).
    expect(
      platform().workspaceState.get<string[]>(WorkspaceStateKey.ENABLED_AGENTS),
    ).toEqual(['custom:assistant']);
  });

  it('migrates persisted filename-based custom agent keys to YAML names', async () => {
    const customDir = await mkdtemp(resolve(tmpdir(), 'texra-custom-agent-'));
    await writeFile(
      resolve(customDir, 'Readable Helper.yaml'),
      [
        'name: helper',
        'description: Custom helper agent',
        'settings:',
        '  agentCategory: toolUse',
        '  tools: []',
        'prompts:',
        '  systemPrompt: Custom helper agent.',
        '',
      ].join('\n'),
    );

    await initPlatformWithState({
      [WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS]: [
        'custom:Readable Helper',
        'Readable Helper',
        'review',
      ],
    });
    useAgentDirectories({ custom: async () => customDir });

    await refresh({ includeRemote: false });

    expect(
      platform().workspaceState.get<string[]>(
        WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
      ),
    ).toEqual(['custom:helper', 'helper', 'review']);
    expect(getAgent('custom:helper')?.path).toBe(
      resolve(customDir, 'Readable Helper.yaml'),
    );
    expect(getVisibleAgents('toolUse').map((entry) => entry.name)).toContain(
      'helper',
    );
  });

  it('leaves ambiguous filename-based custom keys unmigrated', async () => {
    const customDir = await mkdtemp(resolve(tmpdir(), 'texra-custom-agent-'));
    const firstDir = resolve(customDir, 'first');
    const secondDir = resolve(customDir, 'second');
    await mkdir(firstDir);
    await mkdir(secondDir);
    await writeFile(
      resolve(firstDir, 'Readable Helper.yaml'),
      [
        'name: helper-one',
        'description: First custom helper agent',
        'settings:',
        '  agentCategory: toolUse',
        '  tools: []',
        'prompts:',
        '  systemPrompt: First custom helper agent.',
        '',
      ].join('\n'),
    );
    await writeFile(
      resolve(secondDir, 'Readable Helper.yaml'),
      [
        'name: helper-two',
        'description: Second custom helper agent',
        'settings:',
        '  agentCategory: toolUse',
        '  tools: []',
        'prompts:',
        '  systemPrompt: Second custom helper agent.',
        '',
      ].join('\n'),
    );

    await initPlatformWithState({
      [WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS]: [
        'custom:Readable Helper',
        'Readable Helper',
        'review',
      ],
    });
    useAgentDirectories({ custom: async () => customDir });

    await refresh({ includeRemote: false });

    expect(
      platform().workspaceState.get<string[]>(
        WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
      ),
    ).toEqual(['custom:Readable Helper', 'Readable Helper', 'review']);
    expect(getAgent('custom:helper-one')?.path).toBe(
      resolve(firstDir, 'Readable Helper.yaml'),
    );
    expect(getAgent('custom:helper-two')?.path).toBe(
      resolve(secondDir, 'Readable Helper.yaml'),
    );
    expect(getVisibleAgents('toolUse').map((entry) => entry.name)).not.toEqual(
      expect.arrayContaining(['helper-one', 'helper-two']),
    );
  });
});
