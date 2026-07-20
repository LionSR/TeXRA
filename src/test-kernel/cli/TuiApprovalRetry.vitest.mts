// Test composition imports
import '@test/support/defaultSessionTestSetup';

import pDefer from 'p-defer';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
  apiKeyExistsUncached: vi.fn(),
  apiMode: 'included' as 'included' | 'personal',
  hasUsableApiKey: vi.fn(),
  invalidateApiKeyCache: vi.fn(),
  preferSubscription: true,
  notify: vi.fn(),
  secrets: {},
  setCliApiMode: vi.fn(),
  setCliCodexSubscription: vi.fn(),
}));

vi.mock('@auth/codex', async (importActual) => {
  const actual = await importActual<typeof import('@auth/codex')>();
  return {
    ...actual,
    isPreferCodexSubscription: () => mocks.preferSubscription,
  };
});

vi.mock('@cli/chat/tui/notifications/terminalNotifier', () => ({
  notify: mocks.notify,
}));

vi.mock('@cli/runtime/apiAccessMode', async (importActual) => {
  const actual =
    await importActual<typeof import('@cli/runtime/apiAccessMode')>();
  return {
    ...actual,
    getCliApiMode: () => mocks.apiMode,
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
    apiKeyExistsUncached: mocks.apiKeyExistsUncached,
    hasUsableApiKey: mocks.hasUsableApiKey,
    invalidateApiKeyCache: mocks.invalidateApiKeyCache,
  };
});

vi.mock('@platform/platform', () => ({
  platform: () => ({ secrets: mocks.secrets }),
}));

import type {
  HostInteractions,
  HostRetryInteractionOptions,
} from '@agent/runtime/HostInteractions';
import { defaultSession } from '@agent/runtime/SessionHandle';
import type { RuntimeInteractionEventPayloads } from '@agent/runtime/runtimeInteractionEvents';
import {
  clearApprovals,
  currentApproval,
  enqueueApproval,
  pendingApprovalSummaries,
  type ApprovalDecision,
} from '@cli/chat/tui/state/approvalQueue';
import {
  patchSessionMeta,
  resetCliState,
  sessionMeta,
  streams,
} from '@cli/chat/tui/state/cliState';
import { createTuiHostInteractions } from '@cli/chat/tui/state/subscribeApprovals';
import { hasCliApprovalDenied } from '@cli/runtime/approvalAdapter';
import type { CliContext } from '@cli/runtime/cliContext';
import type { CliRuntimeHost } from '@cli/runtime/runtimeHost';
import type { ApiProvider } from '@model/apiProviders';
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
  readonly prepareRetry: ReturnType<typeof vi.fn>;
  readonly dispose: () => void;
} {
  const cliContext = context();
  const hostInteractions = createTuiHostInteractions(runtimeHost, cliContext);
  const prepareRetry = vi.fn(async () => undefined);
  const interactions: HostInteractions = {
    ...hostInteractions,
    requestRetry: (request, options) =>
      hostInteractions.requestRetry?.(request, {
        prepareRetry,
        ...options,
      }),
  };
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
    prepareRetry,
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

function decideRetry(decision: ApprovalDecision): void {
  const pending = currentApproval.get();
  expect(pending?.payload.kind).toBe('retry');
  pending?.decide(decision);
}

function expectNoCredentialChange(
  prepareRetry: ReturnType<typeof vi.fn>,
): void {
  expect(mocks.invalidateApiKeyCache).not.toHaveBeenCalled();
  expect(mocks.setCliApiMode).not.toHaveBeenCalled();
  expect(mocks.setCliCodexSubscription).not.toHaveBeenCalled();
  expect(prepareRetry).not.toHaveBeenCalled();
}

const PERSONAL_KEY_RETRY: ApprovalDecision = {
  accepted: true,
  apiMode: 'personal',
  disableChatGptSubscription: true,
};

async function waitForRetryApproval(
  payload: Record<string, unknown>,
): Promise<void> {
  await vi.waitFor(() => {
    expect(currentApproval.get()?.payload).toMatchObject({
      kind: 'retry',
      payload,
    });
  });
}

async function beginSubscriptionSwitch(
  interactions: HostInteractions,
  streamId: string,
  options?: HostRetryInteractionOptions,
): Promise<{
  readonly result: ReturnType<NonNullable<HostInteractions['requestRetry']>>;
}> {
  const result = interactions.requestRetry?.(
    chatGptSubscriptionRetry(streamId),
    options,
  );
  await waitForRetryApproval({ streamId });
  decideRetry(PERSONAL_KEY_RETRY);
  return { result };
}

beforeEach(() => {
  mocks.apiMode = 'included';
  patchSessionMeta({ apiMode: 'included' });
  mocks.preferSubscription = true;
  mocks.apiKeyExistsUncached.mockResolvedValue(true);
  mocks.hasUsableApiKey.mockResolvedValue(false);
  mocks.setCliApiMode.mockImplementation(async (mode) => {
    mocks.apiMode = mode;
  });
  mocks.setCliCodexSubscription.mockImplementation(async (enabled) => {
    mocks.preferSubscription = enabled;
    return { effective: enabled, target: 'global' };
  });
});

afterEach(() => {
  clearApprovals();
  cleanupAllApprovals();
  resetCliState();
  mocks.apiKeyExistsUncached.mockReset();
  mocks.hasUsableApiKey.mockReset();
  mocks.invalidateApiKeyCache.mockReset();
  mocks.notify.mockReset();
  mocks.setCliApiMode.mockReset();
  mocks.setCliCodexSubscription.mockReset();
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

  it('fails closed when a relay retry does not identify its provider', async () => {
    mocks.hasUsableApiKey.mockResolvedValue(true);
    const { interactions, prepareRetry } = tui();
    const result = interactions.requestRetry?.(relayRetry({ streamId: 's1' }));

    await waitForRetryApproval({
      personalApiKeyAvailable: false,
      missingPersonalApiKeyMessage: expect.stringContaining(
        'provider could not be identified',
      ),
    });
    decideRetry({ accepted: false });

    await expect(result).resolves.toEqual({ action: 'cancel' });
    expect(mocks.hasUsableApiKey).not.toHaveBeenCalled();
    expectNoCredentialChange(prepareRetry);
  });

  it('falls back to the retry modal when API key lookup fails', async () => {
    mocks.hasUsableApiKey.mockRejectedValue(new Error('keychain unavailable'));

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
    mocks.hasUsableApiKey.mockResolvedValue(true);

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
    expect(mocks.hasUsableApiKey).not.toHaveBeenCalled();
  });

  it('auto-switches relay retries detected by monthly-limit message fallback', async () => {
    mocks.hasUsableApiKey.mockImplementation(
      async (_secrets, provider: ApiProvider) => provider === 'openai',
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
    mocks.hasUsableApiKey.mockImplementation(
      async (_secrets, provider: ApiProvider) => provider === 'openai',
    );

    const { interactions, prepareRetry } = tui();
    const result = interactions.requestRetry?.(chatGptSubscriptionRetry('s3'));

    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload).toMatchObject({
        kind: 'retry',
        payload: {
          streamId: 's3',
          errorMessage: 'ChatGPT subscription usage limit reached.',
          personalApiKeyAvailable: true,
        },
      });
    });
    expect(mocks.hasUsableApiKey).toHaveBeenCalledTimes(1);
    expect(mocks.setCliApiMode).not.toHaveBeenCalled();
    expect(mocks.setCliCodexSubscription).not.toHaveBeenCalled();

    decideRetry(PERSONAL_KEY_RETRY);

    await expect(result).resolves.toEqual({
      action: 'retry',
      feedback: undefined,
    });
    expect(mocks.setCliApiMode).toHaveBeenCalledWith('personal');
    expect(mocks.setCliCodexSubscription).toHaveBeenCalledWith(false);
    expect(mocks.hasUsableApiKey).toHaveBeenCalledTimes(1);
    expect(mocks.apiKeyExistsUncached).toHaveBeenCalledWith(
      mocks.secrets,
      'openai',
    );
    expect(mocks.apiKeyExistsUncached).toHaveBeenCalledTimes(2);
    expect(mocks.invalidateApiKeyCache).toHaveBeenCalledTimes(2);
    expect(prepareRetry).toHaveBeenCalledOnce();
    expect(currentApproval.get()).toBeUndefined();
  });

  it('does not offer or apply the subscription switch without an OpenAI API key', async () => {
    mocks.hasUsableApiKey.mockResolvedValue(false);

    const { interactions, prepareRetry } = tui();
    const result = interactions.requestRetry?.(
      chatGptSubscriptionRetry('missing-openai-key'),
    );

    await waitForRetryApproval({
      streamId: 'missing-openai-key',
      personalApiKeyAvailable: false,
    });
    decideRetry({ accepted: false });

    await expect(result).resolves.toEqual({ action: 'cancel' });
    expectNoCredentialChange(prepareRetry);
  });

  it('does not mutate state when cancellation arrives during uncached validation', async () => {
    mocks.hasUsableApiKey.mockResolvedValue(true);
    const validation = pDefer<boolean>();
    mocks.apiKeyExistsUncached.mockReturnValueOnce(validation.promise);

    const { interactions, prepareRetry } = tui();
    const { result } = await beginSubscriptionSwitch(
      interactions,
      'cancel-during-validation',
    );
    await vi.waitFor(() =>
      expect(mocks.apiKeyExistsUncached).toHaveBeenCalledOnce(),
    );

    interactions.cancel({
      streamId: 'cancel-during-validation',
      kind: 'retry',
    });
    await expect(result).resolves.toEqual({ action: 'cancel' });
    validation.resolve(true);
    await Promise.resolve();
    await Promise.resolve();

    expectNoCredentialChange(prepareRetry);
  });

  it('rolls back both preferences when the personal-key client cannot be prepared', async () => {
    mocks.hasUsableApiKey.mockResolvedValue(true);
    const prepareRetry = vi.fn(async () => {
      throw new Error('OpenAI client construction failed');
    });

    const { interactions } = tui();
    const { result } = await beginSubscriptionSwitch(
      interactions,
      'client-refresh-failure',
      { prepareRetry },
    );

    await expect(result).resolves.toEqual({
      action: 'deny',
      reason: 'OpenAI client construction failed',
    });
    expect(mocks.setCliApiMode.mock.calls.map(([mode]) => mode)).toEqual([
      'personal',
      'included',
    ]);
    expect(
      mocks.setCliCodexSubscription.mock.calls.map(([enabled]) => enabled),
    ).toEqual([false, true]);
    expect(mocks.apiMode).toBe('included');
    expect(mocks.preferSubscription).toBe(true);
    expect(prepareRetry).toHaveBeenCalledOnce();
  });

  it('reports any preference that cannot be restored after preparation fails', async () => {
    mocks.hasUsableApiKey.mockResolvedValue(true);
    mocks.setCliCodexSubscription
      .mockImplementationOnce(async (enabled: boolean) => {
        mocks.preferSubscription = enabled;
        return { effective: enabled, target: 'global' };
      })
      .mockRejectedValueOnce(new Error('settings storage unavailable'));
    const prepareRetry = vi.fn(async () => {
      throw new Error('OpenAI client construction failed');
    });

    const { interactions } = tui();
    const { result } = await beginSubscriptionSwitch(
      interactions,
      'rollback-failure',
      { prepareRetry },
    );

    await expect(result).resolves.toEqual({
      action: 'deny',
      reason: expect.stringContaining(
        'Previous access settings could not be fully restored: Could not restore the ChatGPT subscription preference: settings storage unavailable',
      ),
    });
    expect(mocks.apiMode).toBe('included');
    expect(mocks.preferSubscription).toBe(false);
  });

  it('reports unconfirmed persistence when rollback restores memory before rejecting', async () => {
    mocks.hasUsableApiKey.mockResolvedValue(true);
    mocks.setCliApiMode
      .mockImplementationOnce(async (mode) => {
        mocks.apiMode = mode;
      })
      .mockImplementationOnce(async (mode) => {
        mocks.apiMode = mode;
        throw new Error('API mode storage unavailable');
      });
    const prepareRetry = vi.fn(async () => {
      throw new Error('OpenAI client construction failed');
    });

    const { interactions } = tui();
    const { result } = await beginSubscriptionSwitch(
      interactions,
      'rollback-persistence-failure',
      { prepareRetry },
    );

    await expect(result).resolves.toEqual({
      action: 'deny',
      reason: expect.stringContaining(
        'Previous access settings could not be fully restored: The previous API mode appears restored in memory, but persistence could not be confirmed: API mode storage unavailable',
      ),
    });
    expect(mocks.apiMode).toBe('included');
    expect(mocks.preferSubscription).toBe(true);
    expect(prepareRetry).toHaveBeenCalledOnce();
  });

  it('keeps settings and the prepared client together when a replacement arrives at the commit point', async () => {
    mocks.hasUsableApiKey.mockResolvedValue(true);
    const preparation = pDefer<void>();
    const prepareRetry = vi.fn(() => preparation.promise);

    const { interactions } = tui();
    const { result: first } = await beginSubscriptionSwitch(
      interactions,
      'commit-race',
      { prepareRetry },
    );
    await vi.waitFor(() => expect(prepareRetry).toHaveBeenCalledOnce());
    expect(sessionMeta.get().apiMode).toBe('included');

    void interactions.requestRetry?.(chatGptSubscriptionRetry('commit-race'));
    await expect(first).resolves.toEqual({ action: 'cancel' });
    preparation.resolve();
    await preparation.promise;
    await vi.waitFor(() => expect(sessionMeta.get().apiMode).toBe('personal'));

    expect(mocks.apiMode).toBe('personal');
    expect(mocks.preferSubscription).toBe(false);
    expect(mocks.setCliApiMode).toHaveBeenCalledTimes(1);
    expect(mocks.setCliCodexSubscription).toHaveBeenCalledTimes(1);
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
    decideRetry({ accepted: true });

    await expect(result).resolves.toEqual({
      action: 'retry',
      feedback: undefined,
    });
    expect(mocks.hasUsableApiKey).toHaveBeenCalledOnce();
    expect(mocks.setCliApiMode).not.toHaveBeenCalled();
    expect(mocks.setCliCodexSubscription).not.toHaveBeenCalled();
  });

  it('does not queue an ordinary retry behind slow client preparation', async () => {
    mocks.hasUsableApiKey.mockResolvedValue(true);
    const preparation = pDefer<void>();
    const prepareRetry = vi.fn(() => preparation.promise);
    const { interactions } = tui();
    const { result: switching } = await beginSubscriptionSwitch(
      interactions,
      'slow-switch',
      { prepareRetry },
    );
    await vi.waitFor(() => expect(prepareRetry).toHaveBeenCalledOnce());

    const ordinary = interactions.requestRetry?.({
      requestId: 'ordinary-retry',
      streamId: 'ordinary-stream',
      operation: 'model request',
      errorMessage: 'Temporary connection error.',
    });
    await waitForRetryApproval({ streamId: 'ordinary-stream' });
    decideRetry({ accepted: true });

    await expect(ordinary).resolves.toEqual({
      action: 'retry',
      feedback: undefined,
    });
    preparation.resolve();
    await expect(switching).resolves.toEqual({
      action: 'retry',
      feedback: undefined,
    });
  });

  it('invalidates pre-queue retry lookups when approvals are cleared', async () => {
    let resolveLookup: ((value: boolean) => void) | undefined;
    mocks.hasUsableApiKey.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveLookup = resolve;
        }),
    );

    const { interactions } = tui();
    const result = interactions.requestRetry?.(
      relayRetry({ streamId: 'interrupted', provider: 'openai' }),
    );
    clearApprovals();
    await expect(result).resolves.toEqual({ action: 'cancel' });

    resolveLookup?.(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.setCliApiMode).not.toHaveBeenCalled();
    expect(currentApproval.get()).toBeUndefined();
  });

  it('invalidates pre-queue retry lookups when approvals are unbound', async () => {
    let resolveLookup: ((value: boolean) => void) | undefined;
    mocks.hasUsableApiKey.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveLookup = resolve;
        }),
    );

    const { interactions, dispose } = tui();
    const result = interactions.requestRetry?.(
      relayRetry({ streamId: 'unbound', provider: 'openai' }),
    );
    dispose();
    await expect(result).resolves.toEqual({ action: 'cancel' });

    resolveLookup?.(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.setCliApiMode).not.toHaveBeenCalled();
    expect(currentApproval.get()).toBeUndefined();
  });

  it('cancels an active retry modal when approvals are cleared', async () => {
    mocks.hasUsableApiKey.mockResolvedValue(false);

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
    mocks.hasUsableApiKey.mockResolvedValue(false);

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
    mocks.hasUsableApiKey.mockImplementation(
      () => new Promise(() => undefined),
    );

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
    let resolveFirstLookup: ((value: boolean) => void) | undefined;
    mocks.hasUsableApiKey
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveFirstLookup = resolve;
          }),
      )
      .mockResolvedValueOnce(false);

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

    resolveFirstLookup?.(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.setCliApiMode).not.toHaveBeenCalled();
  });

  it('clears an older retry modal when a newer retry auto-switches', async () => {
    mocks.hasUsableApiKey
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

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
    mocks.hasUsableApiKey.mockResolvedValue(false);

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

  it('serializes a newer switch behind stale-switch rollback', async () => {
    const firstModeSwitch = pDefer<undefined>();
    mocks.hasUsableApiKey.mockResolvedValue(true);
    mocks.setCliApiMode
      .mockImplementationOnce(() => firstModeSwitch.promise)
      .mockResolvedValueOnce(undefined);

    const { interactions, prepareRetry } = tui();
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
    await Promise.resolve();
    expect(mocks.setCliApiMode).toHaveBeenCalledTimes(1);

    firstModeSwitch.reject(new Error('stale mode switch failed'));
    await expect(second).resolves.toEqual({
      action: 'retry',
      feedback: undefined,
    });
    expect(mocks.setCliApiMode.mock.calls.map(([mode]) => mode)).toEqual([
      'personal',
      'included',
      'personal',
    ]);
    expect(mocks.apiMode).toBe('personal');
    expect(prepareRetry).toHaveBeenCalledOnce();
  });
});
