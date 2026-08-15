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
    reloadAfterStorageRootChange:
      vi.fn<(hooks: WorkspaceStorageTransitionHooks) => Promise<void>>(),
    dispose: vi.fn(),
    setupEventListeners: vi.fn(),
    state: {
      streamStatus: { getAllStreamStates: vi.fn(() => new Map()) },
    },
    webviewBridge: {},
    renderer: {},
    setApprovalBypassState: vi.fn(),
  },
  showErrorMessage: vi.fn(),
  workspaceListeners: [] as Array<() => void>,
  setApprovalPolicy: vi.fn(),
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
    setApprovalPolicy: mocks.setApprovalPolicy,
  }),
  tryDefaultSession: () => ({
    interactions: {},
    useHostInteractions: () => () => {},
    setApprovalPolicy: mocks.setApprovalPolicy,
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
vi.mock('@eventBus/AppSignals', () => ({
  appSignals: { on: () => () => {}, emit: vi.fn() },
}));

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

async function writeProjectConfig(
  root: string,
  contents: string,
): Promise<void> {
  await mkdir(join(root, '.texra'), { recursive: true });
  await writeFile(join(root, '.texra', 'config.json'), contents);
}

function createProject(root: string, port: number): Promise<void> {
  return writeProjectConfig(root, `{"texra.bib.zoteroPort": ${port}}\n`);
}

function projectConfigPath(root: string): string {
  return join(root, '.texra', 'config.json');
}

async function expectConfigContains(
  configPath: string,
  content: string,
): Promise<void> {
  await expect(readFile(configPath, 'utf8')).resolves.toContain(content);
}

describe.skipIf(process.platform === 'win32')(
  'extension workspace transition integration',
  () => {
    let tempDir: string;
    let workspaceRoot: string | undefined;
    let provider: InstanceType<typeof ProgressViewProvider> | undefined;

    beforeEach(async () => {
      mocks.backend.reloadAfterStorageRootChange.mockReset();
      mocks.showErrorMessage.mockReset();
      mocks.workspaceListeners.length = 0;
      mocks.setApprovalPolicy.mockReset();
      tempDir = await mkdtemp(join(tmpdir(), 'texra-workspace-transition-'));
    });

    afterEach(async () => {
      provider?.dispose();
      provider = undefined;
      await rm(tempDir, { recursive: true, force: true });
    });

    /** Wire storage + config + the progress view provider over `tempDir`. */
    async function buildFixture(initialRoot: string | undefined): Promise<{
      storage: InstanceType<typeof WorkspaceStorageProvider>;
      config: Awaited<ReturnType<typeof createExtensionTexraConfig>>;
    }> {
      workspaceRoot = initialRoot;
      const storageRoot = join(tempDir, 'storage');
      await mkdir(storageRoot);
      const storage = new WorkspaceStorageProvider(
        storageRoot,
        () => workspaceRoot,
      );
      const config = await createExtensionTexraConfig(storage, workspaceRoot);
      provider = new ProgressViewProvider(
        {
          storageUri: { fsPath: join(tempDir, 'extension-storage') },
        } as unknown as vscode.ExtensionContext,
        config,
        { getWorkspacePath: () => workspaceRoot } as never,
      );
      return { storage, config };
    }

    function fireWorkspaceFolderChange(): void {
      mocks.workspaceListeners[0]?.();
    }

    it('ignores folder changes that keep the active workspace root unchanged', async () => {
      const workspace = join(tempDir, 'project');
      await createProject(workspace, 24001);
      const { storage, config } = await buildFixture(workspace);

      const storageCommit = vi.spyOn(storage, 'commitWorkspaceStorageChange');
      const configReplacement = vi.spyOn(config, 'replaceWorkspaceStore');
      const listener = vi.fn();
      config.watch('texra.bib.zoteroPort', listener);

      fireWorkspaceFolderChange();
      await config.update('texra.bib.zoteroPort', 25000);

      expect(mocks.backend.reloadAfterStorageRootChange).not.toHaveBeenCalled();
      expect(storageCommit).not.toHaveBeenCalled();
      expect(configReplacement).not.toHaveBeenCalled();
      expect(mocks.showErrorMessage).not.toHaveBeenCalled();
      expect(listener).toHaveBeenCalledOnce();
      await expectConfigContains(projectConfigPath(workspace), '25000');
    });

    it('blocks workspace writes across storage and config commit windows while allowing global writes', async () => {
      const firstWorkspace = join(tempDir, 'first');
      const secondWorkspace = join(tempDir, 'second');
      await Promise.all([
        createProject(firstWorkspace, 24001),
        createProject(secondWorkspace, 24002),
      ]);
      const { storage, config } = await buildFixture(firstWorkspace);

      const storageCommit = pDefer<void>();
      const configCommit = pDefer<void>();
      driveTransitions(storage, {
        beforeStorageCommit: storageCommit.promise,
        beforeConfigCommit: configCommit.promise,
      });

      workspaceRoot = secondWorkspace;
      fireWorkspaceFolderChange();
      fireWorkspaceFolderChange();
      let workspaceWriteFinished = false;
      const workspaceWrite = config
        .update('texra.bib.zoteroPort', 25000)
        .then(() => {
          workspaceWriteFinished = true;
        });
      await config.update('texra.telemetry.enabled', false, 'global');

      expect(workspaceWriteFinished).toBe(false);
      await expectConfigContains(projectConfigPath(firstWorkspace), '24001');
      await expectConfigContains(
        join(storage.getGlobalStoragePath(), 'config.json'),
        'false',
      );

      storageCommit.resolve();
      await vi.waitFor(() =>
        expect(storage.getStoragePath()).not.toContain(firstWorkspace),
      );
      expect(workspaceWriteFinished).toBe(false);

      configCommit.resolve();
      await workspaceWrite;
      expect(mocks.backend.reloadAfterStorageRootChange).toHaveBeenCalledOnce();
      await expectConfigContains(projectConfigPath(secondWorkspace), '25000');
      await expectConfigContains(projectConfigPath(firstWorkspace), '24001');
    });

    it('moves writable project config to the no-folder internal store', async () => {
      const workspace = join(tempDir, 'project');
      await createProject(workspace, 24001);
      const { storage, config } = await buildFixture(workspace);
      driveTransitions(storage);

      workspaceRoot = undefined;
      fireWorkspaceFolderChange();
      await config.update('texra.bib.zoteroPort', 25000);

      await expectConfigContains(
        join(storage.getStoragePath(), 'config.json'),
        '25000',
      );
      await expectConfigContains(projectConfigPath(workspace), '24001');
    });

    it('re-seeds the default session approval policy from the new workspace after a transition commits', async () => {
      const firstWorkspace = join(tempDir, 'first');
      const secondWorkspace = join(tempDir, 'second');
      await Promise.all([
        createProject(firstWorkspace, 24001),
        writeProjectConfig(
          secondWorkspace,
          '{"texra.approvalPolicy": "yolo"}\n',
        ),
      ]);
      const { storage } = await buildFixture(firstWorkspace);
      driveTransitions(storage);

      expect(mocks.setApprovalPolicy).not.toHaveBeenCalled();
      workspaceRoot = secondWorkspace;
      fireWorkspaceFolderChange();
      await vi.waitFor(() =>
        expect(mocks.setApprovalPolicy).toHaveBeenCalledWith('yolo'),
      );
    });

    it('re-seeds the default session approval policy after a transition rolls back', async () => {
      const firstWorkspace = join(tempDir, 'first');
      const secondWorkspace = join(tempDir, 'second');
      await Promise.all([
        writeProjectConfig(
          firstWorkspace,
          '{"texra.bib.zoteroPort": 24001, "texra.approvalPolicy": "ask"}\n',
        ),
        writeProjectConfig(
          secondWorkspace,
          '{"texra.approvalPolicy": "yolo"}\n',
        ),
      ]);
      const { storage } = await buildFixture(firstWorkspace);
      driveTransitions(storage, {
        failWorkspaceRoots: new Set([secondWorkspace]),
      });

      workspaceRoot = secondWorkspace;
      fireWorkspaceFolderChange();
      await vi.waitFor(() => expect(mocks.showErrorMessage).toHaveBeenCalled());
      // Commit briefly seeds yolo from the failed target, then rollback
      // restores the prior workspace store and re-seeds ask.
      expect(mocks.setApprovalPolicy.mock.calls.map((call) => call[0])).toEqual(
        ['yolo', 'ask'],
      );
    });

    it('serializes rapid moves, rolls a failed move back, and preserves watchers for retry', async () => {
      const firstWorkspace = join(tempDir, 'first');
      const secondWorkspace = join(tempDir, 'second');
      const thirdWorkspace = join(tempDir, 'third');
      await Promise.all([
        createProject(firstWorkspace, 24001),
        createProject(secondWorkspace, 24002),
        createProject(thirdWorkspace, 24003),
      ]);
      const { storage, config } = await buildFixture(firstWorkspace);

      const failedRoots = new Set<string | undefined>([thirdWorkspace]);
      const operations: string[] = [];
      const storagePaths = new Map<string | undefined, string>();
      driveTransitions(storage, {
        failWorkspaceRoots: failedRoots,
        operations,
        storagePaths,
      });
      const listener = vi.fn();
      config.watch('texra.bib.zoteroPort', listener);

      workspaceRoot = secondWorkspace;
      fireWorkspaceFolderChange();
      workspaceRoot = thirdWorkspace;
      fireWorkspaceFolderChange();
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
      fireWorkspaceFolderChange();
      await config.update('texra.bib.zoteroPort', 25003);

      expect(config.get('texra.bib.zoteroPort')).toBe(25003);
      expect(listener.mock.calls.length).toBeGreaterThan(callsAfterRollback);
      await expectConfigContains(projectConfigPath(thirdWorkspace), '25003');
    });
  },
);
