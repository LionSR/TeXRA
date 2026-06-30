// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - agent runtime
import type { RunCoordinatorBridge } from '@agent/runtime/runCoordinators';

// Local imports - progress view
import { ProgressViewMessageHandler } from '@progressView/ProgressViewMessageHandler';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';

// Local imports - shared
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type { StreamTabId } from '@shared/schemas';

// Local imports - test support
import { FakePromptHost } from '../support/FakeHosts';

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

type CoordinatorBridgeFake = Pick<
  RunCoordinatorBridge,
  | 'cancelRetry'
  | 'clearRetryRequest'
  | 'resolvePlanApproval'
  | 'resolveProposal'
  | 'triggerRetry'
>;

function createCoordinatorBridge(
  overrides: Partial<CoordinatorBridgeFake> = {},
): CoordinatorBridgeFake {
  return {
    cancelRetry: vi.fn(() => false),
    clearRetryRequest: vi.fn(),
    resolvePlanApproval: vi.fn(() => false),
    resolveProposal: vi.fn(() => false),
    triggerRetry: vi.fn(() => true),
    ...overrides,
  };
}

function createMessageHandler(
  provider: ProgressViewProvider,
  context: vscode.ExtensionContext,
  host = new FakePromptHost(),
  coordinators = createCoordinatorBridge(),
): ProgressViewMessageHandler {
  return new ProgressViewMessageHandler(provider, context, host, coordinators);
}

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
    const handler = createMessageHandler(provider, context);

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
      const handler = createMessageHandler(provider, context);

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

  it('uses PromptHost warning options before deleting all streams', async () => {
    const context = createExtensionContext();
    const provider = createProgressViewProvider();
    const prompt = new FakePromptHost({
      promptResponses: ['Cancel', 'Delete All'],
    });
    (
      provider.state.streamLogs as unknown as {
        keys(): StreamTabId[];
      }
    ).keys = vi.fn(() => []);

    const handler = createMessageHandler(provider, context, prompt);

    await handler.handleMessage(
      { command: PROGRESS_VIEW_COMMANDS.DELETE_ALL },
      createWebviewView(),
    );

    expect(prompt.messages[0]).toMatchObject({
      kind: 'warning',
      message:
        'Are you sure you want to delete all streams? This action cannot be undone.',
      options: {
        modal: true,
        items: ['Delete All', { label: 'Cancel', isCloseAffordance: true }],
      },
    });
    expect(provider.state.clearAll).not.toHaveBeenCalled();

    await handler.handleMessage(
      { command: PROGRESS_VIEW_COMMANDS.DELETE_ALL },
      createWebviewView(),
    );

    expect(provider.state.clearAll).toHaveBeenCalledOnce();
    expect(provider.webviewBridge.clearAll).toHaveBeenCalledOnce();
    expect(provider.syncFullView).toHaveBeenCalledWith({
      forceRebuild: true,
    });
  });

  it('routes retry request actions through the injected coordinators', async () => {
    const context = createExtensionContext();
    const provider = createProgressViewProvider();
    const coordinators = createCoordinatorBridge();
    const handler = createMessageHandler(
      provider,
      context,
      new FakePromptHost(),
      coordinators,
    );

    await handler.handleMessage(
      {
        command: PROGRESS_VIEW_COMMANDS.RETRY_STREAM_REQUEST,
        stream: 'stream-a',
        feedback: 'try the other branch',
      },
      createWebviewView(),
    );
    await handler.handleMessage(
      {
        command: PROGRESS_VIEW_COMMANDS.CANCEL_RETRY_REQUEST,
        stream: 'stream-a',
      },
      createWebviewView(),
    );

    expect(coordinators.triggerRetry).toHaveBeenCalledWith(
      'stream-a',
      'try the other branch',
    );
    expect(coordinators.cancelRetry).toHaveBeenCalledWith('stream-a');
  });

  it('reports missing retry requests from the injected coordinators', async () => {
    const context = createExtensionContext();
    const provider = createProgressViewProvider();
    const prompt = new FakePromptHost();
    const coordinators = createCoordinatorBridge({
      triggerRetry: vi.fn(() => false),
    });
    const handler = createMessageHandler(
      provider,
      context,
      prompt,
      coordinators,
    );

    await handler.handleMessage(
      {
        command: PROGRESS_VIEW_COMMANDS.RETRY_STREAM_REQUEST,
        stream: 'stream-a',
      },
      createWebviewView(),
    );

    expect(prompt.messages).toContainEqual({
      kind: 'info',
      message: 'No retryable request is available for this stream yet.',
    });
  });

  it('routes agent proposal actions through the injected coordinators', async () => {
    const context = createExtensionContext();
    const provider = createProgressViewProvider();
    const coordinators = createCoordinatorBridge();
    const handler = createMessageHandler(
      provider,
      context,
      new FakePromptHost(),
      coordinators,
    );

    await handler.handleMessage(
      {
        command: PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION,
        proposalId: 'proposal-a',
        action: 'approve',
        model: 'gemini31p',
        agent: 'critic',
      },
      createWebviewView(),
    );

    expect(coordinators.resolveProposal).toHaveBeenCalledWith('proposal-a', {
      action: 'approve',
      model: 'gemini31p',
      agent: 'critic',
    });
  });

  it('routes plan approval actions through the injected coordinators', async () => {
    const context = createExtensionContext();
    const provider = createProgressViewProvider();
    const coordinators = createCoordinatorBridge();
    const handler = createMessageHandler(
      provider,
      context,
      new FakePromptHost(),
      coordinators,
    );

    await handler.handleMessage(
      {
        command: PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION,
        approvalId: 'plan-a',
        action: 'reject',
        feedback: 'state the invariant first',
      },
      createWebviewView(),
    );

    expect(coordinators.resolvePlanApproval).toHaveBeenCalledWith('plan-a', {
      action: 'reject',
      feedback: 'state the invariant first',
    });
  });

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
