// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Fiber, FileSystem } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

// Type imports
import type { AgentDirectoryEntry } from '@agent/index';
import { createSettingsAgentControllers } from '@controllers/settingsView/SettingsAgentControllerFactory';
import { withProcessServices } from '@platform/processRuntime';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { FakeStateStore } from '@test/support/FakePlatform';
import { createDeferred } from '@test/support/asyncTestUtils';
import { testRuntime } from '@test/support/testProcessRuntime';
import type * as vscode from 'vscode';

const EXTERNAL_FIRST = '/external/first';
const EXTERNAL_SECOND = '/external/second';

const mocks = vi.hoisted(() => ({
  getAllLocal: vi.fn<() => Promise<unknown[]>>(),
  selectFolder: vi.fn(() => Effect.succeed<string | null>(null)),
  liveWatcherDirectories: new Set<string>(),
  watchedDirectories: [] as string[],
  /** Directory listings keyed by fsPath, standing in for the disk. */
  tree: new Map<string, [string, number][]>(),
  /** Reads parked until the test releases them, keyed by fsPath. `onReached`
   *  fires the moment the mock consumes the parked read (so a test can await
   *  that instead of polling the map), before the read parks on `promise`. */
  heldReads: new Map<
    string,
    { promise: Promise<void>; onReached?: () => void }
  >(),
  createHandlers: new Map<string, (uri: { fsPath: string }) => void>(),
}));

vi.mock('vscode', () => ({
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
    joinPath: (base: { fsPath: string }, ...segments: string[]) => ({
      fsPath: [base.fsPath, ...segments].join('/'),
    }),
  },
  workspace: {
    getWorkspaceFolder: (uri: { fsPath: string }) =>
      uri.fsPath.startsWith('/external')
        ? undefined
        : { uri: { fsPath: '/workspace' } },
    fs: {
      readDirectory: async (uri: { fsPath: string }) => {
        const entries = [...(mocks.tree.get(uri.fsPath) ?? [])];
        const held = mocks.heldReads.get(uri.fsPath);
        if (held) {
          mocks.heldReads.delete(uri.fsPath);
          held.onReached?.();
          await held.promise;
        }
        return entries;
      },
      stat: async (uri: { fsPath: string }) => ({
        type: mocks.tree.has(uri.fsPath) ? 2 : 1,
      }),
    },
    createFileSystemWatcher: (pattern: { base: { fsPath: string } }) => {
      mocks.watchedDirectories.push(pattern.base.fsPath);
      mocks.liveWatcherDirectories.add(pattern.base.fsPath);
      return {
        onDidCreate: (handler: (uri: { fsPath: string }) => void) => {
          mocks.createHandlers.set(pattern.base.fsPath, handler);
          return { dispose: () => {} };
        },
        onDidChange: () => ({ dispose: () => {} }),
        onDidDelete: () => ({ dispose: () => {} }),
        dispose: () => {
          mocks.liveWatcherDirectories.delete(pattern.base.fsPath);
        },
      };
    },
  },
  RelativePattern: class {
    constructor(
      public readonly base: unknown,
      public readonly pattern: string,
    ) {}
  },
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
}));

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  realpath: async (fsPath: string) => fsPath,
}));

vi.mock('@agent/index/platformAgentDirectories', () => ({
  // The service's readers, `Effect`s like the ones `AgentDirectoryService`
  // answers with: the rebuild under test composes them.
  createPlatformAgentDirectories: (options: {
    customDirectoryStore: { get(): Effect.Effect<string | undefined> };
  }) => ({
    builtIn: () => Effect.succeed('/agents/builtin'),
    builtInToolUse: () => Effect.succeed('/agents/toolUse'),
    custom: () =>
      options.customDirectoryStore
        .get()
        .pipe(Effect.map((value) => value || '/agents/custom')),
    getDirectory: () => Effect.succeed(undefined),
    getAllLocal: () => Effect.promise(() => mocks.getAllLocal()),
  }),
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

function directoryList(...directories: string[]): AgentDirectoryEntry[] {
  return directories.map((directory) => ({
    directory,
    source: 'builtIn' as AgentDirectoryEntry['source'],
  }));
}

function externalCustomDirectories(): AgentDirectoryEntry[] {
  return [EXTERNAL_FIRST, EXTERNAL_SECOND].map((directory) => ({
    directory,
    source: 'custom' as AgentDirectoryEntry['source'],
  }));
}

function fireCreate(watchedDirectory: string, createdPath: string): void {
  const handler = mocks.createHandlers.get(watchedDirectory);
  if (!handler) {
    throw new Error(`No create handler registered for ${watchedDirectory}`);
  }
  handler({ fsPath: createdPath });
}

/** Lets every queued rebuild run to completion. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('agent directory watcher rebuilds', () => {
  let subscription: vscode.Disposable | undefined;

  beforeEach(() => {
    subscription?.dispose();
    subscription = undefined;
    mocks.liveWatcherDirectories.clear();
    mocks.watchedDirectories.length = 0;
    mocks.tree.clear();
    mocks.heldReads.clear();
    mocks.createHandlers.clear();
    mocks.getAllLocal.mockReset();
    mocks.selectFolder.mockReturnValue(Effect.succeed(null));
    agentDirectories.initialize(
      new FakeStateStore(),
      '/resources',
      testRuntime(),
    );
  });

  function subscribe(): vscode.Disposable {
    subscription = agentDirectories.watchAgentDirectories(() => {});
    return subscription;
  }

  it.effect(
    'shares directory selection and reset with the settings state store',
    () =>
      Effect.gen(function* () {
        const globalState = new FakeStateStore();
        agentDirectories.initialize(globalState, '/resources', testRuntime());
        const { directory } = createSettingsAgentControllers({
          globalState,
          workspaceState: new FakeStateStore(),
          getCustomAgentDirectory: () => agentDirectories.custom(),
          getSourceDirectory: (source) => agentDirectories.getDirectory(source),
        });
        mocks.selectFolder.mockReturnValue(Effect.succeed(EXTERNAL_FIRST));
        yield* agentDirectories
          .promptCustom()
          .pipe(
            Effect.provide(
              FileSystem.layerNoop({ makeDirectory: () => Effect.void }),
            ),
          );
        expect(yield* globalState.get(GlobalStateKey.CUSTOM_AGENT_DIR)).toBe(
          EXTERNAL_FIRST,
        );
        expect(
          yield* withProcessServices(
            testRuntime(),
            directory.getCustomDirStatus(),
          ),
        ).toEqual({
          path: EXTERNAL_FIRST,
          isDefault: false,
        });

        yield* directory.resetCustomDir();
        expect(
          yield* withProcessServices(
            testRuntime(),
            directory.getCustomDirStatus(),
          ),
        ).toEqual({
          path: '/agents/custom',
          isDefault: true,
        });
      }),
  );

  /** Parks the first directory read; later reads return `subsequent`. */
  function parkFirstRead(
    subsequent: AgentDirectoryEntry[],
  ): ReturnType<typeof createDeferred<AgentDirectoryEntry[]>> {
    const firstRead = createDeferred<AgentDirectoryEntry[]>();
    mocks.getAllLocal
      .mockReturnValueOnce(firstRead.promise)
      .mockResolvedValue(subsequent);
    return firstRead;
  }

  it.live(
    'builds the watcher set once for rebuilds racing the same directory read',
    () =>
      Effect.gen(function* () {
        const firstRead = parkFirstRead(directoryList('/agents/builtin'));

        subscribe();
        const refreshed = yield* Effect.forkChild(
          withProcessServices(
            testRuntime(),
            agentDirectories.refreshAfterDirChange(),
          ),
          { startImmediately: true },
        );

        firstRead.resolve(directoryList('/agents/builtin'));
        yield* Fiber.join(refreshed);
        yield* Effect.promise(() => settle());

        expect(mocks.watchedDirectories).toEqual(['/agents/builtin']);
      }),
  );

  it.live(
    'rebuilds for a directory change raised while a rebuild is already running',
    () =>
      Effect.gen(function* () {
        const firstRead = parkFirstRead(directoryList('/agents/custom'));

        subscribe();

        // The settings view changes the custom agent directory while the first
        // read is still in flight: the change must not be dropped.
        const refreshed = yield* Effect.forkChild(
          withProcessServices(
            testRuntime(),
            agentDirectories.refreshAfterDirChange(),
          ),
          { startImmediately: true },
        );
        firstRead.resolve(directoryList('/agents/builtin'));
        yield* Fiber.join(refreshed);
        yield* Effect.promise(() => settle());

        expect(mocks.watchedDirectories).toEqual([
          '/agents/builtin',
          '/agents/custom',
        ]);
      }),
  );

  it.live(
    'settles a queued rebuild when the last subscription is disposed first',
    () =>
      Effect.gen(function* () {
        const firstRead = parkFirstRead(directoryList('/agents/custom'));

        const handle = subscribe();

        // The settings view awaits a rebuild that is still queued behind the
        // in-flight one when the sidebar drops its last subscription.
        let refreshSettled = false;
        const refreshed = yield* Effect.forkChild(
          withProcessServices(
            testRuntime(),
            agentDirectories.refreshAfterDirChange(),
          ),
          { startImmediately: true },
        );
        refreshed.addObserver(() => {
          refreshSettled = true;
        });

        handle.dispose();
        subscription = undefined;
        firstRead.resolve(directoryList('/agents/builtin'));
        yield* Effect.promise(() => settle());

        expect(refreshSettled).toBe(true);
        yield* Fiber.join(refreshed);
        expect(mocks.watchedDirectories).toEqual([]);
      }),
  );

  it('disposes watchers built after the last subscription is removed', async () => {
    const scan = createDeferred<void>();
    const readReached = createDeferred<void>();
    mocks.getAllLocal.mockResolvedValue([
      { directory: EXTERNAL_FIRST, source: 'custom' },
    ]);
    mocks.tree.set(EXTERNAL_FIRST, []);
    mocks.heldReads.set(EXTERNAL_FIRST, {
      promise: scan.promise,
      onReached: () => readReached.resolve(),
    });

    const handle = subscribe();
    await readReached.promise;

    handle.dispose();
    subscription = undefined;
    scan.resolve();
    await settle();

    expect(mocks.watchedDirectories).toEqual([EXTERNAL_FIRST]);
    expect(mocks.liveWatcherDirectories.size).toBe(0);
  });

  it('rebuilds for a subdirectory created after the running rebuild listed its parent', async () => {
    mocks.getAllLocal.mockResolvedValue(externalCustomDirectories());
    mocks.tree.set(EXTERNAL_FIRST, []);
    mocks.tree.set(EXTERNAL_SECOND, []);

    subscribe();
    await settle();

    expect(mocks.watchedDirectories).toEqual([EXTERNAL_FIRST, EXTERNAL_SECOND]);

    // Park the rebuild that `one` triggers on the scan of the second
    // directory, leaving the watchers it just created for the first directory
    // live while it runs.
    const secondScan = createDeferred<void>();
    mocks.heldReads.set(EXTERNAL_SECOND, secondScan);
    mocks.tree.set(EXTERNAL_FIRST, [['one', 2]]);
    mocks.tree.set(`${EXTERNAL_FIRST}/one`, []);
    fireCreate(EXTERNAL_FIRST, `${EXTERNAL_FIRST}/one`);
    await settle();

    // `two` lands after that rebuild listed the first directory, so only a
    // later rebuild can pick it up.
    mocks.tree.set(EXTERNAL_FIRST, [
      ['one', 2],
      ['two', 2],
    ]);
    mocks.tree.set(`${EXTERNAL_FIRST}/two`, []);
    fireCreate(EXTERNAL_FIRST, `${EXTERNAL_FIRST}/two`);
    await settle();

    secondScan.resolve();
    await settle();

    expect(mocks.watchedDirectories.slice(-4)).toEqual([
      EXTERNAL_FIRST,
      `${EXTERNAL_FIRST}/one`,
      `${EXTERNAL_FIRST}/two`,
      EXTERNAL_SECOND,
    ]);
  });
});
