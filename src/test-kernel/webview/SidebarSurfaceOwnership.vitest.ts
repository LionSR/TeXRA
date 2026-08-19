// Third-party imports
import pDefer from 'p-defer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Type imports
import type { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import type * as vscode from 'vscode';

const MAIN_HTML = '<main-view />';
const PROGRESS_HTML = '<progress-view />';

const mocks = vi.hoisted(() => ({
  executeCommand: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock('vscode', () => ({
  commands: {
    executeCommand: mocks.executeCommand,
  },
  window: { showInformationMessage: vi.fn() },
  workspace: {
    createFileSystemWatcher: () => ({
      onDidCreate: () => ({ dispose: () => {} }),
      onDidChange: () => ({ dispose: () => {} }),
      onDidDelete: () => ({ dispose: () => {} }),
      dispose: () => {},
    }),
    onDidChangeWorkspaceFolders: () => ({ dispose: () => {} }),
  },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
}));

vi.mock('@common/webview', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  BundledViewContentProvider: class {
    getHtmlContent(): string {
      return MAIN_HTML;
    }
  },
  getCombinedLocalResourceRoots: () => [],
}));

vi.mock('@webview/MainViewMessageHandler', () => ({
  MainViewMessageHandler: class {
    handleMessage = vi.fn();
    clearActiveView = vi.fn();
  },
}));

vi.mock('@agent/index', () => ({
  refresh: vi.fn(),
  computeAgentOptionsData: vi.fn(),
  getAgent: vi.fn(),
}));
vi.mock('@agent/core/definition/AgentDataclass', () => ({
  AgentCategory: { ToolUse: 'toolUse' },
}));
vi.mock('@commands/setup/setupAssistantCommand', () => ({
  hasAnyUsableSetupCredential: vi.fn(async () => false),
}));
vi.mock('@common/state/pendingStateManager', () => ({
  consumePendingState: () => undefined,
}));
vi.mock('@common/files/fileTypeUtils', () => ({
  EXTENSION_CATEGORIES: [],
  getFilterExtensions: () => [],
}));
vi.mock('@eventBus/AppSignals', () => ({
  appSignals: { on: () => () => {} },
}));
vi.mock('@frontend/agents/AgentDirectoryManager', () => ({
  agentDirectories: { watchAgentDirectories: () => ({ dispose: () => {} }) },
}));
vi.mock('@frontend/auth/agentCatalogRefreshScope', () => ({
  isAgentCatalogAuthRefreshDeferred: () => false,
  runAfterAgentCatalogAuthRefresh: vi.fn(),
}));
vi.mock('@frontend/events/onTexraAuthSessionsChanged', () => ({
  onTexraAuthSessionsChanged: vi.fn(),
}));
vi.mock('@frontend/agents/optionsLoader', () => ({
  loadMainViewModelOptions: vi.fn(),
}));
vi.mock('@frontend/agents/teamOptionsLoader', () => ({
  loadMainViewTeamOptions: vi.fn(),
}));

const { SIDEBAR_VIEWS, getActiveSidebarView, setActiveSidebarView } =
  await import('@common/webview');
const { MainViewProvider } = await import('@webview/MainViewProvider');

function createWebviewView() {
  return {
    webview: {
      options: {},
      html: '',
      postMessage: vi.fn(),
      onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
    },
    visible: true,
    onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
  };
}

describe('sidebar surface ownership', () => {
  let provider: InstanceType<typeof MainViewProvider>;
  let view: ReturnType<typeof createWebviewView>;
  let progressViewProvider: {
    getContentProvider: () => { getHtmlContent: () => string };
    handleSidebarMessage: ReturnType<typeof vi.fn>;
    resetSidebarReady: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mocks.executeCommand.mockReset();
    mocks.executeCommand.mockResolvedValue(undefined);
    setActiveSidebarView(SIDEBAR_VIEWS.MAIN);
    provider = new MainViewProvider({
      subscriptions: [],
      globalState: { get: () => undefined, update: async () => {} },
    } as unknown as vscode.ExtensionContext);
    progressViewProvider = {
      getContentProvider: () => ({ getHtmlContent: () => PROGRESS_HTML }),
      handleSidebarMessage: vi.fn(),
      resetSidebarReady: vi.fn(),
    };
    provider.setProgressViewProvider(
      progressViewProvider as unknown as ProgressViewProvider,
    );
    view = createWebviewView();
    provider.resolveWebviewView(view as unknown as vscode.WebviewView);
  });

  it('swaps the sidebar content in the tick that claims the surface', () => {
    // The context key push never settles: the swap must not wait on it.
    mocks.executeCommand.mockReturnValue(new Promise(() => {}));

    provider.switchMode(SIDEBAR_VIEWS.PROGRESS);

    expect(getActiveSidebarView()).toBe(SIDEBAR_VIEWS.PROGRESS);
    expect(view.webview.html).toBe(PROGRESS_HTML);
  });

  it('leaves the newest switch owning the surface when switches overlap', async () => {
    const contextKeyPush = pDefer<undefined>();
    mocks.executeCommand.mockReturnValue(contextKeyPush.promise);

    provider.switchMode(SIDEBAR_VIEWS.PROGRESS);
    provider.switchMode(SIDEBAR_VIEWS.MAIN);
    contextKeyPush.resolve(undefined);
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }

    expect(getActiveSidebarView()).toBe(SIDEBAR_VIEWS.MAIN);
    expect(view.webview.html).toBe(MAIN_HTML);
    expect(progressViewProvider.resetSidebarReady).toHaveBeenCalledTimes(1);
  });

  it('returns the surface to the launcher when the view is torn down', () => {
    provider.switchMode(SIDEBAR_VIEWS.PROGRESS);

    provider.resolveWebviewView(
      createWebviewView() as unknown as vscode.WebviewView,
    );

    expect(getActiveSidebarView()).toBe(SIDEBAR_VIEWS.MAIN);
    expect(progressViewProvider.resetSidebarReady).toHaveBeenCalledTimes(1);
  });
});
