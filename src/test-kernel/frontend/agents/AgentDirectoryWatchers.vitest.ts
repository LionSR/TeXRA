// Third-party imports
import pDefer from 'p-defer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Type imports
import type { AgentDirectoryEntry } from '@agent/index';
import type * as vscode from 'vscode';

const EXTERNAL_FIRST = '/external/first';
const EXTERNAL_SECOND = '/external/second';

const mocks = vi.hoisted(() => ({
  getAllLocal: vi.fn<() => Promise<unknown[]>>(),
  liveWatcherDirectories: new Set<string>(),
  watchedDirectories: [] as string[],
  /** Directory listings keyed by fsPath, standing in for the disk. */
  tree: new Map<string, [string, number][]>(),
  /** Reads parked until the test releases them, keyed by fsPath. */
  heldReads: new Map<string, { promise: Promise<void> }>(),
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
  createPlatformAgentDirectories: () => ({
    builtIn: async () => '/agents/builtin',
    builtInToolUse: async () => '/agents/toolUse',
    custom: async () => '/agents/custom',
    getDirectory: async () => undefined,
    getAllLocal: mocks.getAllLocal,
  }),
}));

vi.mock('@frontend/ui/errorHandlingUtils', () => ({
  showLoggedMessageWithDocs: vi.fn(),
}));

vi.mock('@frontend/ui/dialogs', () => ({
  selectFolder: vi.fn(),
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
    agentDirectories.initialize({} as vscode.ExtensionContext);
  });

  function subscribe(): vscode.Disposable {
    subscription = agentDirectories.watchAgentDirectories(() => {});
    return subscription;
  }

  /** Parks the first directory read; later reads return `subsequent`. */
  function parkFirstRead(
    subsequent: AgentDirectoryEntry[],
  ): ReturnType<typeof pDefer<AgentDirectoryEntry[]>> {
    const firstRead = pDefer<AgentDirectoryEntry[]>();
    mocks.getAllLocal
      .mockReturnValueOnce(firstRead.promise)
      .mockResolvedValue(subsequent);
    return firstRead;
  }

  it('builds the watcher set once for rebuilds racing the same directory read', async () => {
    const firstRead = parkFirstRead(directoryList('/agents/builtin'));

    subscribe();
    const refreshed = agentDirectories.refreshAfterDirChange();

    firstRead.resolve(directoryList('/agents/builtin'));
    await refreshed;
    await settle();

    expect(mocks.watchedDirectories).toEqual(['/agents/builtin']);
  });

  it('rebuilds for a directory change raised while a rebuild is already running', async () => {
    const firstRead = parkFirstRead(directoryList('/agents/custom'));

    subscribe();

    // The settings view changes the custom agent directory while the first
    // read is still in flight: the change must not be dropped.
    const refreshed = agentDirectories.refreshAfterDirChange();
    firstRead.resolve(directoryList('/agents/builtin'));
    await refreshed;
    await settle();

    expect(mocks.watchedDirectories).toEqual([
      '/agents/builtin',
      '/agents/custom',
    ]);
  });

  it('settles a queued rebuild when the last subscription is disposed first', async () => {
    const firstRead = parkFirstRead(directoryList('/agents/custom'));

    const handle = subscribe();

    // The settings view awaits a rebuild that is still queued behind the
    // in-flight one when the sidebar drops its last subscription.
    let refreshSettled = false;
    const refreshed = agentDirectories.refreshAfterDirChange().then(() => {
      refreshSettled = true;
    });

    handle.dispose();
    subscription = undefined;
    firstRead.resolve(directoryList('/agents/builtin'));
    await settle();

    expect(refreshSettled).toBe(true);
    await refreshed;
    expect(mocks.watchedDirectories).toEqual([]);
  });

  it('disposes watchers built after the last subscription is removed', async () => {
    const scan = pDefer<void>();
    mocks.getAllLocal.mockResolvedValue([
      { directory: EXTERNAL_FIRST, source: 'custom' },
    ]);
    mocks.tree.set(EXTERNAL_FIRST, []);
    mocks.heldReads.set(EXTERNAL_FIRST, scan);

    const handle = subscribe();
    await vi.waitFor(() => {
      expect(mocks.heldReads.has(EXTERNAL_FIRST)).toBe(false);
    });

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
    const secondScan = pDefer<void>();
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
