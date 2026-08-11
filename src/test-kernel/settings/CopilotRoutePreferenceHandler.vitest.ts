// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invalidateModelOptionsCache: vi.fn(),
  invalidateRuntimeModelRegistry: vi.fn(),
  requestRuntimeModelAccess: vi.fn(),
  safeExecuteCommand: vi.fn(async () => undefined),
  setCopilotRoutePreference: vi.fn(async () => undefined),
  showLoggedErrorMessage: vi.fn(async () => undefined),
  showLoggedInfoMessage: vi.fn(async () => undefined),
}));

vi.mock('@model/runtimeModelRegistry', async (original) => {
  const actual = await original<typeof import('@model/runtimeModelRegistry')>();
  return {
    ...actual,
    invalidateRuntimeModelRegistry: mocks.invalidateRuntimeModelRegistry,
    requestRuntimeModelAccess: mocks.requestRuntimeModelAccess,
  };
});

vi.mock('@model/copilotRouting', async (original) => {
  const actual = await original<typeof import('@model/copilotRouting')>();
  return {
    ...actual,
    setCopilotRoutePreference: mocks.setCopilotRoutePreference,
  };
});

vi.mock('@model/computeModelOptions', async (original) => {
  const actual = await original<typeof import('@model/computeModelOptions')>();
  return {
    ...actual,
    invalidateModelOptionsCache: mocks.invalidateModelOptionsCache,
  };
});

vi.mock('@frontend/system/commandUtils', async (original) => {
  const actual =
    await original<typeof import('@frontend/system/commandUtils')>();
  return { ...actual, safeExecuteCommand: mocks.safeExecuteCommand };
});

vi.mock('@frontend/ui/errorHandlingUtils', async (original) => {
  const actual =
    await original<typeof import('@frontend/ui/errorHandlingUtils')>();
  return {
    ...actual,
    showLoggedErrorMessage: mocks.showLoggedErrorMessage,
    showLoggedInfoMessage: mocks.showLoggedInfoMessage,
  };
});

// The shared vscode stub predates workspace-folder listeners; the handler's
// constructor subscribes to folder changes to re-register its history watcher.
vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vscode')>();
  return {
    ...actual,
    workspace: {
      ...actual.workspace,
      onDidChangeWorkspaceFolders: () => ({ dispose: () => {} }),
    },
  };
});

// Local imports
import { SettingsViewMessageHandler } from '@settingsView/SettingsViewMessageHandler';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type * as vscode from 'vscode';

/** Private method type surface used only to stub the post-action refresh. */
type RefreshSurface = {
  sendModelSelectionData(webview: vscode.Webview): Promise<void>;
};

/**
 * The real constructor wires channel/viewName, the command registry, and the
 * history watcher from the extension context; the fake context only needs the
 * subscriptions sink and an extension path for handler delegates.
 */
function createHandler(): SettingsViewMessageHandler {
  return new SettingsViewMessageHandler({
    subscriptions: [],
    extensionPath: '/ext',
  } as unknown as vscode.ExtensionContext);
}

function createWebviewView(): vscode.WebviewView {
  // Dispatch attaches visibility tracking for the executions watcher (#9959),
  // so the view must expose the visibility surface. `visible: false` keeps the
  // watcher unregistered — history refresh is orthogonal to routing.
  return {
    visible: false,
    onDidChangeVisibility: () => ({ dispose: () => {} }),
    webview: { postMessage: vi.fn(async () => true) },
  } as unknown as vscode.WebviewView;
}

function requestModelAccess(
  handler: SettingsViewMessageHandler,
  modelName: string,
): Promise<void> {
  return handler.handleMessage(
    { command: SETTINGS_VIEW_COMMANDS.REQUEST_MODEL_ACCESS, modelName },
    createWebviewView(),
  );
}

function clearCopilotRoute(
  handler: SettingsViewMessageHandler,
  modelName: string,
): Promise<void> {
  return handler.handleMessage(
    { command: SETTINGS_VIEW_COMMANDS.CLEAR_COPILOT_ROUTE, modelName },
    createWebviewView(),
  );
}

describe('Copilot route preference handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The refresh fan-out after a route change re-sends the full model
    // selection payload; it is orthogonal to the routing decision under test.
    // A prototype spy fails loudly on rename, unlike an injected field.
    vi.spyOn(
      SettingsViewMessageHandler.prototype as unknown as RefreshSurface,
      'sendModelSelectionData',
    ).mockResolvedValue(undefined);
  });

  it('revalidates and persists an allowed opt-in', async () => {
    mocks.requestRuntimeModelAccess.mockResolvedValueOnce('already-allowed');
    const handler = createHandler();

    await requestModelAccess(handler, 'sonnet46');

    await vi.waitFor(() => {
      expect(mocks.setCopilotRoutePreference).toHaveBeenCalledWith(
        'sonnet46',
        true,
      );
    });
    expect(mocks.requestRuntimeModelAccess).toHaveBeenCalledWith('sonnet46');
    expect(mocks.showLoggedInfoMessage).not.toHaveBeenCalled();
  });

  it('uses the current consent flow before persisting a stale allowed opt-in', async () => {
    mocks.requestRuntimeModelAccess.mockResolvedValueOnce('requested');
    const handler = createHandler();

    await requestModelAccess(handler, 'sonnet46');

    await vi.waitFor(() => {
      expect(mocks.setCopilotRoutePreference).toHaveBeenCalledWith(
        'sonnet46',
        true,
      );
    });
    expect(mocks.requestRuntimeModelAccess).toHaveBeenCalledWith('sonnet46');
  });

  it('rejects an opt-in that has become unavailable with actionable feedback', async () => {
    mocks.requestRuntimeModelAccess.mockResolvedValueOnce('unavailable');
    const handler = createHandler();

    await requestModelAccess(handler, 'sonnet46');

    await vi.waitFor(() => {
      expect(mocks.showLoggedInfoMessage).toHaveBeenCalledWith(
        'SettingsViewMessageHandler',
        'This Copilot model is no longer available in VS Code. Refresh the model list and choose another model.',
      );
    });
    expect(mocks.setCopilotRoutePreference).not.toHaveBeenCalled();
  });

  it('allows opt-out without consulting current Copilot access', async () => {
    const handler = createHandler();

    await clearCopilotRoute(handler, 'sonnet46');

    await vi.waitFor(() => {
      expect(mocks.setCopilotRoutePreference).toHaveBeenCalledWith(
        'sonnet46',
        false,
      );
    });
    expect(mocks.requestRuntimeModelAccess).not.toHaveBeenCalled();
  });
});
