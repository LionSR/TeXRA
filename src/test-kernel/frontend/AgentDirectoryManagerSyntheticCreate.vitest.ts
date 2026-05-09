// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- vscode mock --------------------------------------------------------
//
// The AgentDirectoryManager uses vscode.workspace.createFileSystemWatcher,
// vscode.workspace.fs.readDirectory, vscode.workspace.fs.stat,
// vscode.Uri.file/joinPath, vscode.RelativePattern, vscode.FileType, and
// vscode.workspace.getWorkspaceFolder. We provide a minimal in-memory
// implementation good enough to drive the rebuild path.

type WatcherHandle = {
  pattern: string;
  base: string;
  onCreate: ((uri: { fsPath: string }) => void) | null;
  onChange: ((uri: { fsPath: string }) => void) | null;
  onDelete: ((uri: { fsPath: string }) => void) | null;
  disposed: boolean;
};

type DirNode = { kind: 'dir'; entries: Map<string, DirNode | FileNode> };
type FileNode = { kind: 'file' };

// vi.mock factories are hoisted, so we can't reference top-level variables
// from the mock. Stash all shared state on globalThis.
type FsState = {
  watchers: WatcherHandle[];
  fileSystem: DirNode;
};

const FS_STATE: FsState = ((
  globalThis as unknown as { __agentDirFsState?: FsState }
).__agentDirFsState ??= {
  watchers: [],
  fileSystem: { kind: 'dir', entries: new Map() },
});

function ensureDir(fsPath: string): DirNode {
  const segments = fsPath.split('/').filter(Boolean);
  let node: DirNode = FS_STATE.fileSystem;
  for (const seg of segments) {
    let next = node.entries.get(seg);
    if (!next) {
      next = { kind: 'dir', entries: new Map() };
      node.entries.set(seg, next);
    }
    if (next.kind !== 'dir') {
      throw new Error(`Path collision: ${fsPath}`);
    }
    node = next;
  }
  return node;
}

function writeFile(fsPath: string): void {
  const segments = fsPath.split('/').filter(Boolean);
  const filename = segments.pop()!;
  const parent = ensureDir('/' + segments.join('/'));
  parent.entries.set(filename, { kind: 'file' });
}

function resetFs(): void {
  FS_STATE.fileSystem = { kind: 'dir', entries: new Map() };
  FS_STATE.watchers.length = 0;
}

vi.mock('vscode', () => {
  const FILE_TYPE_LOCAL = { File: 1, Directory: 2, SymbolicLink: 64 } as const;
  type WatcherHandleInner = {
    pattern: string;
    base: string;
    onCreate: ((uri: { fsPath: string }) => void) | null;
    onChange: ((uri: { fsPath: string }) => void) | null;
    onDelete: ((uri: { fsPath: string }) => void) | null;
    disposed: boolean;
  };
  type DirNodeInner = {
    kind: 'dir';
    entries: Map<string, DirNodeInner | { kind: 'file' }>;
  };
  type FileNodeInner = { kind: 'file' };
  type FsStateInner = {
    watchers: WatcherHandleInner[];
    fileSystem: DirNodeInner;
  };
  const g = globalThis as unknown as { __agentDirFsState?: FsStateInner };
  const state: FsStateInner = (g.__agentDirFsState ??= {
    watchers: [],
    fileSystem: { kind: 'dir', entries: new Map() },
  });

  function getNodeMock(fsPath: string): DirNodeInner | FileNodeInner | null {
    const segments = fsPath.split('/').filter(Boolean);
    let node: DirNodeInner | FileNodeInner = state.fileSystem;
    for (const seg of segments) {
      if (node.kind !== 'dir') return null;
      const next = node.entries.get(seg);
      if (!next) return null;
      node = next;
    }
    return node;
  }

  class RelativePattern {
    base: string;
    pattern: string;
    constructor(base: { fsPath: string } | string, pattern: string) {
      this.base = typeof base === 'string' ? base : base.fsPath;
      this.pattern = pattern;
    }
  }

  const posixJoin = (...parts: string[]) => {
    const joined = parts.join('/').replaceAll(/\/+/g, '/');
    return joined;
  };

  const Uri = {
    file(fsPath: string) {
      return { fsPath, scheme: 'file' };
    },
    joinPath(base: { fsPath: string }, ...segments: string[]) {
      return { fsPath: posixJoin(base.fsPath, ...segments), scheme: 'file' };
    },
  };

  const workspace = {
    createFileSystemWatcher: (relPattern: {
      base: string;
      pattern: string;
    }) => {
      const handle: WatcherHandleInner = {
        pattern: relPattern.pattern,
        base: relPattern.base,
        onCreate: null,
        onChange: null,
        onDelete: null,
        disposed: false,
      };
      state.watchers.push(handle);
      return {
        onDidCreate: (cb: (uri: { fsPath: string }) => void) => {
          handle.onCreate = cb;
          return { dispose: () => {} };
        },
        onDidChange: (cb: (uri: { fsPath: string }) => void) => {
          handle.onChange = cb;
          return { dispose: () => {} };
        },
        onDidDelete: (cb: (uri: { fsPath: string }) => void) => {
          handle.onDelete = cb;
          return { dispose: () => {} };
        },
        dispose: () => {
          handle.disposed = true;
        },
      };
    },
    getWorkspaceFolder: () => undefined,
    fs: {
      async readDirectory(uri: { fsPath: string }) {
        const node = getNodeMock(uri.fsPath);
        if (!node || node.kind !== 'dir') {
          throw new Error(`ENOENT: ${uri.fsPath}`);
        }
        return [...node.entries.entries()].map(([name, child]) => [
          name,
          child.kind === 'dir'
            ? FILE_TYPE_LOCAL.Directory
            : FILE_TYPE_LOCAL.File,
        ]);
      },
      async stat(uri: { fsPath: string }) {
        const node = getNodeMock(uri.fsPath);
        if (!node) throw new Error(`ENOENT: ${uri.fsPath}`);
        return {
          type:
            node.kind === 'dir'
              ? FILE_TYPE_LOCAL.Directory
              : FILE_TYPE_LOCAL.File,
        };
      },
    },
  };

  return {
    default: {},
    Uri,
    RelativePattern,
    FileType: FILE_TYPE_LOCAL,
    workspace,
    extensions: {},
  };
});

// --- internal mocks ----------------------------------------------------

vi.mock('@logger/logUtils', () => ({
  initialize: () => {},
  debug: () => {},
  error: () => {},
  info: () => {},
  warn: () => {},
}));

vi.mock('@frontend/ui/errorHandlingUtils', () => ({
  showLoggedMessageWithDocs: () => {},
}));

const CUSTOM_DIR = '/ext-custom-agents';

vi.mock('@agent/index', () => {
  return {
    AgentDirectoryService: class {
      constructor(_opts: unknown) {}
      async builtIn() {
        return '/builtin';
      }
      async builtInToolUse() {
        return '/builtin-tooluse';
      }
      async getDirectory() {
        return CUSTOM_DIR;
      }
      async getAllLocal() {
        return [{ directory: CUSTOM_DIR, source: 'CUSTOM' }];
      }
      async custom() {
        return CUSTOM_DIR;
      }
    },
    GlobalStorageAgentDirectoryStorage: class {},
  };
});

vi.mock('@common/state', () => ({
  GlobalStateKey: { CUSTOM_AGENT_DIR: 'CUSTOM_AGENT_DIR' },
  globalSM: { get: () => CUSTOM_DIR, update: async () => {} },
}));

vi.mock('@utils/files', () => ({
  AbsoluteFS: {
    exists: async () => true,
    ensureDir: async () => {},
  },
}));

vi.mock('@shared/schemas/agent', () => ({
  AGENT_SOURCE: {
    CUSTOM: 'CUSTOM',
    BUILT_IN: 'BUILT_IN',
    BUILT_IN_TOOL_USE: 'BUILT_IN_TOOL_USE',
    REMOTE: 'REMOTE',
  },
}));

// fs/promises realpath fallback
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    realpath: async (p: string) => p,
  };
});

// --- import system under test after mocks --------------------------------

import { AgentDirectoryManager } from '@frontend/agents/AgentDirectoryManager';

function findRootWatcher(): WatcherHandle {
  const w = FS_STATE.watchers.find(
    (h) => h.base === CUSTOM_DIR && h.pattern === '*' && !h.disposed,
  );
  if (!w) throw new Error('Root watcher not attached');
  return w;
}

async function flushMicrotasks(): Promise<void> {
  // Multiple drains to handle nested promise chains in rebuild logic.
  // The rebuild path involves: handleExternalDirectoryTreeChange (async stat)
  // → requestAgentWatcherRebuild → scheduleAgentWatcherSetup
  // → ensureAgentWatchers (async getAllLocal + buildAgentWatchers).
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('AgentDirectoryManager - synthetic create on subtree move-in', () => {
  let manager: AgentDirectoryManager;
  let fakeContext: { subscriptions: unknown[] };

  beforeEach(() => {
    resetFs();
    ensureDir(CUSTOM_DIR);
    fakeContext = { subscriptions: [] };
    manager = new AgentDirectoryManager();
    manager.initialize(fakeContext as never);
  });

  afterEach(() => {
    resetFs();
  });

  it('emits synthetic create events for *.yaml files in a moved-in subtree', async () => {
    const events: Array<{ type: string; relativePath: string }> = [];
    const sub = manager.watchAgentDirectories({
      pattern: '**/*.yaml',
      onEvent: (e) =>
        events.push({ type: e.type, relativePath: e.relativePath }),
    });

    // Initial setup completes (root watcher attached).
    await flushMicrotasks();
    expect(FS_STATE.watchers.some((w) => w.base === CUSTOM_DIR)).toBe(true);

    // Initial events should be empty: no yaml files exist yet, and the
    // initial build path should not synthesize anything.
    expect(events).toEqual([]);

    // Simulate `mv folder-with-yaml/ <CUSTOM_DIR>/` — populate the subtree
    // first, then fire a `create` event on the new directory from the root
    // watcher (vscode.FileSystemWatcher would deliver this for the dir,
    // but not for pre-existing files inside).
    const movedDir = `${CUSTOM_DIR}/team-pack`;
    ensureDir(movedDir);
    writeFile(`${movedDir}/alpha.yaml`);
    writeFile(`${movedDir}/beta.yaml`);
    writeFile(`${movedDir}/notes.md`); // non-yaml: must be ignored

    const root = findRootWatcher();
    root.onCreate?.({ fsPath: movedDir });

    await flushMicrotasks();

    const yamlEvents = events.filter((e) => e.type === 'create');
    const yamlNames = yamlEvents.map((e) => e.relativePath).sort();
    expect(yamlNames).toEqual(['team-pack/alpha.yaml', 'team-pack/beta.yaml']);

    sub.dispose();
  });

  it('does not double-emit for directories that were already watched', async () => {
    // Pre-populate the custom dir before watchers attach.
    const existingDir = `${CUSTOM_DIR}/already-here`;
    ensureDir(existingDir);
    writeFile(`${existingDir}/old.yaml`);

    const events: Array<{ type: string; relativePath: string }> = [];
    const sub = manager.watchAgentDirectories({
      pattern: '**/*.yaml',
      onEvent: (e) =>
        events.push({ type: e.type, relativePath: e.relativePath }),
    });

    await flushMicrotasks();
    // Initial build: no synthetic events fired (loaded by other paths).
    expect(events).toEqual([]);

    // Now fire a spurious rebuild (e.g. a dir was created then deleted).
    const newDir = `${CUSTOM_DIR}/another`;
    ensureDir(newDir);
    writeFile(`${newDir}/fresh.yaml`);

    const root = findRootWatcher();
    root.onCreate?.({ fsPath: newDir });

    await flushMicrotasks();

    // Synthetic create only for the new dir's yaml — not for already-here/old.yaml.
    const created = events
      .filter((e) => e.type === 'create')
      .map((e) => e.relativePath)
      .sort();
    expect(created).toEqual(['another/fresh.yaml']);

    sub.dispose();
  });
});
