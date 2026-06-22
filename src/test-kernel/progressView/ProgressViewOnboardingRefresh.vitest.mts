// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - progress view
import { ProgressViewMessageHandler } from '@progressView/ProgressViewMessageHandler';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';

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

type ProgressViewProviderFake = ProgressViewProvider & {
  refreshOnboardingFunnel: ReturnType<typeof vi.fn>;
};

function createProgressViewProvider(): ProgressViewProviderFake {
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
  } as unknown as ProgressViewProviderFake;
}

function createProviderShell(
  mainViewProvider?: Pick<ProgressViewProvider, 'refreshOnboardingFunnel'>,
): ProgressViewProvider {
  const provider = Object.create(
    ProgressViewProvider.prototype,
  ) as ProgressViewProvider;
  (
    provider as unknown as {
      _mainViewProvider?: Pick<ProgressViewProvider, 'refreshOnboardingFunnel'>;
    }
  )._mainViewProvider = mainViewProvider;
  return provider;
}

describe('progress-view onboarding refresh wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.safeExecuteCommand.mockResolvedValue(undefined);
  });

  it('refreshes the onboarding funnel after progress setup actions', async () => {
    const context = createExtensionContext();
    const provider = createProgressViewProvider();
    provider.refreshOnboardingFunnel.mockResolvedValue(undefined);
    const handler = new ProgressViewMessageHandler(provider, context);

    await handler.handleMessage(
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
      const setupCallOrder =
        mocks.safeExecuteCommand.mock.invocationCallOrder[0];
      const refreshCallOrder =
        provider.refreshOnboardingFunnel.mock.invocationCallOrder[0];
      expect(setupCallOrder).toBeDefined();
      expect(refreshCallOrder).toBeDefined();
      expect(setupCallOrder!).toBeLessThan(refreshCallOrder!);
    });
  });

  it.each([
    'createSampleProject',
    'cloneOverleaf',
    'downloadArxiv',
    'openWalkthrough',
  ] as const)(
    'does not refresh the onboarding funnel for %s',
    async (action) => {
      const context = createExtensionContext();
      const provider = createProgressViewProvider();
      const handler = new ProgressViewMessageHandler(provider, context);

      await handler.handleMessage(
        {
          command: PROGRESS_VIEW_COMMANDS.GETTING_STARTED_ACTION,
          action,
        },
        createWebviewView(),
      );

      await vi.waitFor(() => {
        expect(mocks.safeExecuteCommand).toHaveBeenCalledOnce();
      });
      expect(provider.refreshOnboardingFunnel).not.toHaveBeenCalled();
    },
  );

  it('delegates onboarding refresh through the main view provider', async () => {
    const refreshOnboardingFunnel = vi.fn().mockResolvedValue(undefined);
    const provider = createProviderShell({ refreshOnboardingFunnel });

    await provider.refreshOnboardingFunnel();

    expect(refreshOnboardingFunnel).toHaveBeenCalledOnce();
  });

  it('ignores onboarding refresh when no main view provider is wired', async () => {
    const provider = createProviderShell();

    await expect(provider.refreshOnboardingFunnel()).resolves.toBeUndefined();
  });
});
