// Third-party imports
import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred } from '@test/support/asyncTestUtils';
import { installPlatform } from '@test/support/setupPlatform';
import { testRuntime } from '@test/support/testProcessRuntime';

const mocks = vi.hoisted(() => ({
  liveWatchers: new Set<string>(),
}));

vi.mock('vscode', () => ({
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  workspace: {
    getWorkspaceFolder: () => ({ uri: { fsPath: '/workspace' } }),
    createFileSystemWatcher: (pattern: { base: { fsPath: string } }) => {
      mocks.liveWatchers.add(pattern.base.fsPath);
      return {
        onDidCreate: () => ({ dispose: () => {} }),
        onDidChange: () => ({ dispose: () => {} }),
        onDidDelete: () => ({ dispose: () => {} }),
        dispose: () => mocks.liveWatchers.delete(pattern.base.fsPath),
      };
    },
  },
  RelativePattern: class {
    constructor(
      public readonly base: unknown,
      public readonly pattern: string,
    ) {}
  },
}));

const { agentDirectories } =
  await import('@frontend/agents/AgentDirectoryManager');

/** Lets every queued rebuild run to completion. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('agent directory watchers', () => {
  beforeEach(() => {
    mocks.liveWatchers.clear();
  });

  it('builds no watcher once the last subscription is removed mid-rebuild', async () => {
    const custom = createDeferred<string>();
    await installPlatform(
      {},
      {
        agentDirectories: {
          custom: () => Effect.promise(() => custom.promise),
          customConfigured: () => Effect.succeed(false),
          builtIn: () => Effect.succeed('/agents/builtin'),
          builtInToolUse: () => Effect.succeed('/agents/toolUse'),
        },
      },
    );

    const handle = agentDirectories.watchAgentDirectories(
      testRuntime(),
      () => {},
    );
    handle.dispose();
    custom.resolve('/agents/custom');
    await settle();

    expect(mocks.liveWatchers.size).toBe(0);
  });
});
