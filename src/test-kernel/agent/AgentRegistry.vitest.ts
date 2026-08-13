// Node imports
import { resolve } from 'node:path';

// Third-party imports
import { beforeAll, describe, expect, it, vi } from 'vitest';

// Local imports
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
} from '@agent/index/agentRegistry';
import * as logger from '@logger/logUtils';
import type { AgentDirectoriesPort } from '@platform/interfaces';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { AgentCategory } from '@shared/schemas';
import { createDeferred } from '@test/support/asyncTestUtils';
import { REPO_ROOT } from '@test/support/repoScan';
import { installPlatform } from '@test/support/setupPlatform';
import { delay } from '@utils/core';

const { listRemoteAgents, ORCHESTRATOR_AGENT } = vi.hoisted(() => {
  const ORCHESTRATOR_AGENT = {
    id: 'remote-orchestrator',
    name: 'orchestrator',
    description: 'Remote team root',
    visibility: ['researcher'],
    tools: ['delegate_agent'],
    agentCategory: 'toolUse',
  };
  return {
    ORCHESTRATOR_AGENT,
    listRemoteAgents: vi.fn(async () => [ORCHESTRATOR_AGENT]),
  };
});

vi.mock('@agent/remote/remoteAgentList', () => ({
  listRemoteAgents,
}));

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
  await installPlatform(
    { workspaceState },
    { fs: nodeFilesystem, agentDirectories: mutableAgentDirectories },
  );
}

function remoteAgentFixture(id: string, name: string, description: string) {
  return {
    id,
    name,
    description,
    visibility: [],
    tools: [],
    agentCategory: 'toolUse',
  };
}

describe('agent registry', () => {
  beforeAll(async () => {
    // Use the real bundled agent YAMLs rather than synthetic fixtures.
    await initPlatformWithState({});
    useAgentDirectories();
    await refresh({ includeRemote: false });
  });

  it('keeps unknown names unresolved', () => {
    expect(getAgent('no-such-agent')).toBeUndefined();
    expect(getVisibleAgent('toolUse', 'no-such-agent')).toBeUndefined();
  });

  it('exposes workflow round counts from local agent YAML', () => {
    expect(getAgent('polish')?.rounds).toBe(2);
    expect(getAgent('correct')?.rounds).toBe(1);
    expect(getAgent('assistant')?.rounds).toBeUndefined();
  });

  it('treats lookup category as priority, not a filter', () => {
    const workflow = getAgent('builtInWorkflow:polish', AgentCategory.ToolUse);
    expect(workflow?.name).toBe('polish');
    expect(workflow?.category).toBe(AgentCategory.Workflow);
  });

  it('keeps the current cache visible while a refresh is pending', async () => {
    expect(getAgent('assistant')?.name).toBe('assistant');

    const builtInToolUseDir = createDeferred<void>();
    useAgentDirectories({
      builtInToolUse: async () => {
        await builtInToolUseDir.promise;
        return BUILTIN_TOOL_USE_AGENTS_DIR;
      },
    });

    try {
      const pendingRefresh = refresh({ includeRemote: false });
      await delay(0);

      expect(getAgent('assistant')?.name).toBe('assistant');

      builtInToolUseDir.resolve();
      await pendingRefresh;
    } finally {
      builtInToolUseDir.resolve();
      useAgentDirectories();
    }
  });

  it('forces a new remote fetch after an older initialization settles', async () => {
    useAgentDirectories();
    await refresh({ includeRemote: false });

    const staleLoadGate = createDeferred<void>();
    let remoteCall = 0;
    listRemoteAgents.mockImplementation(async () => {
      remoteCall += 1;
      if (remoteCall === 1) {
        await staleLoadGate.promise;
        return [remoteAgentFixture('stale-agent', 'staleAgent', 'Stale')];
      }
      return [remoteAgentFixture('fresh-agent', 'freshAgent', 'Fresh')];
    });

    try {
      const staleInitialization = loadAgents({ includeRemote: true });
      await vi.waitFor(() => expect(listRemoteAgents).toHaveBeenCalledOnce());
      const forcedRefresh = refresh({ includeRemote: true });

      staleLoadGate.resolve();
      await staleInitialization;
      await forcedRefresh;

      expect(listRemoteAgents).toHaveBeenCalledTimes(2);
      expect(getAgent('freshAgent')?.source).toBe('remote');
      expect(getAgent('staleAgent')).toBeUndefined();
    } finally {
      staleLoadGate.resolve();
      listRemoteAgents.mockReset();
      listRemoteAgents.mockResolvedValue([ORCHESTRATOR_AGENT]);
      await refresh({ includeRemote: false });
    }
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

    try {
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
    } finally {
      useAgentDirectories();
      await refresh({ includeRemote: false });
      warn.mockRestore();
    }
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
        remoteAgentFixture('late-remote', 'lateRemote', 'Late remote result'),
      ];
    });

    const staleLoad = loadAgents({ includeRemote: true });
    await vi.waitFor(() => expect(listRemoteAgents).toHaveBeenCalled());

    try {
      const invalidation = invalidateRemoteAgentsAfterSignOut();
      remoteLoad.resolve();
      await staleLoad;

      expect(getAgent('lateRemote')).toBeUndefined();
      expect(getAgentsBySource('remote')).toEqual([]);

      localRebuild.resolve();
      await invalidation;
    } finally {
      remoteLoad.resolve();
      localRebuild.resolve();
      useAgentDirectories();
    }
  });

  it('keeps the registry marked ready when a later refresh fails', async () => {
    expect(isAgentRegistryReady()).toBe(true);
    expect(getAgent('assistant')?.name).toBe('assistant');

    useAgentDirectories({
      builtInToolUse: async () => {
        throw new Error('refresh failed');
      },
    });

    try {
      await expect(loadAgents()).rejects.toThrow('refresh failed');

      expect(isAgentRegistryReady()).toBe(true);
      expect(getAgent('assistant')?.name).toBe('assistant');
    } finally {
      useAgentDirectories();
    }
  });

  it('includes remote agents in launcher options after local-only startup load', async () => {
    try {
      await refresh({ includeRemote: false });
      expect(
        getVisibleAgents('toolUse').map((agent) => agent.name),
      ).not.toContain('orchestrator');

      const options = await computeAgentOptionsData();

      expect(options.toolUse.map((option) => option.label)).toContain(
        'orchestrator',
      );
    } finally {
      await refresh({ includeRemote: false });
    }
  });

  it('includes remote agents in launcher options after pending local-only startup load', async () => {
    const builtInToolUseDir = createDeferred<void>();

    try {
      useAgentDirectories({
        builtInToolUse: async () => {
          await builtInToolUseDir.promise;
          return BUILTIN_TOOL_USE_AGENTS_DIR;
        },
      });

      const pendingRefresh = refresh({ includeRemote: false });
      await delay(0);
      const optionsPromise = computeAgentOptionsData();

      builtInToolUseDir.resolve();
      await pendingRefresh;
      const options = await optionsPromise;

      expect(options.toolUse.map((option) => option.label)).toContain(
        'orchestrator',
      );
    } finally {
      builtInToolUseDir.resolve();
      useAgentDirectories();
      await refresh({ includeRemote: false });
    }
  });
});
