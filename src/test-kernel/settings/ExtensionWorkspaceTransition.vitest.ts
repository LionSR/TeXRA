// Node imports
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Third-party imports
import pDefer from 'p-defer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Type imports
import type { WorkspaceStorageTransitionHooks } from '@agent/runtime/SessionHandle';
import type * as vscode from 'vscode';

const mocks = vi.hoisted(() => ({
  backend: {
    approvalHandlers: { toolEdit: { show: vi.fn(), dismiss: vi.fn() } },
    factApplier: { getAllStreamStates: vi.fn(() => new Map()) },
    reloadAfterStorageRootChange:
      vi.fn<(hooks: WorkspaceStorageTransitionHooks) => Promise<void>>(),
    dispose: vi.fn(),
    setupEventListeners: vi.fn(),
    state: {},
    webviewBridge: {},
    webviewUpdater: {},
    setApprovalBypassState: vi.fn(),
  },
  showErrorMessage: vi.fn(),
  workspaceListeners: [] as Array<() => void>,
}));

vi.mock('vscode', () => ({
  ColorThemeKind: { Dark: 2 },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  window: {
    activeColorTheme: { kind: 1 },
    onDidChangeActiveColorTheme: () => ({ dispose: vi.fn() }),
    showErrorMessage: mocks.showErrorMessage,
    showInformationMessage: vi.fn(),
  },
  workspace: {
    onDidChangeWorkspaceFolders: (listener: () => void) => {
      mocks.workspaceListeners.push(listener);
      return { dispose: vi.fn() };
    },
  },
}));

vi.mock('@common/webview', () => ({
  BaseWebviewProvider: class {
    protected readonly _disposables: Array<{ dispose(): void }> = [];

    getActiveWebview(): undefined {
      return undefined;
    }

    isViewVisible(): boolean {
      return false;
    }

    dispose(): void {
      for (const disposable of this._disposables) disposable.dispose();
    }
  },
  BundledViewContentProvider: class {},
  getActiveSidebarView: () => 'main',
  getSharedLocalResourceRoots: () => [],
  SIDEBAR_VIEWS: { MAIN: 'main', PROGRESS: 'progress' },
}));
vi.mock('@common/state', () => ({ workspaceSM: {} }));
vi.mock('@agent/trace', () => ({
  createChannelTrace: () => ({ debug: vi.fn(), error: vi.fn() }),
}));
vi.mock('@agent/runtime/SessionHandle', () => ({
  defaultSession: () => ({
    interactions: {},
    useHostInteractions: () => () => {},
  }),
}));
vi.mock('@agent/runtime/terminalResultToast', () => ({
  attachTerminalResultToast: () => () => {},
}));
vi.mock('@controllers/progressView/backend/ProgressBackend', () => ({
  ProgressBackend: class {
    constructor() {
      return mocks.backend;
    }
  },
}));
vi.mock('@controllers/approval/ToolEditApprovalController', () => ({
  ToolEditApprovalController: class {
    dispose(): void {}
  },
}));
vi.mock('@controllers/progressView/backend/agentProposalTransport', () => ({
  createAgentProposalTransport: () => ({}),
}));
vi.mock('@controllers/progressView/backend/progressBackendUiConfig', () => ({
  replayApprovalRequestHandlers: vi.fn(),
}));
vi.mock('@frontend/approval/VscodeToolEditApprovalHost', () => ({
  VscodeToolEditApprovalHost: class {},
}));
vi.mock('@frontend/hosts/VscodePromptHost', () => ({
  VscodePromptHost: class {},
}));
vi.mock('@frontend/events/agentEventListeners', () => ({
  createAgentPresentationHost: () => ({}),
}));
vi.mock('@progressView/extensionHostInteractions', () => ({
  createExtensionHostInteractions: () => ({}),
}));
vi.mock('@progressView/ProgressViewMessageHandler', () => ({
  ProgressViewMessageHandler: class {},
}));
vi.mock('@progressView/progressBackendAppSignals', () => ({
  attachProgressBackendAppSignals: () => ({ dispose: vi.fn() }),
}));
vi.mock('@eventBus/AppSignals', () => ({ appSignals: {} }));

const { WorkspaceStorageProvider } =
  await import('@platform/defaults/workspaceStorage');
const { createExtensionTexraConfig } =
  await import('@frontend/vscode/texraConfig');
const { ProgressViewProvider } =
  await import('@progressView/ProgressViewProvider');

interface TransitionDriverOptions {
  beforeStorageCommit?: Promise<unknown>;
  beforeConfigCommit?: Promise<unknown>;
  failWorkspaceRoots?: Set<string | undefined>;
  operations?: string[];
  storagePaths?: Map<string | undefined, string>;
}

function driveTransitions(
  storage: InstanceType<typeof WorkspaceStorageProvider>,
  options: TransitionDriverOptions = {},
): void {
  mocks.backend.reloadAfterStorageRootChange.mockImplementation(
    async (hooks) => {
      const root = hooks.workspacePath;
      options.operations?.push(`start:${root ?? 'none'}`);
      await options.beforeStorageCommit;
      const storageChanged = storage.commitWorkspaceStorageChange({
        workspacePath: root,
      });
      options.operations?.push(`storage:${root ?? 'none'}`);
      await options.beforeConfigCommit;
      try {
        await hooks.afterStorageCommit();
        options.operations?.push(`config:${root ?? 'none'}`);
        if (options.failWorkspaceRoots?.has(root)) {
          throw new Error(`cannot load ${root ?? 'no folder'}`);
        }
        if (storageChanged) storage.finalizeWorkspaceStorageChange();
        hooks.afterStorageFinalize();
        options.storagePaths?.set(root, storage.getStoragePath());
        options.operations?.push(`done:${root ?? 'none'}`);
      } catch (error) {
        if (storageChanged) storage.rollbackWorkspaceStorageChange();
        hooks.afterStorageRollback();
        options.operations?.push(`failed:${root ?? 'none'}`);
        throw error;
      }
    },
  );
}

async function createProject(root: string, port: number): Promise<void> {
  await mkdir(join(root, '.texra'), { recursive: true });
  await writeFile(
    join(root, '.texra', 'config.json'),
    `{"texra.bib.zoteroPort": ${port}}\n`,
  );
}

describe.skipIf(process.platform === 'win32')(
  'extension workspace transition integration',
  () => {
    let tempDir: string | undefined;

    beforeEach(() => {
      mocks.backend.reloadAfterStorageRootChange.mockReset();
      mocks.showErrorMessage.mockReset();
      mocks.workspaceListeners.length = 0;
    });

    afterEach(async () => {
      if (tempDir) await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    });

    it('blocks workspace writes across storage and config commit windows while allowing global writes', async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'texra-workspace-transition-'));
      const firstWorkspace = join(tempDir, 'first');
      const secondWorkspace = join(tempDir, 'second');
      const storageRoot = join(tempDir, 'storage');
      await Promise.all([
        createProject(firstWorkspace, 24001),
        createProject(secondWorkspace, 24002),
        mkdir(storageRoot),
      ]);

      let workspaceRoot: string | undefined = firstWorkspace;
      const storage = new WorkspaceStorageProvider(
        storageRoot,
        () => workspaceRoot,
      );
      const config = await createExtensionTexraConfig(storage, workspaceRoot);
      const storageCommit = pDefer<void>();
      const configCommit = pDefer<void>();
      driveTransitions(storage, {
        beforeStorageCommit: storageCommit.promise,
        beforeConfigCommit: configCommit.promise,
      });
      const provider = new ProgressViewProvider(
        {
          storageUri: { fsPath: join(tempDir, 'extension-storage') },
        } as unknown as vscode.ExtensionContext,
        config,
        { getWorkspacePath: () => workspaceRoot } as never,
      );

      workspaceRoot = secondWorkspace;
      mocks.workspaceListeners[0]?.();
      let workspaceWriteFinished = false;
      const workspaceWrite = config
        .update('texra.bib.zoteroPort', 25000)
        .then(() => {
          workspaceWriteFinished = true;
        });
      await config.update('texra.telemetry.enabled', false, 'global');

      expect(workspaceWriteFinished).toBe(false);
      await expect(
        readFile(join(firstWorkspace, '.texra', 'config.json'), 'utf8'),
      ).resolves.toContain('24001');
      await expect(
        readFile(join(storage.getGlobalStoragePath(), 'config.json'), 'utf8'),
      ).resolves.toContain('false');

      storageCommit.resolve();
      await vi.waitFor(() =>
        expect(storage.getStoragePath()).not.toContain(firstWorkspace),
      );
      expect(workspaceWriteFinished).toBe(false);

      configCommit.resolve();
      await workspaceWrite;
      await expect(
        readFile(join(secondWorkspace, '.texra', 'config.json'), 'utf8'),
      ).resolves.toContain('25000');
      await expect(
        readFile(join(firstWorkspace, '.texra', 'config.json'), 'utf8'),
      ).resolves.toContain('24001');
      provider.dispose();
    });

    it('moves writable project config to the no-folder internal store', async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'texra-workspace-transition-'));
      const workspace = join(tempDir, 'project');
      const storageRoot = join(tempDir, 'storage');
      await Promise.all([createProject(workspace, 24001), mkdir(storageRoot)]);

      let workspaceRoot: string | undefined = workspace;
      const storage = new WorkspaceStorageProvider(
        storageRoot,
        () => workspaceRoot,
      );
      const config = await createExtensionTexraConfig(storage, workspaceRoot);
      driveTransitions(storage);
      const provider = new ProgressViewProvider(
        {
          storageUri: { fsPath: join(tempDir, 'extension-storage') },
        } as unknown as vscode.ExtensionContext,
        config,
        { getWorkspacePath: () => workspaceRoot } as never,
      );

      workspaceRoot = undefined;
      mocks.workspaceListeners[0]?.();
      await config.update('texra.bib.zoteroPort', 25000);

      await expect(
        readFile(join(storage.getStoragePath(), 'config.json'), 'utf8'),
      ).resolves.toContain('25000');
      await expect(
        readFile(join(workspace, '.texra', 'config.json'), 'utf8'),
      ).resolves.toContain('24001');
      provider.dispose();
    });

    it('serializes rapid moves, rolls a failed move back, and preserves watchers for retry', async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'texra-workspace-transition-'));
      const firstWorkspace = join(tempDir, 'first');
      const secondWorkspace = join(tempDir, 'second');
      const thirdWorkspace = join(tempDir, 'third');
      const storageRoot = join(tempDir, 'storage');
      await Promise.all([
        createProject(firstWorkspace, 24001),
        createProject(secondWorkspace, 24002),
        createProject(thirdWorkspace, 24003),
        mkdir(storageRoot),
      ]);

      let workspaceRoot: string | undefined = firstWorkspace;
      const storage = new WorkspaceStorageProvider(
        storageRoot,
        () => workspaceRoot,
      );
      const config = await createExtensionTexraConfig(storage, workspaceRoot);
      const failedRoots = new Set<string | undefined>([thirdWorkspace]);
      const operations: string[] = [];
      const storagePaths = new Map<string | undefined, string>();
      driveTransitions(storage, {
        failWorkspaceRoots: failedRoots,
        operations,
        storagePaths,
      });
      const provider = new ProgressViewProvider(
        {
          storageUri: { fsPath: join(tempDir, 'extension-storage') },
        } as unknown as vscode.ExtensionContext,
        config,
        { getWorkspacePath: () => workspaceRoot } as never,
      );
      const listener = vi.fn();
      config.watch('texra.bib.zoteroPort', listener);

      workspaceRoot = secondWorkspace;
      mocks.workspaceListeners[0]?.();
      workspaceRoot = thirdWorkspace;
      mocks.workspaceListeners[0]?.();
      const failedWorkspaceWrite = expect(
        config.update('texra.bib.zoteroPort', 26000),
      ).rejects.toThrow('workspace transition 2 failed');

      await vi.waitFor(() => expect(mocks.showErrorMessage).toHaveBeenCalled());
      await failedWorkspaceWrite;
      expect(operations).toEqual([
        `start:${secondWorkspace}`,
        `storage:${secondWorkspace}`,
        `config:${secondWorkspace}`,
        `done:${secondWorkspace}`,
        `start:${thirdWorkspace}`,
        `storage:${thirdWorkspace}`,
        `config:${thirdWorkspace}`,
        `failed:${thirdWorkspace}`,
      ]);
      expect(config.get('texra.bib.zoteroPort')).toBe(24002);
      expect(storage.getStoragePath()).toBe(storagePaths.get(secondWorkspace));

      const callsAfterRollback = listener.mock.calls.length;
      failedRoots.clear();
      mocks.workspaceListeners[0]?.();
      await config.update('texra.bib.zoteroPort', 25003);

      expect(config.get('texra.bib.zoteroPort')).toBe(25003);
      expect(listener.mock.calls.length).toBeGreaterThan(callsAfterRollback);
      await expect(
        readFile(join(thirdWorkspace, '.texra', 'config.json'), 'utf8'),
      ).resolves.toContain('25003');
      provider.dispose();
    });
  },
);
