// Theme flips must send THEME_SET alone — never a full stream-metadata
// rebuild, which scales with total workspace history (#9959).

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as vscode from 'vscode';

const mocks = vi.hoisted(() => ({
  backend: {
    approvalHandlers: { toolEdit: { show: vi.fn(), dismiss: vi.fn() } },
    dispose: vi.fn(),
    setupEventListeners: vi.fn(),
    setApprovalBypassState: vi.fn(),
    state: {
      streamStatus: { getAllStreamStates: vi.fn(() => new Map()) },
    },
    webviewUpdater: {
      isAvailable: vi.fn(() => true),
      setTheme: vi.fn(),
      setPlacement: vi.fn(),
      sendStreamMetadata: vi.fn(),
    },
  },
  themeListeners: [] as Array<(theme: { kind: number }) => void>,
}));

vi.mock('vscode', () => ({
  ColorThemeKind: { Light: 1, Dark: 2 },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  window: {
    activeColorTheme: { kind: 1 },
    onDidChangeActiveColorTheme: (
      listener: (theme: { kind: number }) => void,
    ) => {
      mocks.themeListeners.push(listener);
      return { dispose: vi.fn() };
    },
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
  },
  workspace: {
    onDidChangeWorkspaceFolders: () => ({ dispose: vi.fn() }),
  },
}));

vi.mock('@common/webview', () => ({
  BaseWebviewProvider: class {
    protected readonly _disposables: Array<{ dispose(): void }> = [];

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
  tryDefaultSession: () => ({
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
vi.mock('@eventBus/AppSignals', () => ({
  appSignals: { on: () => () => {} },
}));

const { ProgressViewProvider } =
  await import('@progressView/ProgressViewProvider');

function createProvider(): InstanceType<typeof ProgressViewProvider> {
  return new ProgressViewProvider(
    {
      storageUri: { fsPath: '/tmp/ext-storage' },
    } as unknown as vscode.ExtensionContext,
    {} as never,
    { getWorkspacePath: () => undefined } as never,
  );
}

function fireThemeChange(kind: number): void {
  for (const listener of mocks.themeListeners) listener({ kind });
}

describe('progress view theme sync', () => {
  beforeEach(() => {
    mocks.themeListeners.length = 0;
    mocks.backend.webviewUpdater.setTheme.mockClear();
    mocks.backend.webviewUpdater.sendStreamMetadata.mockClear();
  });

  it('sends only the theme message on theme change, mapped by kind', () => {
    const provider = createProvider();
    const panel = { visible: true };
    (provider as unknown as Record<string, unknown>).target = {
      placement: 'editor',
      panel,
      disposables: [],
      ready: true,
    };

    fireThemeChange(2);
    fireThemeChange(1);

    expect(
      mocks.backend.webviewUpdater.setTheme.mock.calls.map(([theme]) => theme),
    ).toEqual(['dark', 'light']);
    // The regression this pins down: no full stream-metadata rebuild.
    expect(
      mocks.backend.webviewUpdater.sendStreamMetadata,
    ).not.toHaveBeenCalled();
  });

  it('drops theme changes while no progress surface is visible', () => {
    const provider = createProvider();
    (provider as unknown as Record<string, unknown>).target = {
      placement: 'editor',
      panel: { visible: false },
      disposables: [],
      ready: true,
    };

    fireThemeChange(2);

    expect(mocks.backend.webviewUpdater.setTheme).not.toHaveBeenCalled();
  });
});
