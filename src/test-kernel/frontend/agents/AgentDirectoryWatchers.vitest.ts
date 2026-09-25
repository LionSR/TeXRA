// Third-party imports
import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeStateStore } from '@test/support/FakePlatform';
import { createDeferred } from '@test/support/asyncTestUtils';
import { testRuntime } from '@test/support/testProcessRuntime';

const mocks = vi.hoisted(() => ({
  getAllLocal: vi.fn<() => Promise<unknown[]>>(),
  selectFolder: vi.fn(() => Effect.succeed<string | null>(null)),
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

vi.mock('@agent/index/AgentDirectoryService', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@agent/index/AgentDirectoryService')
  >()),
  // The service's readers, `Effect`s like the ones `AgentDirectoryService`
  // answers with: the rebuild under test composes them.
  AgentDirectoryService: class {
    constructor(
      private readonly options: {
        customDirectoryStore: { get(): Effect.Effect<string | undefined> };
      },
    ) {}
    builtIn = () => Effect.succeed('/agents/builtin');
    builtInToolUse = () => Effect.succeed('/agents/toolUse');
    custom = () =>
      this.options.customDirectoryStore
        .get()
        .pipe(Effect.map((value) => value || '/agents/custom'));
    getDirectory = () => Effect.succeed(undefined);
    getAllLocal = () => Effect.promise(() => mocks.getAllLocal());
  },
}));

vi.mock('@frontend/ui/errorHandlingUtils', () => ({
  showLoggedMessageWithDocs: vi.fn(() => Effect.void),
}));

vi.mock('@frontend/ui/dialogs', () => ({
  selectFolder: mocks.selectFolder,
}));

vi.mock('@logger/logUtils', () => ({
  createLog: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
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
    mocks.getAllLocal.mockReset();
    mocks.selectFolder.mockReturnValue(Effect.succeed(null));
    agentDirectories.initialize(
      new FakeStateStore(),
      '/resources',
      testRuntime(),
    );
  });

  it('builds no watcher once the last subscription is removed mid-rebuild', async () => {
    const listing = createDeferred<unknown[]>();
    mocks.getAllLocal.mockReturnValueOnce(listing.promise);

    const handle = agentDirectories.watchAgentDirectories(() => {});
    handle.dispose();
    listing.resolve([{ directory: '/agents/custom', source: 'custom' }]);
    await settle();

    expect(mocks.liveWatchers.size).toBe(0);
  });
});
