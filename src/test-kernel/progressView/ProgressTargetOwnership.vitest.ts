// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import type * as vscode from 'vscode';
const mocks = vi.hoisted(() => ({
  createWebviewPanel: vi.fn(),
  executeCommand: vi.fn(async () => undefined),
  replayApprovalRequestHandlers: vi.fn(async () => undefined),
  showErrorMessage: vi.fn(async () => undefined),
}));

vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    window: {
      ...(actual.window as Record<string, unknown>),
      activeColorTheme: { kind: 1 },
      createWebviewPanel: mocks.createWebviewPanel,
      showErrorMessage: mocks.showErrorMessage,
    },
    commands: { executeCommand: mocks.executeCommand },
    Uri: {
      ...(actual.Uri as Record<string, unknown>),
      joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
        fsPath: [base.fsPath, ...parts].join('/'),
      }),
    },
    ColorThemeKind: { Light: 1, Dark: 2 },
    ViewColumn: { One: 1 },
    ThemeIcon: class {
      constructor(public readonly id: string) {}
    },
  };
});

vi.mock('@controllers/progressView/backend/progressBackendUiConfig', () => ({
  replayApprovalRequestHandlers: mocks.replayApprovalRequestHandlers,
}));

// None of the placement transitions build host interactions; stubbing the
// factory keeps this suite off the extension's diagnostics/review surface.
vi.mock('@progressView/extensionHostInteractions', () => ({
  createExtensionHostInteractions: vi.fn(),
}));

const { SIDEBAR_VIEWS, getActiveSidebarView, setActiveSidebarView } =
  await import('@common/webview');

function createPanel() {
  const disposeListeners: Array<() => void> = [];
  const panel = {
    visible: true,
    viewColumn: 1,
    iconPath: undefined,
    reveal: vi.fn(),
    dispose: vi.fn(() => {
      for (const listener of disposeListeners) listener();
    }),
    onDidDispose: vi.fn((listener: () => void) => {
      disposeListeners.push(listener);
      return { dispose: vi.fn() };
    }),
    onDidChangeViewState: vi.fn(() => ({ dispose: vi.fn() })),
    webview: {
      html: '',
      postMessage: vi.fn(),
      onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
    },
  };
  return panel;
}

function createdPanel(): ReturnType<typeof createPanel> {
  return mocks.createWebviewPanel.mock.results[0]?.value as ReturnType<
    typeof createPanel
  >;
}

/**
 * Provider with only the collaborators the placement paths touch. The
 * constructor stands up the whole progress backend, which none of these
 * transitions consult beyond the stubs below.
 */
function createProvider() {
  const sidebarView = {
    visible: true,
    webview: {
      html: '',
      postMessage: vi.fn(),
      onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
    },
  } as unknown as vscode.WebviewView;
  const mainViewProvider = {
    getWebviewView: () => sidebarView,
    switchMode: vi.fn((mode: string) => {
      // Mirrors MainViewProvider: claiming the surface for the launcher voids
      // the progress sidebar's ready handshake.
      setActiveSidebarView(mode as 'main' | 'progress');
      if (mode === SIDEBAR_VIEWS.MAIN) provider.resetSidebarReady();
    }),
  };
  const provider = Object.create(
    ProgressViewProvider.prototype,
  ) as ProgressViewProvider;
  const injected = provider as unknown as Record<string, unknown>;
  injected.target = { placement: 'sidebar', ready: false };
  injected._mainViewProvider = mainViewProvider;
  injected.context = { extensionUri: { fsPath: '/ext' } };
  injected.contentProvider = { getHtmlContent: () => '<progress-view />' };
  injected.messageHandler = { handleMessage: vi.fn() };
  const state = {
    activeStream: undefined,
    streamLogs: { keys: () => [], get: () => undefined },
    streamStatus: { getAllStreamStates: () => new Map() },
  };
  injected.state = state;
  const backend = {
    activateStream: vi.fn(async () => undefined),
    approvalHandlers: {},
    syncRenderedStreams: vi.fn(async () => {}),
  };
  injected.backend = backend;
  const logger = { error: vi.fn() };
  injected.logger = logger;
  injected.webviewUpdater = {
    isAvailable: () => true,
    setPlacement: vi.fn(),
    sendStreamMetadata: vi.fn(() => undefined),
  };
  return { provider, mainViewProvider, sidebarView, backend, state };
}

describe('progress target ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActiveSidebarView(SIDEBAR_VIEWS.PROGRESS);
    mocks.createWebviewPanel.mockImplementation(() => createPanel());
  });

  it('accepts the ready handshake only from the surface that holds the target', async () => {
    const { provider, sidebarView } = createProvider();

    await provider.markWebviewReady(sidebarView);
    expect(mocks.replayApprovalRequestHandlers).toHaveBeenCalledTimes(1);

    await provider.popOutToEditor();
    const panel = createdPanel();

    // The sidebar was swapped back to the launcher; its late handshake
    // describes content that is no longer the progress target.
    await provider.markWebviewReady(sidebarView);
    expect(mocks.replayApprovalRequestHandlers).toHaveBeenCalledTimes(1);

    await provider.markWebviewReady(panel as unknown as vscode.WebviewPanel);
    expect(mocks.replayApprovalRequestHandlers).toHaveBeenCalledTimes(2);
  });

  it('drops the target when the editor panel is closed', async () => {
    const { provider } = createProvider();

    await provider.popOutToEditor();
    const panel = createdPanel();
    await provider.markWebviewReady(panel as unknown as vscode.WebviewPanel);
    expect(provider.isViewVisible()).toBe(true);

    // The user closes the editor tab: no surface shows progress content, so
    // a panel handshake or a visibility question cannot resolve against the
    // panel that just went away.
    panel.dispose();

    expect(provider.isViewVisible()).toBe(false);
    await provider.markWebviewReady(panel as unknown as vscode.WebviewPanel);
    expect(mocks.replayApprovalRequestHandlers).toHaveBeenCalledTimes(1);
  });

  it('releases the editor panel when the sidebar claims the target', async () => {
    const { provider, mainViewProvider, sidebarView } = createProvider();

    await provider.popOutToEditor();
    const panel = createdPanel();
    expect(getActiveSidebarView()).toBe(SIDEBAR_VIEWS.MAIN);

    await provider.showInSidebar();

    expect(panel.dispose).toHaveBeenCalledTimes(1);
    expect(mainViewProvider.switchMode).toHaveBeenLastCalledWith(
      SIDEBAR_VIEWS.PROGRESS,
    );
    expect(provider.isViewVisible()).toBe(true);
    // The reclaimed sidebar has not re-handshaked, so the claim itself
    // replays nothing; the replay belongs to its ready handshake.
    expect(mocks.replayApprovalRequestHandlers).not.toHaveBeenCalled();
    await provider.markWebviewReady(sidebarView);
    expect(mocks.replayApprovalRequestHandlers).toHaveBeenCalledTimes(1);
  });

  it('reveals the existing panel instead of opening a second one', async () => {
    const { provider } = createProvider();

    await provider.popOutToEditor();
    await provider.popOutToEditor();

    const panel = createdPanel();
    expect(mocks.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(panel.reveal).toHaveBeenCalledTimes(1);
  });
});
