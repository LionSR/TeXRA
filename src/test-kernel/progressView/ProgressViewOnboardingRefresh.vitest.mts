// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - progress view
import { ProgressViewMessageHandler } from '@progressView/ProgressViewMessageHandler';

// Local imports - shared
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type { StreamTabId } from '@shared/schemas';
import type * as vscode from 'vscode';

const mocks = vi.hoisted(() => ({
  safeExecuteCommand: vi.fn(),
}));

vi.mock('@frontend/system/commandUtils', () => ({
  safeExecuteCommand: mocks.safeExecuteCommand,
}));

function createExtensionContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

function createWebviewView(): vscode.WebviewView {
  return {
    webview: { postMessage: vi.fn() },
  } as unknown as vscode.WebviewView;
}

function createProgressViewProvider(): unknown {
  const snapshots = {
    getTaskState: vi.fn(),
    getExecutionId: vi.fn(),
    getOutputFiles: vi.fn(() => new Map()),
    getKnownFilePaths: vi.fn(() => new Set()),
    getCompileFailures: vi.fn(() => new Map()),
  };
  return {
    state: {
      activeStream: '',
      agentCategoryFilter: 'all',
      streamLogs: new Map<StreamTabId, unknown>(),
      snapshots,
      pickValidActiveStream: vi.fn(() => ''),
      clearStream: vi.fn(),
      clearAll: vi.fn(),
    },
    webviewUpdater: {
      updateGoalActive: vi.fn(),
    },
    webviewBridge: {
      clearStream: vi.fn(),
      clearAll: vi.fn(),
    },
    getPendingAgentProposal: vi.fn(),
    markWebviewReady: vi.fn(),
    popOutToEditor: vi.fn(),
    popBackToSidebar: vi.fn(),
    refreshOnboardingFunnel: vi.fn(),
    setActiveStream: vi.fn(),
    syncFullView: vi.fn(),
  };
}

describe('progress-view onboarding refresh wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.safeExecuteCommand.mockResolvedValue(undefined);
  });

  it('refreshes the onboarding funnel after progress setup actions', () => {
    const context = createExtensionContext();
    const provider = createProgressViewProvider() as {
      refreshOnboardingFunnel: ReturnType<typeof vi.fn>;
    };
    provider.refreshOnboardingFunnel.mockResolvedValue(undefined);
    const handler = new ProgressViewMessageHandler(provider as never, context);

    void handler.handleMessage(
      {
        command: PROGRESS_VIEW_COMMANDS.GETTING_STARTED_ACTION,
        action: 'runSetup',
      },
      createWebviewView(),
    );

    return vi.waitFor(() => {
      expect(mocks.safeExecuteCommand).toHaveBeenCalledWith(
        'texra.runSetupAssistant',
        [],
        'ProgressView',
      );
      expect(provider.refreshOnboardingFunnel).toHaveBeenCalledOnce();
    });
  });
});
