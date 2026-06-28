import { describe, expect, it, vi } from 'vitest';

import { FileType } from '@platform/interfaces/filesystem';
import { createFakePlatform } from '@test/support/FakePlatform';
import {
  RUNTIME_BUNDLED_AGENT_DIRECTORY_NAMES,
  createRuntimeAgentDirectoryProvider,
  requireRuntimeAgentDirectory,
  resolveRuntimeAgentDirectory,
  setRuntimeAgentDirectories,
} from '@agent/runtime/agentDirectories';
import { AGENT_SOURCE } from '@shared/schemas/agent';

describe('runtime agent-directory commands', () => {
  it('exposes the required bundled resource directory names', () => {
    expect(RUNTIME_BUNDLED_AGENT_DIRECTORY_NAMES).toEqual([
      'agents',
      'tool_use_agents',
    ]);
  });

  it('resolves local agent sources and treats remote agents as pathless', async () => {
    const calls: string[] = [];
    setRuntimeAgentDirectories({
      custom: async () => {
        calls.push(AGENT_SOURCE.CUSTOM);
        return '/agents/custom';
      },
      builtIn: async () => {
        calls.push(AGENT_SOURCE.BUILT_IN_WORKFLOW);
        return '/agents/workflow';
      },
      builtInToolUse: async () => {
        calls.push(AGENT_SOURCE.BUILT_IN_TOOL_USE);
        return '/agents/tool-use';
      },
    });

    await expect(
      resolveRuntimeAgentDirectory(AGENT_SOURCE.CUSTOM),
    ).resolves.toBe('/agents/custom');
    await expect(
      resolveRuntimeAgentDirectory(AGENT_SOURCE.BUILT_IN_WORKFLOW),
    ).resolves.toBe('/agents/workflow');
    await expect(
      resolveRuntimeAgentDirectory(AGENT_SOURCE.BUILT_IN_TOOL_USE),
    ).resolves.toBe('/agents/tool-use');
    await expect(
      resolveRuntimeAgentDirectory(AGENT_SOURCE.REMOTE),
    ).resolves.toBeUndefined();
    await expect(
      requireRuntimeAgentDirectory(AGENT_SOURCE.CUSTOM),
    ).resolves.toBe('/agents/custom');

    expect(calls).toEqual([
      AGENT_SOURCE.CUSTOM,
      AGENT_SOURCE.BUILT_IN_WORKFLOW,
      AGENT_SOURCE.BUILT_IN_TOOL_USE,
      AGENT_SOURCE.CUSTOM,
    ]);
  });

  it('creates directory providers with runtime-owned global storage', async () => {
    const fakePlatform = createFakePlatform({
      globalStoragePath: '/global-agent-storage',
    });
    const { initPlatform } = await import('@platform/platform');
    initPlatform(fakePlatform);
    const absoluteDirectories = {
      exists: vi.fn(async () => true),
      ensureDir: vi.fn(async () => undefined),
    };
    const issueReporter = {
      report: vi.fn(async () => undefined),
    };
    const provider = createRuntimeAgentDirectoryProvider({
      channel: 'test',
      customDirectoryStore: { get: () => undefined },
      absoluteDirectories,
      issueReporter,
    });

    await expect(provider.builtIn()).resolves.toBe(
      '/global-agent-storage/agents',
    );
    await expect(
      fakePlatform.fs.stat('/global-agent-storage/agents'),
    ).resolves.toMatchObject({ type: FileType.Directory });
    await expect(
      provider.getDirectory(AGENT_SOURCE.REMOTE),
    ).resolves.toBeUndefined();

    expect(absoluteDirectories.exists).not.toHaveBeenCalled();
    expect(issueReporter.report).not.toHaveBeenCalled();
  });
});
