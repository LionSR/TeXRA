// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import type { ProgressHostInteractions } from '@controllers/progressView/backend/progressHostInteractions';
import * as logger from '@logger/logUtils';
import { ProgressViewMessageHandler } from '@progressView/ProgressViewMessageHandler';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import type { StreamTabId } from '@shared/schemas';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';

// Local file imports
import { FakePromptHost } from '../support/FakeHosts';
import {
  createOutputFile,
  createWorkflowConfig,
} from '../support/ProgressControllerHarnesses';
import type * as vscode from 'vscode';

const mocks = vi.hoisted(() => ({
  safeExecuteCommand: vi.fn(),
}));

vi.mock('@frontend/system/commandUtils', () => ({
  safeExecuteCommand: mocks.safeExecuteCommand,
}));

function createWebviewView(): vscode.WebviewView {
  return {
    webview: { postMessage: vi.fn() },
  } as unknown as vscode.WebviewView;
}

type ProgressViewProviderFake = ProgressViewProvider & {
  refreshOnboardingFunnel: ReturnType<typeof vi.fn>;
};

function createHostInteractions(
  overrides: Partial<ProgressHostInteractions> = {},
): ProgressHostInteractions {
  return {
    approvePendingDelegatedWork: vi.fn(async () => undefined),
    isRetryPending: vi.fn(() => false),
    submitBashDecision: vi.fn(() => false),
    submitPlanDecision: vi.fn(() => false),
    submitProposalDecision: vi.fn(() => false),
    submitRetryDecision: vi.fn(() => false),
    submitUserQuestionDecision: vi.fn(() => false),
    dismissExternalInquiry: vi.fn(),
    cancel: vi.fn(),
    ...overrides,
  };
}

function createMessageHandler(
  provider: ProgressViewProvider,
  host = new FakePromptHost(),
  interactions = createHostInteractions(),
): ProgressViewMessageHandler {
  return new ProgressViewMessageHandler(provider, host, interactions);
}

/** `executeValidatedUntilStarted` is private; TS-private is not enforced at runtime. */
function executeValidatedUntilStarted(
  handler: ProgressViewMessageHandler,
): Promise<boolean> {
  return (
    handler as unknown as {
      executeValidatedUntilStarted(request: {
        config: Record<string, never>;
      }): Promise<boolean>;
    }
  ).executeValidatedUntilStarted({ config: {} });
}

function createProgressViewProvider(): ProgressViewProviderFake {
  const snapshots = {
    getRunMetadata: vi.fn(() => ({})),
    getOutputFiles: vi.fn(() => new Map()),
    getKnownFilePaths: vi.fn(() => new Set()),
    getCompileFailures: vi.fn(() => new Map()),
    preload: vi.fn(async () => undefined),
  };
  const state = {
    activeStream: '',
    streamLogs: new Map<StreamTabId, unknown>(),
    snapshots,
    pickValidActiveStream: vi.fn(() => ''),
    waitForOwnedExecutionRelease: vi.fn(async () => undefined),
  };
  return {
    state,
    backend: {
      deleteStream: vi.fn(),
      deleteAllStreams: vi.fn(),
      stopStream: vi.fn(),
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
    const provider = createProgressViewProvider();
    provider.refreshOnboardingFunnel.mockResolvedValue(undefined);
    const handler = createMessageHandler(provider);

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
      expect(
        mocks.safeExecuteCommand.mock.invocationCallOrder[0]!,
      ).toBeLessThan(
        provider.refreshOnboardingFunnel.mock.invocationCallOrder[0]!,
      );
    });
  });

  it('acknowledges a replacement run when the runtime publishes its handle', async () => {
    let finishCommand: ((value: boolean) => void) | undefined;
    mocks.safeExecuteCommand.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finishCommand = resolve;
        }),
    );
    const handler = createMessageHandler(createProgressViewProvider());
    const start = executeValidatedUntilStarted(handler);

    const commandInput = mocks.safeExecuteCommand.mock.calls[0]?.[1]?.[0] as
      { onRun?: () => void } | undefined;
    expect(commandInput?.onRun).toBeTypeOf('function');
    commandInput?.onRun?.();

    await expect(start).resolves.toBe(true);
    finishCommand?.(true);
  });

  it.each([
    {
      label: 'reports a replacement launch failure before a run handle exists',
      settle: () => mocks.safeExecuteCommand.mockResolvedValue(false),
    },
    {
      label: 'settles a replacement launch when command error handling rejects',
      settle: () =>
        mocks.safeExecuteCommand.mockRejectedValue(new Error('command failed')),
    },
  ])('$label', async ({ settle }) => {
    settle();
    const handler = createMessageHandler(createProgressViewProvider());

    await expect(executeValidatedUntilStarted(handler)).resolves.toBe(false);
  });

  it.each([
    'createSampleProject',
    'cloneOverleaf',
    'downloadArxiv',
    'openWalkthrough',
  ] as const)(
    'does not refresh the onboarding funnel for %s',
    async (action) => {
      const provider = createProgressViewProvider();
      const handler = createMessageHandler(provider);

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
    const provider = createProgressViewProvider();
    const prompt = new FakePromptHost({
      promptResponses: ['Cancel', 'Delete All'],
    });
    (
      provider.state.streamLogs as unknown as {
        keys(): StreamTabId[];
      }
    ).keys = vi.fn(() => []);

    const handler = createMessageHandler(provider, prompt);

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
    expect(provider.backend.deleteAllStreams).not.toHaveBeenCalled();

    await handler.handleMessage(
      { command: PROGRESS_VIEW_COMMANDS.DELETE_ALL },
      createWebviewView(),
    );

    expect(provider.backend.deleteAllStreams).toHaveBeenCalledOnce();
  });

  it('routes retry request actions through host interactions', async () => {
    const interactions = createHostInteractions({
      submitRetryDecision: vi.fn(() => true),
    });
    const directHandler = createMessageHandler(
      createProgressViewProvider(),
      new FakePromptHost(),
      interactions,
    );

    await directHandler.handleMessage(
      {
        command: PROGRESS_VIEW_COMMANDS.RETRY_STREAM_REQUEST,
        stream: 'stream-a',
        requestId: 'retry-a',
        feedback: 'try the other branch',
      },
      createWebviewView(),
    );
    await directHandler.handleMessage(
      {
        command: PROGRESS_VIEW_COMMANDS.CANCEL_RETRY_REQUEST,
        stream: 'stream-a',
        requestId: 'retry-a',
      },
      createWebviewView(),
    );

    expect(interactions.submitRetryDecision).toHaveBeenCalledWith(
      'stream-a',
      'retry-a',
      {
        action: 'retry',
        feedback: 'try the other branch',
      },
    );
    expect(interactions.submitRetryDecision).toHaveBeenCalledWith(
      'stream-a',
      'retry-a',
      {
        action: 'cancel',
      },
    );
  });

  it('reports missing retry requests when no pending interaction matches', async () => {
    const provider = createProgressViewProvider();
    const prompt = new FakePromptHost();
    const handler = createMessageHandler(
      provider,
      prompt,
      createHostInteractions({ submitRetryDecision: vi.fn(() => false) }),
    );

    await handler.handleMessage(
      {
        command: PROGRESS_VIEW_COMMANDS.RETRY_STREAM_REQUEST,
        stream: 'stream-a',
        requestId: 'retry-a',
      },
      createWebviewView(),
    );

    expect(prompt.messages).toContainEqual({
      kind: 'info',
      message: 'No retryable request is available for this stream yet.',
    });
  });

  it.each([
    {
      label: 'agent proposal',
      method: 'submitProposalDecision' as const,
      message: {
        command: PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION,
        proposalId: 'proposal-a',
        action: 'approve',
        model: 'gemini31p',
        agent: 'critic',
      },
      expectedArgs: [
        'proposal-a',
        { action: 'approve', model: 'gemini31p', agent: 'critic' },
      ],
    },
    {
      label: 'plan approval',
      method: 'submitPlanDecision' as const,
      message: {
        command: PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION,
        approvalId: 'plan-a',
        action: 'reject',
        feedback: 'state the invariant first',
      },
      expectedArgs: [
        'plan-a',
        { action: 'reject', feedback: 'state the invariant first' },
      ],
    },
  ])(
    'routes $label actions through host interactions',
    async ({ method, message, expectedArgs }) => {
      const decision = vi.fn(() => true);
      const interactions = createHostInteractions({
        [method]: decision,
      } as Partial<ProgressHostInteractions>);
      const handler = createMessageHandler(
        createProgressViewProvider(),
        new FakePromptHost(),
        interactions,
      );

      await handler.handleMessage(message, createWebviewView());

      expect(decision).toHaveBeenCalledWith(...expectedArgs);
    },
  );

  it('routes workflow toolbar actions through extension capabilities', async () => {
    const provider = createProgressViewProvider();
    const runConfig = createWorkflowConfig({ outputFiles: ['declared.tex'] });
    const output = createOutputFile();
    vi.mocked(provider.state.snapshots.getRunMetadata).mockReturnValue({
      config: runConfig,
      executionId: 'exec-123',
    });
    vi.mocked(provider.state.snapshots.getOutputFiles).mockReturnValue({
      1: [output],
    });
    vi.mocked(provider.state.snapshots.getKnownFilePaths).mockReturnValue(
      new Set(['/workspace/generated.tex', 'extra.tex']),
    );
    const handler = createMessageHandler(provider);
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
          outputFilesActive: true,
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

  it('logs deletion failures from stream removal instead of a raw rejection', async () => {
    const provider = createProgressViewProvider();
    const deletionError = new Error('delete failed');
    const deleteStream = provider.backend.deleteStream as unknown as ReturnType<
      typeof vi.fn
    >;
    deleteStream.mockRejectedValue(deletionError);
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const handler = createMessageHandler(provider);

    await handler.handleMessage(
      {
        command: PROGRESS_VIEW_COMMANDS.DELETE_STREAM,
        stream: 'missing' as StreamTabId,
      },
      createWebviewView(),
    );

    expect(deleteStream).toHaveBeenCalledWith('missing');
    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith(
        'ProgressViewMessageHandler',
        'Error handling message',
        expect.objectContaining({ data: deletionError }),
      );
    });
  });
});
