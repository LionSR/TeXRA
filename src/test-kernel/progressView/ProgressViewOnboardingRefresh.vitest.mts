// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - agent runtime
import type { HostInteractions } from '@agent/runtime/HostInteractions';

// Local imports - progress view
import { ProgressViewMessageHandler } from '@progressView/ProgressViewMessageHandler';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import type { ExtensionHostInteractions } from '@progressView/extensionHostInteractions';

// Local imports - shared
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type { StreamTabId } from '@shared/schemas';

// Local imports - test support
import { FakePromptHost } from '../support/FakeHosts';
import {
  createOutputFile,
  createWorkflowTaskState,
} from '../support/ProgressControllerHarnesses';

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

function createHostInteractions(
  overrides: Partial<HostInteractions> = {},
): ExtensionHostInteractions {
  return {
    approvePendingDelegatedWork: vi.fn(async () => undefined),
    resolve: vi.fn(() => false),
    cancel: vi.fn(),
    ...overrides,
  };
}

function createMessageHandler(
  provider: ProgressViewProvider,
  context: vscode.ExtensionContext,
  host = new FakePromptHost(),
  interactions = createHostInteractions(),
): ProgressViewMessageHandler {
  return new ProgressViewMessageHandler(provider, context, host, interactions);
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

  it('routes retry request actions through host interactions', async () => {
    const interactions = createHostInteractions({
      resolve: vi.fn(() => true),
    });
    const directHandler = createMessageHandler(
      createProgressViewProvider(),
      createExtensionContext(),
      new FakePromptHost(),
      interactions,
    );

    await directHandler.handleMessage(
      {
        command: PROGRESS_VIEW_COMMANDS.RETRY_STREAM_REQUEST,
        stream: 'stream-a',
        feedback: 'try the other branch',
      },
      createWebviewView(),
    );
    await directHandler.handleMessage(
      {
        command: PROGRESS_VIEW_COMMANDS.CANCEL_RETRY_REQUEST,
        stream: 'stream-a',
      },
      createWebviewView(),
    );

    expect(interactions.resolve).toHaveBeenCalledWith('stream-a', {
      kind: 'retry',
      action: 'retry',
      feedback: 'try the other branch',
    });
    expect(interactions.resolve).toHaveBeenCalledWith('stream-a', {
      kind: 'retry',
      action: 'cancel',
    });
  });

  it('reports missing retry requests when no pending interaction matches', async () => {
    const context = createExtensionContext();
    const provider = createProgressViewProvider();
    const prompt = new FakePromptHost();
    const handler = createMessageHandler(
      provider,
      context,
      prompt,
      createHostInteractions({ resolve: vi.fn(() => false) }),
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

  it('routes agent proposal actions through host interactions', async () => {
    const interactions = createHostInteractions({
      resolve: vi.fn(() => true),
    });
    const handler = createMessageHandler(
      createProgressViewProvider(),
      createExtensionContext(),
      new FakePromptHost(),
      interactions,
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

    expect(interactions.resolve).toHaveBeenCalledWith('proposal-a', {
      kind: 'proposal',
      action: 'approve',
      value: {
        action: 'approve',
        model: 'gemini31p',
        agent: 'critic',
      },
    });
  });

  it('routes plan approval actions through host interactions', async () => {
    const interactions = createHostInteractions({
      resolve: vi.fn(() => true),
    });
    const handler = createMessageHandler(
      createProgressViewProvider(),
      createExtensionContext(),
      new FakePromptHost(),
      interactions,
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

    expect(interactions.resolve).toHaveBeenCalledWith('plan-a', {
      kind: 'plan',
      action: 'reject',
      feedback: 'state the invariant first',
    });
  });

  it('routes workflow toolbar actions through extension capabilities', async () => {
    const provider = createProgressViewProvider();
    const taskState = createWorkflowTaskState(
      { outputFiles: ['declared.tex'] },
      { output: false },
    );
    const output = createOutputFile();
    vi.mocked(provider.state.snapshots.getTaskState).mockReturnValue(taskState);
    vi.mocked(provider.state.snapshots.getExecutionId).mockReturnValue(
      'exec-123',
    );
    vi.mocked(provider.state.snapshots.getOutputFiles).mockReturnValue({
      1: [output],
    });
    vi.mocked(provider.state.snapshots.getKnownFilePaths).mockReturnValue(
      new Set(['/workspace/generated.tex', 'extra.tex']),
    );
    const handler = createMessageHandler(provider, createExtensionContext());
    const view = createWebviewView();

    await handler.handleMessage(
      { command: PROGRESS_VIEW_COMMANDS.DIFF_STREAM, stream: 'stream-a' },
      view,
    );
    await handler.handleMessage(
      { command: PROGRESS_VIEW_COMMANDS.PACK_STREAM, stream: 'stream-a' },
      view,
    );
    await handler.handleMessage(
      { command: PROGRESS_VIEW_COMMANDS.CLEAN_STREAM, stream: 'stream-a' },
      view,
    );

    expect(mocks.safeExecuteCommand).toHaveBeenNthCalledWith(
      1,
      'texra.runLatexdiff',
      [
        {
          agent: 'correct',
          model: 'gemini31p',
          inputFile: 'input.tex',
          outputFiles: ['declared.tex'],
          outputFilesActive: false,
          streamId: 'stream-a',
          runId: 'exec-123',
          outputsByRound: { 1: [output] },
        },
      ],
      'ProgressView',
    );
    const fileOperationRequest = {
      streamId: 'stream-a',
      agent: 'correct',
      model: 'gemini31p',
      inputFile: 'input.tex',
      outputFiles: ['declared.tex', '/workspace/generated.tex', 'extra.tex'],
      executionId: 'exec-123',
      skipProgressViewClear: true,
    };
    expect(mocks.safeExecuteCommand).toHaveBeenNthCalledWith(
      2,
      'texra.pack',
      [fileOperationRequest],
      'ProgressView',
    );
    expect(mocks.safeExecuteCommand).toHaveBeenNthCalledWith(
      3,
      'texra.clean',
      [fileOperationRequest],
      'ProgressView',
    );
    expect(provider.state.snapshots.getKnownFilePaths).toHaveBeenCalledTimes(2);
    expect(provider.state.snapshots.getKnownFilePaths).toHaveBeenCalledWith(
      'stream-a',
      { workspaceOnly: true },
    );
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

  it('returns deletion failures from host removeStream handling', async () => {
    const context = createExtensionContext();
    const provider = createProgressViewProvider();
    const handler = createMessageHandler(provider, context);
    const deletionError = new Error('delete failed');
    const clearStream = provider.state.clearStream as ReturnType<typeof vi.fn>;
    clearStream.mockRejectedValue(deletionError);

    const result = handler.removeStreamFromHost('missing' as StreamTabId);

    expect(result).toBeInstanceOf(Promise);
    await expect(result).rejects.toBe(deletionError);
    expect(clearStream).toHaveBeenCalledWith('missing');
  });
});
