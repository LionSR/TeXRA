// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  lookupApiKey: vi.fn(),
  notify: vi.fn(),
  secrets: {},
  setCliApiMode: vi.fn(async () => undefined),
  setCliCodexSubscription: vi.fn(async () => undefined),
}));

vi.mock('@cli/chat/tui/notifications/terminalNotifier', () => ({
  notify: mocks.notify,
}));

vi.mock('@cli/runtime/apiAccessMode', async (importActual) => {
  const actual =
    await importActual<typeof import('@cli/runtime/apiAccessMode')>();
  return {
    ...actual,
    setCliApiMode: mocks.setCliApiMode,
  };
});

vi.mock('@cli/chat/tui/state/codexSubscription', () => ({
  setCliCodexSubscription: mocks.setCliCodexSubscription,
}));

vi.mock('@model/apiProviders', async (importActual) => {
  const actual = await importActual<typeof import('@model/apiProviders')>();
  return {
    ...actual,
    lookupApiKey: mocks.lookupApiKey,
  };
});

vi.mock('@platform/platform', () => ({
  platform: () => ({ secrets: mocks.secrets }),
}));

import type { HostInteractions } from '@agent/runtime/HostInteractions';
import { defaultSession } from '@agent/runtime/SessionHandle';
import type { RuntimeInteractionEventPayloads } from '@agent/runtime/runtimeInteractionEvents';
import {
  clearApprovals,
  currentApproval,
  enqueueApproval,
  pendingApprovalSummaries,
} from '@cli/chat/tui/state/approvalQueue';
import { resetCliState, streams } from '@cli/chat/tui/state/cliState';
import { createTuiHostInteractions } from '@cli/chat/tui/state/subscribeApprovals';
import { hasCliApprovalDenied } from '@cli/runtime/approvalAdapter';
import type { CliContext } from '@cli/runtime/cliContext';
import type { CliRuntimeHost } from '@cli/runtime/runtimeHost';
import { API_PROVIDERS, type ApiProvider } from '@model/apiProviders';
import { AgentCategory } from '@shared/schemas';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { setGoalSessionBashAutoApproval } from '@tools/goal';
import {
  cleanupAllApprovals,
  isApprovalBypassedForStream,
  isBashApprovalBypassedForStream,
  proposalApprovals,
} from '@tools/approval';

function context(): CliContext {
  return createTestCliContext({
    cwd: '/work',
    mode: 'interactive',
    approvalPolicy: 'ask',
    version: 'test',
    resourcesPath: '/resources',
  });
}

function host(): CliRuntimeHost {
  return {
    emit: vi.fn(),
    close: vi.fn(async () => undefined),
  } as unknown as CliRuntimeHost;
}

function tui(runtimeHost = host()): {
  readonly runtimeHost: CliRuntimeHost;
  readonly cliContext: CliContext;
  readonly interactions: HostInteractions;
  readonly dispose: () => void;
} {
  const cliContext = context();
  const interactions = createTuiHostInteractions(runtimeHost, cliContext);
  const detachInteractions = defaultSession().useHostInteractions(interactions);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    detachInteractions();
    interactions.dispose?.();
  };
  onTestFinished(dispose);
  return {
    runtimeHost,
    cliContext,
    interactions,
    dispose,
  };
}

function relayRetry(params: {
  streamId: string;
  provider?: string;
  message?: string;
}): RuntimeInteractionEventPayloads['showRetryRequest'] {
  return {
    streamId: params.streamId,
    operation: 'model request',
    errorMessage: params.message ?? 'Relay monthly limit reached.',
    errorDetails: {
      message: params.message ?? 'Relay monthly limit reached.',
      exhaustionReason: 'relay-limit',
      isRelayError: true,
      ...(params.provider ? { provider: params.provider } : {}),
    },
  } as RuntimeInteractionEventPayloads['showRetryRequest'];
}

function chatGptSubscriptionRetry(
  streamId: string,
): RuntimeInteractionEventPayloads['showRetryRequest'] {
  return {
    streamId,
    operation: 'model request',
    errorMessage: 'ChatGPT subscription usage limit reached.',
    errorDetails: {
      message: 'ChatGPT subscription usage limit reached.',
      exhaustionReason: 'chatgpt-subscription',
      provider: 'openai',
    },
  } as RuntimeInteractionEventPayloads['showRetryRequest'];
}

afterEach(() => {
  clearApprovals();
  cleanupAllApprovals();
  resetCliState();
  mocks.lookupApiKey.mockReset();
  mocks.notify.mockReset();
  mocks.setCliApiMode.mockClear();
  mocks.setCliCodexSubscription.mockClear();
});

describe('TUI retry approvals', () => {
  it('does not mutate the runtime host emitter', () => {
    const runtimeHost = host();
    const originalEmit = runtimeHost.emit;
    tui(runtimeHost);
    expect(runtimeHost.emit).toBe(originalEmit);
  });

  it('updates TUI bash bypass state at the approval decision site', async () => {
    const { runtimeHost, interactions } = tui();
    const result = interactions.requestBashApproval?.({
      command: 'echo ok',
      streamId: 'bash-bypass-stream',
    });

    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload).toMatchObject({
        kind: 'bash',
        payload: { streamId: 'bash-bypass-stream' },
      });
    });
    currentApproval.get()?.decide({ accepted: true, bypass: 'bash' });

    await expect(result).resolves.toEqual({
      accepted: true,
      userMessage: undefined,
    });
    expect(streams.get().get('bash-bypass-stream')?.bypass.bash).toBe(true);
    expect(runtimeHost.emit).toHaveBeenCalledWith(
      'updateBashApprovalBypassState',
      {
        streamId: 'bash-bypass-stream',
        bypassActive: true,
      },
    );
  });

  it('updates TUI bash bypass state when goal auto-approval is enabled and cleared', async () => {
    const { runtimeHost } = tui();
    await setGoalSessionBashAutoApproval(
      'goal-bypass-stream',
      true,
      runtimeHost,
    );
    expect(streams.get().get('goal-bypass-stream')?.bypass.bash).toBe(true);
    expect(runtimeHost.emit).toHaveBeenCalledWith(
      'updateBashApprovalBypassState',
      {
        streamId: 'goal-bypass-stream',
        bypassActive: true,
      },
    );

    await setGoalSessionBashAutoApproval(
      'goal-bypass-stream',
      false,
      runtimeHost,
    );
    expect(streams.get().get('goal-bypass-stream')?.bypass.bash).toBe(false);
    expect(runtimeHost.emit).toHaveBeenCalledWith(
      'updateBashApprovalBypassState',
      {
        streamId: 'goal-bypass-stream',
        bypassActive: false,
      },
    );
  });

  it('updates TUI edit bypass state at the approval decision site', async () => {
    const { runtimeHost, interactions } = tui();
    const result = interactions.requestToolEditApproval?.({
      path: '/work/main.tex',
      originalContent: 'old',
      proposedContent: 'new',
      sourceTool: 'edit',
      streamId: 'edit-bypass-stream',
    });

    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload).toMatchObject({
        kind: 'toolEdit',
        payload: { streamId: 'edit-bypass-stream' },
      });
    });
    currentApproval.get()?.decide({ accepted: true, bypass: 'toolEdit' });

    await expect(result).resolves.toEqual({
      accepted: true,
      appliedContent: 'new',
    });
    expect(streams.get().get('edit-bypass-stream')?.bypass.toolEdit).toBe(true);
    expect(runtimeHost.emit).toHaveBeenCalledWith(
      'updateToolEditApprovalBypassState',
      {
        streamId: 'edit-bypass-stream',
        bypassActive: true,
      },
    );
  });

  it('enables the complete delegated-task approval mode at the proposal decision site', async () => {
    const { runtimeHost, interactions } = tui();
    const result = interactions.requestAgentProposal?.({
      proposalId: 'proposal-bypass',
      streamId: 'proposal-bypass-stream',
      agent: 'critic',
      agentSource: null,
      model: 'kimi26T',
      instruction: 'Check the local compactness claim.',
      memories: [],
      workingDirectory: null,
      agentCategory: AgentCategory.ToolUse,
    });

    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload).toMatchObject({
        kind: 'proposal',
        payload: { streamId: 'proposal-bypass-stream' },
      });
    });
    currentApproval.get()?.decide({ accepted: true, bypass: 'superYolo' });

    await expect(result).resolves.toEqual({ action: 'approve' });
    expect(streams.get().get('proposal-bypass-stream')?.bypass.superYolo).toBe(
      true,
    );
    expect(streams.get().get('proposal-bypass-stream')?.bypass).toEqual({
      superYolo: true,
      toolEdit: true,
      bash: true,
    });
    expect(proposalApprovals().isBypassed('proposal-bypass-stream')).toBe(true);
    expect(isApprovalBypassedForStream('proposal-bypass-stream')).toBe(true);
    expect(isBashApprovalBypassedForStream('proposal-bypass-stream')).toBe(
      true,
    );
    expect(runtimeHost.emit).toHaveBeenCalledWith(
      'updateSuperYoloBypassState',
      { streamId: 'proposal-bypass-stream', bypassActive: true },
    );
    expect(runtimeHost.emit).toHaveBeenCalledWith(
      'updateToolEditApprovalBypassState',
      { streamId: 'proposal-bypass-stream', bypassActive: true },
    );
  });

  it('approves delegated work already queued in the same stream', async () => {
    const { interactions } = tui();
    const streamId = 'parallel-approval-stream';
    const proposal = interactions.requestAgentProposal?.({
      proposalId: 'proposal-current',
      streamId,
      agent: 'critic',
      agentSource: null,
      model: 'kimi26T',
      instruction: 'Check the local compactness claim.',
      memories: [],
      workingDirectory: null,
      agentCategory: AgentCategory.ToolUse,
    });
    const edit = interactions.requestToolEditApproval?.({
      path: '/work/main.tex',
      originalContent: 'old',
      proposedContent: 'new',
      sourceTool: 'edit',
      streamId,
    });
    const bash = interactions.requestBashApproval?.({
      command: 'lake build',
      streamId,
    });
    void enqueueApproval({
      kind: 'plan',
      payload: {
        approvalId: 'plan-excluded',
        streamId,
        goalEnabled: false,
        plan: { objective: 'Keep the approval categories distinct.' },
      },
    });
    void enqueueApproval({
      kind: 'retry',
      payload: {
        requestId: 'retry-excluded',
        streamId,
        operation: 'model request',
      },
    });
    void enqueueApproval({
      kind: 'externalInquiry',
      payload: {
        requestId: 'inquiry-excluded',
        allowBypass: false,
        streamId,
        mode: 'new',
        question: 'What external fact should be checked?',
        threadId: 'thread-excluded',
      },
    });
    void enqueueApproval({
      kind: 'userQuestion',
      payload: {
        requestId: 'question-excluded',
        allowBypass: false,
        streamId,
        questions: [
          {
            question: 'Continue?',
            options: [{ label: 'Yes' }, { label: 'No' }],
          },
        ],
      },
    });
    void enqueueApproval({
      kind: 'bash',
      payload: {
        requestId: 'other-stream-bash',
        allowBypass: true,
        streamId: 'other-approval-stream',
        command: 'lake test',
      },
    });

    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload).toMatchObject({
        kind: 'proposal',
        payload: { proposalId: 'proposal-current' },
      });
    });
    currentApproval.get()?.decide({ accepted: true, bypass: 'superYolo' });

    await expect(proposal).resolves.toEqual({ action: 'approve' });
    await expect(edit).resolves.toEqual({
      accepted: true,
      appliedContent: 'new',
    });
    await expect(bash).resolves.toEqual({
      accepted: true,
      userMessage: undefined,
    });
    expect(pendingApprovalSummaries.get()).toEqual([
      { streamKey: streamId, kind: 'plan' },
      { streamKey: streamId, kind: 'retry' },
      { streamKey: streamId, kind: 'externalInquiry' },
      { streamKey: streamId, kind: 'userQuestion' },
      { streamKey: 'other-approval-stream', kind: 'bash' },
    ]);
    expect(currentApproval.get()?.payload.kind).toBe('plan');
  });

  it('keeps an ordinary proposal approval limited to the current request', async () => {
    const { interactions } = tui();
    const streamId = 'proposal-one-off-stream';
    const result = interactions.requestAgentProposal?.({
      proposalId: 'proposal-one-off',
      streamId,
      agent: 'critic',
      agentSource: null,
      model: 'kimi26T',
      instruction: 'Check one calculation.',
      memories: [],
      workingDirectory: null,
      agentCategory: AgentCategory.ToolUse,
    });

    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload.kind).toBe('proposal');
    });
    currentApproval.get()?.decide({ accepted: true });

    await expect(result).resolves.toEqual({ action: 'approve' });
    expect(streams.get().get(streamId)?.bypass.superYolo ?? false).toBe(false);
    expect(streams.get().get(streamId)?.bypass.toolEdit ?? false).toBe(false);
    expect(streams.get().get(streamId)?.bypass.bash ?? false).toBe(false);
    expect(proposalApprovals().isBypassed(streamId)).toBe(false);
    expect(isApprovalBypassedForStream(streamId)).toBe(false);
    expect(isBashApprovalBypassedForStream(streamId)).toBe(false);
  });

  it('auto-switches provider-less relay retries when any personal key exists', async () => {
    const fallbackProvider =
      API_PROVIDERS.find((provider) => provider !== 'openai') ??
      API_PROVIDERS[0];
    mocks.lookupApiKey.mockImplementation(
      async (_secrets, provider: ApiProvider) =>
        provider === fallbackProvider ? 'sk-test' : undefined,
    );

    const { interactions } = tui();
    const result = interactions.requestRetry?.(relayRetry({ streamId: 's1' }));

    await vi.waitFor(() => {
      expect(mocks.setCliApiMode).toHaveBeenCalledWith('personal');
    });
    await expect(result).resolves.toEqual({
      action: 'retry',
      feedback: undefined,
    });
    expect(currentApproval.get()).toBeUndefined();
    expect(mocks.lookupApiKey.mock.calls.map((call) => call[1])).toContain(
      fallbackProvider,
    );
  });

  it('falls back to the retry modal when API key lookup fails', async () => {
    mocks.lookupApiKey.mockRejectedValue(new Error('keychain unavailable'));

    const { interactions } = tui();
    const retry = relayRetry({ streamId: 's2', provider: 'openai' });
    void interactions.requestRetry?.(retry);

    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload).toMatchObject({
        kind: 'retry',
        payload: { streamId: 's2' },
      });
    });
  });

  it('does not auto-switch when a retry provider is not an API provider', async () => {
    mocks.lookupApiKey.mockResolvedValue('sk-test');

    const { interactions } = tui();
    const retry = relayRetry({
      streamId: 'unknown-provider',
      provider: 'custom-provider',
    });
    void interactions.requestRetry?.(retry);

    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload).toMatchObject({
        kind: 'retry',
        payload: { streamId: 'unknown-provider' },
      });
    });
    expect(mocks.lookupApiKey).not.toHaveBeenCalled();
  });

  it('auto-switches relay retries detected by monthly-limit message fallback', async () => {
    mocks.lookupApiKey.mockImplementation(
      async (_secrets, provider: ApiProvider) =>
        provider === 'openai' ? 'sk-openai' : undefined,
    );

    const { interactions } = tui();
    const result = interactions.requestRetry?.({
      streamId: 'message-fallback',
      operation: 'model request',
      errorMessage: 'Monthly spending limit reached.',
      errorDetails: {
        message: 'Monthly spending limit reached.',
        exhaustionReason: 'relay-limit',
        isRelayError: false,
        provider: 'openai',
      },
    } as RuntimeInteractionEventPayloads['showRetryRequest']);

    await vi.waitFor(() => {
      expect(mocks.setCliApiMode).toHaveBeenCalledWith('personal');
    });
    await expect(result).resolves.toEqual({
      action: 'retry',
      feedback: undefined,
    });
    expect(currentApproval.get()).toBeUndefined();
  });

  it('requires an explicit decision before switching a ChatGPT subscription retry to an API key', async () => {
    mocks.lookupApiKey.mockImplementation(
      async (_secrets, provider: ApiProvider) =>
        provider === 'openai' ? 'sk-openai' : undefined,
    );

    const { interactions } = tui();
    const result = interactions.requestRetry?.(chatGptSubscriptionRetry('s3'));

    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload).toMatchObject({
        kind: 'retry',
        payload: {
          streamId: 's3',
          errorMessage: 'ChatGPT subscription usage limit reached.',
        },
      });
    });
    expect(mocks.lookupApiKey).not.toHaveBeenCalled();
    expect(mocks.setCliApiMode).not.toHaveBeenCalled();
    expect(mocks.setCliCodexSubscription).not.toHaveBeenCalled();

    currentApproval.get()?.decide({
      accepted: true,
      apiMode: 'personal',
      disableChatGptSubscription: true,
    });

    await expect(result).resolves.toEqual({
      action: 'retry',
      feedback: undefined,
    });
    expect(mocks.setCliApiMode).toHaveBeenCalledWith('personal');
    expect(mocks.setCliCodexSubscription).toHaveBeenCalledWith(false);
    expect(currentApproval.get()).toBeUndefined();
  });

  it('retries ChatGPT subscription access without changing credentials when the ordinary retry action is chosen', async () => {
    const { interactions } = tui();
    const result = interactions.requestRetry?.(
      chatGptSubscriptionRetry('subscription-retry'),
    );

    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload).toMatchObject({
        kind: 'retry',
        payload: { streamId: 'subscription-retry' },
      });
    });
    currentApproval.get()?.decide({ accepted: true });

    await expect(result).resolves.toEqual({
      action: 'retry',
      feedback: undefined,
    });
    expect(mocks.lookupApiKey).not.toHaveBeenCalled();
    expect(mocks.setCliApiMode).not.toHaveBeenCalled();
    expect(mocks.setCliCodexSubscription).not.toHaveBeenCalled();
  });

  it('invalidates pre-queue retry lookups when approvals are cleared', async () => {
    let resolveLookup: ((value: string | undefined) => void) | undefined;
    mocks.lookupApiKey.mockImplementation(
      () =>
        new Promise<string | undefined>((resolve) => {
          resolveLookup = resolve;
        }),
    );

    const { interactions } = tui();
    const result = interactions.requestRetry?.(
      relayRetry({ streamId: 'interrupted', provider: 'openai' }),
    );
    clearApprovals();
    await expect(result).resolves.toEqual({ action: 'cancel' });

    resolveLookup?.('sk-after-interrupt');
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.setCliApiMode).not.toHaveBeenCalled();
    expect(currentApproval.get()).toBeUndefined();
  });

  it('invalidates pre-queue retry lookups when approvals are unbound', async () => {
    let resolveLookup: ((value: string | undefined) => void) | undefined;
    mocks.lookupApiKey.mockImplementation(
      () =>
        new Promise<string | undefined>((resolve) => {
          resolveLookup = resolve;
        }),
    );

    const { interactions, dispose } = tui();
    const result = interactions.requestRetry?.(
      relayRetry({ streamId: 'unbound', provider: 'openai' }),
    );
    dispose();
    await expect(result).resolves.toEqual({ action: 'cancel' });

    resolveLookup?.('sk-after-unbind');
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.setCliApiMode).not.toHaveBeenCalled();
    expect(currentApproval.get()).toBeUndefined();
  });

  it('cancels an active retry modal when approvals are cleared', async () => {
    mocks.lookupApiKey.mockResolvedValue(undefined);

    const { interactions } = tui();
    const result = interactions.requestRetry?.(
      relayRetry({ streamId: 'modal-interrupt', provider: 'openai' }),
    );

    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload).toMatchObject({
        kind: 'retry',
        payload: { streamId: 'modal-interrupt' },
      });
    });

    clearApprovals();
    await expect(result).resolves.toEqual({ action: 'cancel' });
    expect(currentApproval.get()).toBeUndefined();
  });

  it('times out an active plan approval modal', async () => {
    const { cliContext, interactions } = tui();
    const result = interactions.requestPlanApproval?.(
      {
        approvalId: 'plan-timeout',
        streamId: 'plan-stream',
        goalEnabled: false,
        plan: { objective: 'Check the timeout path.' },
      },
      { timeoutMs: 10 },
    );

    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload).toMatchObject({
        kind: 'plan',
        payload: { approvalId: 'plan-timeout' },
      });
    });
    await expect(result).resolves.toEqual({ action: 'timeout' });
    expect(hasCliApprovalDenied(cliContext)).toBe(false);
  });

  it('times out an active retry modal', async () => {
    mocks.lookupApiKey.mockResolvedValue(undefined);

    const { cliContext, interactions } = tui();
    const result = interactions.requestRetry?.(
      relayRetry({ streamId: 'retry-timeout', provider: 'openai' }),
      { timeoutMs: 100 },
    );

    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload).toMatchObject({
        kind: 'retry',
        payload: { streamId: 'retry-timeout' },
      });
    });
    await expect(result).resolves.toEqual({ action: 'timeout' });
    expect(hasCliApprovalDenied(cliContext)).toBe(false);
  });

  it('times out while a retry is still waiting on the keychain', async () => {
    mocks.lookupApiKey.mockImplementation(() => new Promise(() => undefined));

    const { cliContext, interactions } = tui();
    const result = interactions.requestRetry?.(
      relayRetry({ streamId: 'lookup-timeout', provider: 'openai' }),
      { timeoutMs: 10 },
    );

    await expect(result).resolves.toEqual({ action: 'timeout' });
    expect(currentApproval.get()).toBeUndefined();
    expect(hasCliApprovalDenied(cliContext)).toBe(false);
  });

  it('ignores stale auto-switch lookups after a newer retry replaces them', async () => {
    let resolveFirstLookup: ((value: string | undefined) => void) | undefined;
    mocks.lookupApiKey
      .mockImplementationOnce(
        () =>
          new Promise<string | undefined>((resolve) => {
            resolveFirstLookup = resolve;
          }),
      )
      .mockResolvedValueOnce(undefined);

    const { interactions } = tui();
    void interactions.requestRetry?.(
      relayRetry({
        streamId: 'same-stream',
        provider: 'openai',
        message: 'first retry',
      }),
    );
    void interactions.requestRetry?.(
      relayRetry({
        streamId: 'same-stream',
        provider: 'openai',
        message: 'second retry',
      }),
    );

    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload).toMatchObject({
        kind: 'retry',
        payload: { errorMessage: 'second retry' },
      });
    });

    resolveFirstLookup?.('sk-stale');
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.setCliApiMode).not.toHaveBeenCalled();
  });

  it('clears an older retry modal when a newer retry auto-switches', async () => {
    mocks.lookupApiKey
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce('sk-new');

    const { interactions } = tui();
    void interactions.requestRetry?.(
      relayRetry({
        streamId: 'same-stream',
        provider: 'openai',
        message: 'first retry',
      }),
    );
    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload).toMatchObject({
        kind: 'retry',
        payload: { errorMessage: 'first retry' },
      });
    });

    const second = interactions.requestRetry?.(
      relayRetry({
        streamId: 'same-stream',
        provider: 'openai',
        message: 'second retry',
      }),
    );

    await vi.waitFor(() => {
      expect(currentApproval.get()).toBeUndefined();
    });
    await expect(second).resolves.toEqual({
      action: 'retry',
      feedback: undefined,
    });
  });

  it('replaces an older retry modal when a newer retry also needs input', async () => {
    mocks.lookupApiKey.mockResolvedValue(undefined);

    const { interactions } = tui();
    void interactions.requestRetry?.(
      relayRetry({
        streamId: 'same-stream',
        provider: 'openai',
        message: 'first retry',
      }),
    );
    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload).toMatchObject({
        kind: 'retry',
        payload: { errorMessage: 'first retry' },
      });
    });

    void interactions.requestRetry?.(
      relayRetry({
        streamId: 'same-stream',
        provider: 'openai',
        message: 'second retry',
      }),
    );

    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload).toMatchObject({
        kind: 'retry',
        payload: { errorMessage: 'second retry' },
      });
    });
  });

  it('does not let a stale auto-switch failure cancel a newer retry', async () => {
    let rejectFirstModeSwitch: ((error: Error) => void) | undefined;
    mocks.lookupApiKey.mockResolvedValue('sk-test');
    mocks.setCliApiMode
      .mockImplementationOnce(
        () =>
          new Promise<undefined>((_resolve, reject) => {
            rejectFirstModeSwitch = reject;
          }),
      )
      .mockResolvedValueOnce(undefined);

    const { interactions } = tui();
    void interactions.requestRetry?.(
      relayRetry({
        streamId: 'same-stream',
        provider: 'openai',
        message: 'first retry',
      }),
    );
    await vi.waitFor(() => {
      expect(mocks.setCliApiMode).toHaveBeenCalledTimes(1);
    });

    const second = interactions.requestRetry?.(
      relayRetry({
        streamId: 'same-stream',
        provider: 'openai',
        message: 'second retry',
      }),
    );
    await vi.waitFor(() => {
      expect(mocks.setCliApiMode).toHaveBeenCalledTimes(2);
    });
    await expect(second).resolves.toEqual({
      action: 'retry',
      feedback: undefined,
    });

    rejectFirstModeSwitch?.(new Error('stale mode switch failed'));
    await Promise.resolve();
    await Promise.resolve();
  });
});
