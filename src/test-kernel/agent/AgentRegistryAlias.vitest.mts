// Standard library imports
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Third-party imports
import { beforeAll, describe, expect, it } from 'vitest';

// Local imports
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { platform } from '@platform/platform';
import { createFakePlatform } from '@test/support/FakePlatform';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { setAgentDirectories } from '@agent/index/agentDirectoriesRegistry';
import {
  getAgent,
  getVisibleAgent,
  getVisibleAgents,
  isAgentRegistryReady,
  loadAgents,
  refresh,
} from '@agent/index/agentRegistry';
import { WorkspaceStateKey } from '@shared/state/stateKeys';

const REPO_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);

describe('agent registry legacy aliases', () => {
  beforeAll(async () => {
    // Real bundled agent YAMLs on disk, so the test exercises the actual
    // rename (chat → assistant) rather than synthetic fixtures.
    const { initPlatform } = await import('@platform/platform');
    initPlatform(
      createFakePlatform(
        {
          // Pre-seed legacy keys to exercise the load-time state migration.
          workspaceState: {
            [WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS]: [
              'chat',
              'builtInToolUse:chat',
              'review',
            ],
          },
        },
        { fs: nodeFilesystem },
      ),
    );
    setAgentDirectories({
      custom: async () => '',
      builtIn: async () =>
        resolve(REPO_ROOT, 'packages/extension/resources/agents'),
      builtInToolUse: async () =>
        resolve(REPO_ROOT, 'packages/extension/resources/tool_use_agents'),
    });
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
    setAgentDirectories({
      custom: async () => '',
      builtIn: async () =>
        resolve(REPO_ROOT, 'packages/extension/resources/agents'),
      builtInToolUse: async () => {
        await waitForBuiltInToolUseDir;
        return resolve(
          REPO_ROOT,
          'packages/extension/resources/tool_use_agents',
        );
      },
    });

    const pendingRefresh = refresh({ includeRemote: false });
    await new Promise((resolveNextTick) => setTimeout(resolveNextTick, 0));

    expect(getAgent('assistant')?.name).toBe('assistant');

    releaseBuiltInToolUseDir?.();
    await pendingRefresh;
  });

  it('keeps the registry marked ready when a later refresh fails', async () => {
    expect(isAgentRegistryReady()).toBe(true);
    expect(getAgent('assistant')?.name).toBe('assistant');

    setAgentDirectories({
      custom: async () => '',
      builtIn: async () =>
        resolve(REPO_ROOT, 'packages/extension/resources/agents'),
      builtInToolUse: async () => {
        throw new Error('refresh failed');
      },
    });

    await expect(loadAgents()).rejects.toThrow('refresh failed');

    expect(isAgentRegistryReady()).toBe(true);
    expect(getAgent('assistant')?.name).toBe('assistant');

    setAgentDirectories({
      custom: async () => '',
      builtIn: async () =>
        resolve(REPO_ROOT, 'packages/extension/resources/agents'),
      builtInToolUse: async () =>
        resolve(REPO_ROOT, 'packages/extension/resources/tool_use_agents'),
    });
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

    const { initPlatform } = await import('@platform/platform');
    initPlatform(
      createFakePlatform(
        {
          workspaceState: {
            [WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS]: [
              'chat',
              'builtInToolUse:chat',
            ],
          },
        },
        { fs: nodeFilesystem },
      ),
    );
    setAgentDirectories({
      custom: async () => customDir,
      builtIn: async () =>
        resolve(REPO_ROOT, 'packages/extension/resources/agents'),
      builtInToolUse: async () =>
        resolve(REPO_ROOT, 'packages/extension/resources/tool_use_agents'),
    });

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

  it('migrates a cross-source legacy key to a key that resolves', async () => {
    // A stale `builtInWorkflow:chat` aliases to `assistant`, which only exists
    // as a built-in tool-use agent. Rewriting only the name part would yield
    // `builtInWorkflow:assistant`, a dangling key that resolves to nothing; the
    // migration must fall back to the alias target's canonical key instead.
    const { initPlatform } = await import('@platform/platform');
    initPlatform(
      createFakePlatform(
        {
          workspaceState: {
            [WorkspaceStateKey.ENABLED_AGENTS]: ['builtInWorkflow:chat'],
          },
        },
        { fs: nodeFilesystem },
      ),
    );
    setAgentDirectories({
      custom: async () => '',
      builtIn: async () =>
        resolve(REPO_ROOT, 'packages/extension/resources/agents'),
      builtInToolUse: async () =>
        resolve(REPO_ROOT, 'packages/extension/resources/tool_use_agents'),
    });

    await refresh({ includeRemote: false });

    const migrated = platform().workspaceState.get<string[]>(
      WorkspaceStateKey.ENABLED_AGENTS,
    );
    expect(migrated).toEqual(['builtInToolUse:assistant']);
    // The migrated key must resolve — no dangling enabled entry.
    expect(getAgent(migrated![0]!)?.name).toBe('assistant');
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

    const { initPlatform } = await import('@platform/platform');
    initPlatform(
      createFakePlatform(
        {
          workspaceState: {
            [WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS]: [
              'custom:Readable Helper',
              'Readable Helper',
              'review',
            ],
          },
        },
        { fs: nodeFilesystem },
      ),
    );
    setAgentDirectories({
      custom: async () => customDir,
      builtIn: async () =>
        resolve(REPO_ROOT, 'packages/extension/resources/agents'),
      builtInToolUse: async () =>
        resolve(REPO_ROOT, 'packages/extension/resources/tool_use_agents'),
    });

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

    const { initPlatform } = await import('@platform/platform');
    initPlatform(
      createFakePlatform(
        {
          workspaceState: {
            [WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS]: [
              'custom:Readable Helper',
              'Readable Helper',
              'review',
            ],
          },
        },
        { fs: nodeFilesystem },
      ),
    );
    setAgentDirectories({
      custom: async () => customDir,
      builtIn: async () =>
        resolve(REPO_ROOT, 'packages/extension/resources/agents'),
      builtInToolUse: async () =>
        resolve(REPO_ROOT, 'packages/extension/resources/tool_use_agents'),
    });

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
