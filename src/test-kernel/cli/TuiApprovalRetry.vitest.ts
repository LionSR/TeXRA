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
  preferKimiCode: false,
  glmCodingPlan: false,
  notify: vi.fn(),
  openRouter: false,
  retryCopyFailure: undefined as Error | undefined,
  secrets: {},
  setCliApiMode: vi.fn(),
  setCliCodexSubscription: vi.fn(),
  setCliCodingPlanSubscription: vi.fn(),
  refreshSubscriptionPreferenceViews: vi.fn(),
  setPreferKimiCode: vi.fn(),
  setGLMCodingPlan: vi.fn(),
  updateGlobalState: vi.fn(),
}));

// Injection point for a pre-modal preparation failure: the retry copy is read
// while the request is still being assembled, before the modal can be shown.
vi.mock('@cli/tui/ui/retryCopy', async (importActual) => {
  const actual = await importActual<typeof import('@cli/tui/ui/retryCopy')>();
  return {
    ...actual,
    missingApiKeyRetryMessage: (
      ...args: Parameters<typeof actual.missingApiKeyRetryMessage>
    ): string => {
      if (mocks.retryCopyFailure) throw mocks.retryCopyFailure;
      return actual.missingApiKeyRetryMessage(...args);
    },
  };
});

vi.mock('@model/codex/codexPreference', () => ({
  isPreferCodexSubscription: () => mocks.preferSubscription,
}));

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
  refreshSubscriptionPreferenceViews: mocks.refreshSubscriptionPreferenceViews,
  setCliCodexSubscription: mocks.setCliCodexSubscription,
  setCliCodingPlanSubscription: mocks.setCliCodingPlanSubscription,
}));

vi.mock('@utils/config/providerConfig', async (importActual) => {
  const actual =
    await importActual<typeof import('@utils/config/providerConfig')>();
  return {
    ...actual,
    getPreferKimiCode: () => mocks.preferKimiCode,
    setPreferKimiCode: mocks.setPreferKimiCode,
    getGLMCodingPlan: () => mocks.glmCodingPlan,
    setGLMCodingPlan: mocks.setGLMCodingPlan,
  };
});

vi.mock('@model/apiProviders', async (importActual) => {
  const actual = await importActual<typeof import('@model/apiProviders')>();
  return {
    ...actual,
    apiKeyExistsUncached: mocks.apiKeyExistsUncached,
    hasUsableApiKey: mocks.hasUsableApiKey,
    invalidateApiKeyCache: mocks.invalidateApiKeyCache,
  };
});

vi.mock('@platform/platform', async () => {
  const { GlobalStateKey } = await import('@shared/state/stateKeys');
  return {
    platform: () => ({
      secrets: mocks.secrets,
      globalState: {
        get: (key: string, fallback: unknown) =>
          key === GlobalStateKey.USE_OPENROUTER ? mocks.openRouter : fallback,
        update: mocks.updateGlobalState,
      },
    }),
  };
});

import type {
  HostInteractions,
  HostRetryInteractionOptions,
} from '@agent/runtime/HostInteractions';
import { defaultSession } from '@agent/runtime/SessionHandle';
import {
  approvalQueueStatus,
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
import type { CliContext } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { runOutcomeExitCode } from '@cli/runtime/terminalStatus';
import type { CliRuntimeHost } from '@cli/runtime/cliPresentationHost';
import type { ApiProvider } from '@model/apiProviders';
import {
  AgentCategory,
  RUN_OUTCOME,
  type RetryPermission,
} from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { setGoalSessionBashAutoApproval } from '@tools/goal';
import {
  cleanupAllApprovals,
  isApprovalBypassedForStream,
  isBashApprovalBypassedForStream,
  proposalApprovals,
} from '@tools/approval';

function context(overrides: Partial<CliContext> = {}): CliContext {
  return createTestCliContext({
    cwd: '/work',
    mode: 'interactive',
    approvalPolicy: 'ask',
    version: 'test',
    resourcesPath: '/resources',
    ...overrides,
  });
}

function host(): CliRuntimeHost {
  return {
    emit: vi.fn(),
    emitApprovalBypassState: vi.fn(),
    close: vi.fn(async () => undefined),
  } as unknown as CliRuntimeHost;
}

function tui(
  presentationHost = host(),
  contextOverrides: Partial<CliContext> = {},
): {
  readonly presentationHost: CliRuntimeHost;
  readonly cliContext: CliContext;
  readonly interactions: HostInteractions;
  readonly prepareRetry: ReturnType<typeof vi.fn>;
  readonly dispose: () => void;
} {
  const cliContext = context(contextOverrides);
  defaultSession().setApprovalPolicy(cliContext.approvalPolicy);
  const hostInteractions = createTuiHostInteractions(
    presentationHost,
    cliContext,
  );
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
  onTestFinished(detachInteractions);
  return {
    presentationHost,
    cliContext,
    interactions,
    prepareRetry,
    dispose: detachInteractions,
  };
}

function relayRetry(params: {
  streamId: string;
  provider?: string;
  message?: string;
}): RetryPermission {
  const message = params.message ?? 'Relay monthly limit reached.';
  return {
    streamId: params.streamId,
    operation: 'model request',
    errorMessage: message,
    errorDetails: {
      message,
      exhaustionReason: 'relay-limit',
      isRelayError: true,
      ...(params.provider ? { provider: params.provider } : {}),
    },
  } as RetryPermission;
}

/** Relay retry on the shared `same-stream` stream the replacement cases below
 *  queue two requests against. */
function requestSameStreamRetry(
  interactions: HostInteractions,
  message: string,
): ReturnType<NonNullable<HostInteractions['requestRetry']>> {
  return interactions.requestRetry?.(
    relayRetry({ streamId: 'same-stream', provider: 'openai', message }),
  );
}

/** Transient retry with no relay or subscription exhaustion behind it. */
function ordinaryRetry(
  streamId: string,
  requestId: string = streamId,
): RetryPermission {
  return {
    requestId,
    streamId,
    operation: 'model request',
    errorMessage: 'Temporary connection error.',
  };
}

function chatGptSubscriptionRetry(streamId: string): RetryPermission {
  const message = 'ChatGPT subscription usage limit reached.';
  return {
    streamId,
    operation: 'model request',
    errorMessage: message,
    errorDetails: {
      message,
      exhaustionReason: 'chatgpt-subscription',
      provider: 'openai',
    },
  } as RetryPermission;
}

function kimiCodeSubscriptionRetry(streamId: string): RetryPermission {
  const message = 'Kimi Code subscription usage limit reached.';
  return {
    streamId,
    operation: 'model request',
    errorMessage: message,
    errorDetails: {
      message,
      exhaustionReason: 'kimi-code-subscription',
      provider: 'moonshot',
    },
  } as RetryPermission;
}

function decideRetry(decision: ApprovalDecision): void {
  const pending = currentApproval.get();
  expect(pending?.payload.kind).toBe('retry');
  pending?.decide(decision);
}

/** The pre-switch route: included API access with the ChatGPT subscription. */
function expectIncludedSubscriptionRoute(): void {
  expect(mocks.apiMode).toBe('included');
  expect(mocks.preferSubscription).toBe(true);
}

function expectNoPreferenceWrites(): void {
  expect(mocks.setCliApiMode).not.toHaveBeenCalled();
  expect(mocks.setCliCodexSubscription).not.toHaveBeenCalled();
}

function expectNoCredentialChange(
  prepareRetry: ReturnType<typeof vi.fn>,
): void {
  expect(mocks.invalidateApiKeyCache).not.toHaveBeenCalled();
  expectNoPreferenceWrites();
  expect(prepareRetry).not.toHaveBeenCalled();
}

/** A promise that never settles; call sites document why that is safe. */
function neverSettles(): Promise<void> {
  return new Promise<void>(() => {});
}

/** Two microtask ticks: one for the abort-aware wrapper around an in-flight
 *  lookup or preparation, one for the retry continuation behind it. */
async function settleRetryContinuation(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const PERSONAL_KEY_RETRY: ApprovalDecision = {
  accepted: true,
  apiMode: 'personal',
  disableChatGptSubscription: true,
};

async function waitForApproval(
  kind: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await vi.waitFor(() => {
    expect(currentApproval.get()?.payload).toMatchObject({ kind, payload });
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
  await waitForApproval('retry', { streamId });
  decideRetry(PERSONAL_KEY_RETRY);
  return { result };
}

/** Approves an ordinary retry while a credential switch is pending, asserting
 *  its client is still prepared on the old route. */
async function approveOrdinaryRetryOnOldRoute(
  interactions: HostInteractions,
  streamId: string,
): Promise<void> {
  const ordinaryPrepare = vi.fn(async () => {
    expectIncludedSubscriptionRoute();
  });
  const ordinary = interactions.requestRetry?.(ordinaryRetry(streamId), {
    prepareRetry: ordinaryPrepare,
  });
  await waitForApproval('retry', { streamId });
  decideRetry({ accepted: true });

  await expect(ordinary).resolves.toEqual({
    action: 'retry',
    feedback: undefined,
  });
  expect(ordinaryPrepare).toHaveBeenCalledOnce();
}

beforeEach(() => {
  mocks.apiMode = 'included';
  patchSessionMeta({ apiMode: 'included' });
  mocks.preferSubscription = true;
  mocks.openRouter = false;
  mocks.apiKeyExistsUncached.mockResolvedValue(true);
  mocks.hasUsableApiKey.mockResolvedValue(false);
  mocks.updateGlobalState.mockImplementation(
    async (key: string, value: unknown) => {
      if (key === GlobalStateKey.USE_OPENROUTER) {
        mocks.openRouter = value === true;
      }
    },
  );
  // Mirrors setCliApiMode: included access turns OpenRouter routing off.
  mocks.setCliApiMode.mockImplementation(async (mode) => {
    mocks.apiMode = mode;
    if (mode === 'included') mocks.openRouter = false;
  });
  mocks.setCliCodexSubscription.mockImplementation(async (enabled) => {
    mocks.preferSubscription = enabled;
    return { effective: enabled, target: 'global' };
  });
  mocks.setCliCodingPlanSubscription.mockImplementation(async (id, enabled) => {
    if (id === 'kimiCode') mocks.preferKimiCode = enabled;
    if (id === 'glmCodingPlan') mocks.glmCodingPlan = enabled;
  });
  mocks.setPreferKimiCode.mockImplementation(async (enabled) => {
    mocks.preferKimiCode = enabled;
  });
  mocks.setGLMCodingPlan.mockImplementation(async (enabled) => {
    mocks.glmCodingPlan = enabled;
  });
});

afterEach(() => {
  clearApprovals();
  cleanupAllApprovals();
  resetCliState();
  mocks.retryCopyFailure = undefined;
  mocks.apiKeyExistsUncached.mockReset();
  mocks.hasUsableApiKey.mockReset();
  mocks.invalidateApiKeyCache.mockReset();
  mocks.notify.mockReset();
  mocks.setCliApiMode.mockReset();
  mocks.setCliCodexSubscription.mockReset();
  mocks.setCliCodingPlanSubscription.mockReset();
  mocks.refreshSubscriptionPreferenceViews.mockReset();
  mocks.setPreferKimiCode.mockReset();
  mocks.setGLMCodingPlan.mockReset();
  mocks.updateGlobalState.mockReset();
});

describe('TUI retry approvals', () => {
  it('reports an automatic yolo retry rejection as a policy denial', async () => {
    const { interactions } = tui(host(), {
      approvalPolicy: 'yolo',
    });

    const result = interactions.requestRetry?.(
      ordinaryRetry('yolo-transient-stream', 'yolo-transient-retry'),
    );

    await expect(result).resolves.toEqual({
      action: 'deny',
      reason:
        'Retry skipped: explicit interactive approval is required after automatic attempts are exhausted.',
    });
    expect(runOutcomeExitCode(RUN_OUTCOME.FAILED)).toBe(CliExitCode.AgentError);
    expect(currentApproval.get()).toBeUndefined();
  });

  it('does not mutate the runtime host emitter', () => {
    const presentationHost = host();
    const originalEmit = presentationHost.emit;
    tui(presentationHost);
    expect(presentationHost.emit).toBe(originalEmit);
  });

  it('updates TUI bash bypass state at the approval decision site', async () => {
    const { presentationHost, interactions } = tui();
    const result = interactions.requestBashApproval?.({
      command: 'echo ok',
      streamId: 'bash-bypass-stream',
    });

    await waitForApproval('bash', { streamId: 'bash-bypass-stream' });
    currentApproval.get()?.decide({ accepted: true, bypass: 'bash' });

    await expect(result).resolves.toEqual({ action: 'approve' });
    expect(streams.get().get('bash-bypass-stream')?.bypass.bash).toBe(true);
    expect(presentationHost.emitApprovalBypassState).toHaveBeenCalledWith({
      streamId: 'bash-bypass-stream',
      kind: 'bash',
      bypassActive: true,
    });
  });

  it('updates TUI bash bypass state when goal auto-approval is enabled and cleared', async () => {
    const { presentationHost } = tui();
    await setGoalSessionBashAutoApproval('goal-bypass-stream', true);
    expect(streams.get().get('goal-bypass-stream')?.bypass.bash).toBe(true);
    expect(presentationHost.emitApprovalBypassState).toHaveBeenCalledWith({
      streamId: 'goal-bypass-stream',
      kind: 'bash',
      bypassActive: true,
    });

    await setGoalSessionBashAutoApproval('goal-bypass-stream', false);
    expect(streams.get().get('goal-bypass-stream')?.bypass.bash).toBe(false);
    expect(presentationHost.emitApprovalBypassState).toHaveBeenCalledWith({
      streamId: 'goal-bypass-stream',
      kind: 'bash',
      bypassActive: false,
    });
  });

  it('updates TUI edit bypass state at the approval decision site', async () => {
    const { presentationHost, interactions } = tui();
    const result = interactions.requestToolEditApproval?.({
      path: '/work/main.tex',
      originalContent: 'old',
      proposedContent: 'new',
      sourceTool: 'edit',
      streamId: 'edit-bypass-stream',
    });

    await waitForApproval('toolEdit', { streamId: 'edit-bypass-stream' });
    currentApproval.get()?.decide({ accepted: true, bypass: 'toolEdit' });

    await expect(result).resolves.toEqual({
      accepted: true,
      appliedContent: 'new',
    });
    expect(streams.get().get('edit-bypass-stream')?.bypass.toolEdit).toBe(true);
    expect(presentationHost.emitApprovalBypassState).toHaveBeenCalledWith({
      streamId: 'edit-bypass-stream',
      kind: 'toolEdit',
      bypassActive: true,
    });
  });

  it('enables the complete delegated-task approval mode at the proposal decision site', async () => {
    const { presentationHost, interactions } = tui();
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

    await waitForApproval('proposal', { streamId: 'proposal-bypass-stream' });
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
    expect(presentationHost.emitApprovalBypassState).toHaveBeenCalledWith({
      streamId: 'proposal-bypass-stream',
      kind: 'superYolo',
      bypassActive: true,
    });
    expect(presentationHost.emitApprovalBypassState).toHaveBeenCalledWith({
      streamId: 'proposal-bypass-stream',
      kind: 'toolEdit',
      bypassActive: true,
    });
    expect(presentationHost.emitApprovalBypassState).toHaveBeenCalledWith({
      streamId: 'proposal-bypass-stream',
      kind: 'bash',
      bypassActive: true,
    });
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
      kind: 'planApproval',
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

    await waitForApproval('proposal', { proposalId: 'proposal-current' });
    currentApproval.get()?.decide({ accepted: true, bypass: 'superYolo' });

    await expect(proposal).resolves.toEqual({ action: 'approve' });
    await expect(edit).resolves.toEqual({
      accepted: true,
      appliedContent: 'new',
    });
    await expect(bash).resolves.toEqual({ action: 'approve' });
    expect(pendingApprovalSummaries.get()).toEqual([
      { streamKey: streamId, kind: 'planApproval' },
      { streamKey: streamId, kind: 'retry' },
      { streamKey: streamId, kind: 'externalInquiry' },
      { streamKey: streamId, kind: 'userQuestion' },
      { streamKey: 'other-approval-stream', kind: 'bash' },
    ]);
    expect(currentApproval.get()?.payload.kind).toBe('planApproval');
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

    await waitForApproval('retry', {
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

    await waitForApproval('retry', {
      streamId: 's2',
      personalApiKeyAvailable: false,
      missingPersonalApiKeyMessage:
        'TeXRA could not check whether the OpenAI API key is available. Press n to dismiss, then use `/key` to try again.',
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

    await waitForApproval('retry', { streamId: 'unknown-provider' });
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
    } as RetryPermission);

    await vi.waitFor(() => {
      expect(mocks.setCliApiMode).toHaveBeenCalledWith('personal');
    });
    await expect(result).resolves.toEqual({
      action: 'retry',
      decisionSource: 'automatic',
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

    await waitForApproval('retry', {
      streamId: 's3',
      errorMessage: 'ChatGPT subscription usage limit reached.',
      personalApiKeyAvailable: true,
    });
    expect(mocks.hasUsableApiKey).toHaveBeenCalledTimes(1);
    expectNoPreferenceWrites();

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
    expect(mocks.apiKeyExistsUncached).toHaveBeenCalledOnce();
    expect(mocks.invalidateApiKeyCache).toHaveBeenCalledOnce();
    expect(prepareRetry).toHaveBeenCalledOnce();
    expect(prepareRetry).toHaveBeenCalledWith('personal', expect.anything());
    expect(currentApproval.get()).toBeUndefined();
  });

  it('disables a catalogued coding plan before retrying with a personal key', async () => {
    mocks.preferKimiCode = true;
    mocks.hasUsableApiKey.mockImplementation(
      async (_secrets, provider: ApiProvider) => provider === 'moonshot',
    );

    const { interactions } = tui();
    const result = interactions.requestRetry?.(
      kimiCodeSubscriptionRetry('kimi-limit'),
    );
    await waitForApproval('retry', {
      streamId: 'kimi-limit',
      personalApiKeyAvailable: true,
    });

    decideRetry({
      accepted: true,
      apiMode: 'personal',
      disableCodingPlan: 'kimiCode',
    });

    await expect(result).resolves.toEqual({
      action: 'retry',
      feedback: undefined,
    });
    expect(mocks.setCliCodingPlanSubscription).toHaveBeenCalledWith(
      'kimiCode',
      false,
    );
  });

  it('restores Kimi without overwriting a newer OpenRouter choice', async () => {
    mocks.preferKimiCode = true;
    mocks.hasUsableApiKey.mockImplementation(
      async (_secrets, provider: ApiProvider) => provider === 'moonshot',
    );
    mocks.setCliCodingPlanSubscription.mockImplementationOnce(async () => {
      mocks.preferKimiCode = false;
      mocks.openRouter = true;
      throw new Error('Kimi preference write failed');
    });

    const { interactions } = tui();
    const result = interactions.requestRetry?.(
      kimiCodeSubscriptionRetry('kimi-rollback'),
    );
    await waitForApproval('retry', { streamId: 'kimi-rollback' });
    decideRetry({
      accepted: true,
      apiMode: 'personal',
      disableCodingPlan: 'kimiCode',
    });

    await expect(result).resolves.toEqual({
      action: 'deny',
      reason: expect.stringContaining('Kimi preference write failed'),
    });
    expect(mocks.preferKimiCode).toBe(true);
    expect(mocks.openRouter).toBe(true);
    expect(mocks.setPreferKimiCode).toHaveBeenCalledWith(true, undefined, {
      preserveOpenRouter: true,
    });
    expect(mocks.refreshSubscriptionPreferenceViews).toHaveBeenCalledOnce();
  });

  it('does not offer or apply the subscription switch without an OpenAI API key', async () => {
    mocks.hasUsableApiKey.mockResolvedValue(false);

    const { interactions, prepareRetry } = tui();
    const result = interactions.requestRetry?.(
      chatGptSubscriptionRetry('missing-openai-key'),
    );

    await waitForApproval('retry', {
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
    await settleRetryContinuation();

    expectNoCredentialChange(prepareRetry);
  });

  it('does not publish preferences when the personal-key client cannot be prepared', async () => {
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
    expectNoPreferenceWrites();
    expectIncludedSubscriptionRoute();
    expect(prepareRetry).toHaveBeenCalledOnce();
  });

  it('leaves a newer access selection untouched when candidate construction fails', async () => {
    mocks.hasUsableApiKey.mockResolvedValue(true);
    const preparation = pDefer<void>();
    const prepareRetry = vi.fn(async () => {
      await preparation.promise;
      throw new Error('OpenAI client construction failed');
    });
    const { interactions } = tui();
    const { result } = await beginSubscriptionSwitch(
      interactions,
      'newer-access-selection',
      { prepareRetry },
    );
    await vi.waitFor(() => expect(prepareRetry).toHaveBeenCalledOnce());
    expectIncludedSubscriptionRoute();

    // A later /api, /key, login, or logout selection owns these values now.
    mocks.apiMode = 'included';
    mocks.preferSubscription = true;
    preparation.resolve();

    await expect(result).resolves.toEqual({
      action: 'deny',
      reason: 'OpenAI client construction failed',
    });
    expectNoPreferenceWrites();
    expectIncludedSubscriptionRoute();
  });

  it('cancels stalled candidate construction without publishing settings', async () => {
    mocks.hasUsableApiKey.mockResolvedValue(true);
    const prepareRetry = vi.fn(
      // Deliberately never settles: cancellation must reject the wrapper.
      async (_selection, _signal?: AbortSignal) => await neverSettles(),
    );
    const { interactions } = tui();
    const { result } = await beginSubscriptionSwitch(
      interactions,
      'stalled-preparation',
      { prepareRetry },
    );
    await vi.waitFor(() => expect(prepareRetry).toHaveBeenCalledOnce());

    interactions.cancel({
      streamId: 'stalled-preparation',
      kind: 'retry',
      cause: 'Cancelled in test.',
    });
    await expect(result).resolves.toEqual({ action: 'cancel' });
    expect(prepareRetry.mock.calls[0]?.[1]?.aborted).toBe(true);
    await vi.waitFor(() => {
      expectIncludedSubscriptionRoute();
    });

    const laterPrepare = vi.fn(async (selection) => {
      expect(selection).toBe('configured');
    });
    const later = interactions.requestRetry?.(
      ordinaryRetry('retry-after-stall'),
      { prepareRetry: laterPrepare },
    );
    await waitForApproval('retry', { streamId: 'retry-after-stall' });
    decideRetry({ accepted: true });

    await expect(later).resolves.toEqual({
      action: 'retry',
      feedback: undefined,
    });
    expect(laterPrepare).toHaveBeenCalledOnce();
  });

  it('rolls back a cancelled persistence write and releases the session commit queue', async () => {
    mocks.hasUsableApiKey.mockResolvedValue(true);
    mocks.setCliApiMode.mockImplementationOnce(async (mode) => {
      mocks.apiMode = mode;
      // Simulate storage that never settles after updating in-memory state.
      await neverSettles();
    });
    const { interactions } = tui();
    const { result } = await beginSubscriptionSwitch(
      interactions,
      'stalled-mode-persistence',
    );
    await vi.waitFor(() => expect(mocks.setCliApiMode).toHaveBeenCalledOnce());
    expect(mocks.apiMode).toBe('personal');

    interactions.cancel({
      streamId: 'stalled-mode-persistence',
      kind: 'retry',
      cause: 'Cancelled in test.',
    });
    await expect(result).resolves.toEqual({ action: 'cancel' });
    await vi.waitFor(() => expect(mocks.apiMode).toBe('included'));

    const laterPrepare = vi.fn(async () => undefined);
    const later = interactions.requestRetry?.(
      relayRetry({
        streamId: 'after-stalled-persistence',
        provider: 'openai',
      }),
      { prepareRetry: laterPrepare },
    );
    await expect(later).resolves.toEqual({
      action: 'retry',
      decisionSource: 'automatic',
      feedback: undefined,
    });
    expect(laterPrepare).toHaveBeenCalledOnce();
    expect(mocks.apiMode).toBe('personal');
  });

  it('reports any preference that cannot be restored after commit fails', async () => {
    mocks.hasUsableApiKey.mockResolvedValue(true);
    mocks.setCliCodexSubscription
      .mockImplementationOnce(async (enabled: boolean) => {
        mocks.preferSubscription = enabled;
        throw new Error('subscription write failed');
      })
      .mockRejectedValueOnce(new Error('settings storage unavailable'));
    const prepareRetry = vi.fn(async () => undefined);

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

  it('restores OpenRouter routing when the credential switch rolls back', async () => {
    mocks.hasUsableApiKey.mockResolvedValue(true);
    mocks.openRouter = true;
    mocks.setCliCodexSubscription.mockRejectedValueOnce(
      new Error('subscription write failed'),
    );

    const { interactions } = tui();
    const { result } = await beginSubscriptionSwitch(
      interactions,
      'openrouter-rollback',
    );

    await expect(result).resolves.toEqual({
      action: 'deny',
      reason: expect.stringContaining('subscription write failed'),
    });
    expect(mocks.apiMode).toBe('included');
    expect(mocks.openRouter).toBe(true);
    expect(mocks.updateGlobalState).toHaveBeenCalledWith(
      GlobalStateKey.USE_OPENROUTER,
      true,
    );
  });

  it('reports unconfirmed persistence when API-mode rollback restores memory before rejecting', async () => {
    mocks.hasUsableApiKey.mockResolvedValue(true);
    mocks.setCliApiMode
      .mockImplementationOnce(async (mode) => {
        mocks.apiMode = mode;
      })
      .mockImplementationOnce(async (mode) => {
        mocks.apiMode = mode;
        throw new Error('API mode storage unavailable');
      });
    mocks.setCliCodexSubscription.mockRejectedValueOnce(
      new Error('subscription storage unavailable'),
    );
    const prepareRetry = vi.fn(async () => undefined);

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
    expectIncludedSubscriptionRoute();
    expect(prepareRetry).toHaveBeenCalledOnce();
  });

  it('cancels a credential switch during candidate construction without settings writes', async () => {
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
    await vi.waitFor(() => {
      expectIncludedSubscriptionRoute();
    });

    expect(sessionMeta.get().apiMode).toBe('included');
    expectNoPreferenceWrites();
  });

  it('retries ChatGPT subscription access without changing credentials when the ordinary retry action is chosen', async () => {
    const { interactions } = tui();
    const result = interactions.requestRetry?.(
      chatGptSubscriptionRetry('subscription-retry'),
    );

    await waitForApproval('retry', { streamId: 'subscription-retry' });
    decideRetry({ accepted: true });

    await expect(result).resolves.toEqual({
      action: 'retry',
      feedback: undefined,
    });
    expect(mocks.hasUsableApiKey).toHaveBeenCalledOnce();
    expectNoPreferenceWrites();
  });

  it('keeps new ordinary retry preparation on the old route while a candidate is building', async () => {
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

    await approveOrdinaryRetryOnOldRoute(interactions, 'ordinary-stream');

    preparation.resolve();
    await expect(switching).resolves.toEqual({
      action: 'retry',
      feedback: undefined,
    });
    expect(mocks.apiMode).toBe('personal');
    expect(mocks.preferSubscription).toBe(false);
  });

  it('lets an ordinary retry keep the old route while another candidate fails', async () => {
    mocks.hasUsableApiKey.mockResolvedValue(true);
    const preparation = pDefer<void>();
    const switchPrepare = vi.fn(async () => {
      await preparation.promise;
      throw new Error('replacement client failed');
    });
    const { interactions } = tui();
    const { result: switching } = await beginSubscriptionSwitch(
      interactions,
      'failing-switch',
      { prepareRetry: switchPrepare },
    );
    await vi.waitFor(() => expect(switchPrepare).toHaveBeenCalledOnce());

    await approveOrdinaryRetryOnOldRoute(
      interactions,
      'ordinary-after-rollback',
    );

    preparation.resolve();
    await expect(switching).resolves.toEqual({
      action: 'deny',
      reason: 'replacement client failed',
    });
  });

  it('denies an ordinary retry when its replacement client cannot be prepared', async () => {
    const { interactions } = tui();
    const prepareRetry = vi.fn(async () => {
      throw new Error('ordinary client refresh failed');
    });
    const ordinary = interactions.requestRetry?.(
      ordinaryRetry('ordinary-refresh-failure'),
      { prepareRetry },
    );
    await waitForApproval('retry', { streamId: 'ordinary-refresh-failure' });
    decideRetry({ accepted: true });

    await expect(ordinary).resolves.toEqual({
      action: 'deny',
      reason: 'ordinary client refresh failed',
    });
    expect(prepareRetry).toHaveBeenCalledOnce();
    expectNoPreferenceWrites();
  });

  it('holds a preparing retry out of the queue, then joins behind the open modal', async () => {
    let resolveLookup: ((value: boolean) => void) | undefined;
    mocks.hasUsableApiKey.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveLookup = resolve;
        }),
    );

    const { interactions } = tui();
    const retry = interactions.requestRetry?.(
      relayRetry({ streamId: 'preparing-stream', provider: 'openai' }),
    );
    const bash = interactions.requestBashApproval?.({
      command: 'echo ok',
      streamId: 'bash-stream',
    });

    await waitForApproval('bash', { streamId: 'bash-stream' });
    // The retry owns a queue slot from the moment it is requested, but it is
    // not a request the user can act on until its key lookup finishes.
    expect(approvalQueueStatus.get().depth).toBe(1);
    expect(pendingApprovalSummaries.get()).toEqual([
      { streamKey: 'bash-stream', kind: 'bash' },
    ]);

    resolveLookup?.(false);
    await vi.waitFor(() => {
      expect(pendingApprovalSummaries.get()).toEqual([
        { streamKey: 'bash-stream', kind: 'bash' },
        { streamKey: 'preparing-stream', kind: 'retry' },
      ]);
    });
    // It joined behind the modal the user is already answering.
    expect(currentApproval.get()?.payload).toMatchObject({ kind: 'bash' });

    currentApproval.get()?.decide({ accepted: true });
    await expect(bash).resolves.toEqual({ action: 'approve' });
    await waitForApproval('retry', { streamId: 'preparing-stream' });
    decideRetry({ accepted: false });
    await expect(retry).resolves.toEqual({ action: 'cancel' });
  });

  it('cancels both a cleared retry and one the user refuses', async () => {
    mocks.hasUsableApiKey.mockResolvedValue(false);

    const { interactions } = tui();
    const cleared = interactions.requestRetry?.(
      relayRetry({ streamId: 'cleared-retry', provider: 'openai' }),
    );
    await waitForApproval('retry', { streamId: 'cleared-retry' });
    clearApprovals();

    await expect(cleared).resolves.toEqual({ action: 'cancel' });

    const refused = interactions.requestRetry?.(
      relayRetry({ streamId: 'refused-retry', provider: 'openai' }),
    );
    await waitForApproval('retry', { streamId: 'refused-retry' });
    decideRetry({ accepted: false });

    await expect(refused).resolves.toEqual({ action: 'cancel' });
  });

  it('cancels ordinary retry preparation after approval', async () => {
    const ordinaryPrepare = vi.fn(
      // Cancellation settles the abort-aware wrapper around this task.
      async (_selection, _signal?: AbortSignal) => await neverSettles(),
    );
    const { interactions } = tui();
    const ordinary = interactions.requestRetry?.(
      ordinaryRetry('cancelled-ordinary'),
      { prepareRetry: ordinaryPrepare },
    );
    await waitForApproval('retry', { streamId: 'cancelled-ordinary' });
    decideRetry({ accepted: true });
    await vi.waitFor(() => expect(ordinaryPrepare).toHaveBeenCalledOnce());
    // The decided retry no longer reads as a request waiting on the user,
    // but the queue still owns it, so the cancel below reaches its
    // preparation.
    expect(approvalQueueStatus.get()).toEqual({ depth: 0, kind: 'approval' });
    interactions.cancel({
      streamId: 'cancelled-ordinary',
      kind: 'retry',
      cause: 'Cancelled in test.',
    });
    await expect(ordinary).resolves.toEqual({ action: 'cancel' });
    expect(ordinaryPrepare.mock.calls[0]?.[1]?.aborted).toBe(true);
  });

  // Both invalidation triggers must reject a retry whose API-key lookup is
  // still in flight, and must stay rejected once that lookup finally resolves.
  it.each([
    ['cleared', 'interrupted', () => clearApprovals()],
    [
      'unbound',
      'unbound',
      (handle: ReturnType<typeof tui>) => handle.dispose(),
    ],
  ] as const)(
    'invalidates pre-queue retry lookups when approvals are %s',
    async (_trigger, streamId, invalidate) => {
      let resolveLookup: ((value: boolean) => void) | undefined;
      mocks.hasUsableApiKey.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            resolveLookup = resolve;
          }),
      );

      const handle = tui();
      const result = handle.interactions.requestRetry?.(
        relayRetry({ streamId, provider: 'openai' }),
      );
      invalidate(handle);
      await expect(result).resolves.toEqual({ action: 'cancel' });

      resolveLookup?.(true);
      await settleRetryContinuation();

      expect(mocks.setCliApiMode).not.toHaveBeenCalled();
      expect(currentApproval.get()).toBeUndefined();
    },
  );

  it('cancels an active retry modal when approvals are cleared', async () => {
    mocks.hasUsableApiKey.mockResolvedValue(false);

    const { interactions } = tui();
    const result = interactions.requestRetry?.(
      relayRetry({ streamId: 'modal-interrupt', provider: 'openai' }),
    );

    await waitForApproval('retry', { streamId: 'modal-interrupt' });

    clearApprovals();
    await expect(result).resolves.toEqual({ action: 'cancel' });
    expect(currentApproval.get()).toBeUndefined();
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
    void requestSameStreamRetry(interactions, 'first retry');
    void requestSameStreamRetry(interactions, 'second retry');

    await waitForApproval('retry', { errorMessage: 'second retry' });

    resolveFirstLookup?.(true);
    await settleRetryContinuation();

    expect(mocks.setCliApiMode).not.toHaveBeenCalled();
  });

  it('clears an older retry modal when a newer retry auto-switches', async () => {
    mocks.hasUsableApiKey
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const { interactions } = tui();
    void requestSameStreamRetry(interactions, 'first retry');
    await waitForApproval('retry', { errorMessage: 'first retry' });

    const second = requestSameStreamRetry(interactions, 'second retry');

    await vi.waitFor(() => {
      expect(currentApproval.get()).toBeUndefined();
    });
    await expect(second).resolves.toEqual({
      action: 'retry',
      decisionSource: 'automatic',
      feedback: undefined,
    });
  });

  it('replaces an older retry modal when a newer retry also needs input', async () => {
    mocks.hasUsableApiKey.mockResolvedValue(false);

    const { interactions } = tui();
    void requestSameStreamRetry(interactions, 'first retry');
    await waitForApproval('retry', { errorMessage: 'first retry' });

    void requestSameStreamRetry(interactions, 'second retry');

    await waitForApproval('retry', { errorMessage: 'second retry' });
  });

  it('does not replace a retry owned by another host on the same stream', async () => {
    mocks.hasUsableApiKey.mockResolvedValue(false);

    const older = tui();
    const newer = tui();
    const olderResult = older.interactions.requestRetry?.(
      relayRetry({
        streamId: 'shared-stream',
        provider: 'openai',
        message: 'older host retry',
      }),
    );
    await waitForApproval('retry', { errorMessage: 'older host retry' });

    const newerResult = newer.interactions.requestRetry?.(
      relayRetry({
        streamId: 'shared-stream',
        provider: 'openai',
        message: 'newer host retry',
      }),
    );
    await vi.waitFor(() => {
      expect(pendingApprovalSummaries.get()).toHaveLength(2);
    });
    expect(currentApproval.get()?.payload).toMatchObject({
      kind: 'retry',
      payload: { errorMessage: 'older host retry' },
    });

    older.dispose();
    await expect(olderResult).resolves.toEqual({ action: 'cancel' });
    await waitForApproval('retry', { errorMessage: 'newer host retry' });
    decideRetry({ accepted: true });
    await expect(newerResult).resolves.toEqual({
      action: 'retry',
      feedback: undefined,
    });
  });

  it('detaches one host without settling the live host retry', async () => {
    mocks.hasUsableApiKey.mockResolvedValue(false);

    const older = tui();
    const newer = tui();
    const detached = older.interactions.requestRetry?.(
      relayRetry({ streamId: 'detached-host', provider: 'openai' }),
    );
    const live = newer.interactions.requestRetry?.(
      relayRetry({ streamId: 'live-host', provider: 'openai' }),
    );
    await vi.waitFor(() => {
      expect(pendingApprovalSummaries.get()).toEqual([
        { streamKey: 'detached-host', kind: 'retry' },
        { streamKey: 'live-host', kind: 'retry' },
      ]);
    });

    // The older host releases once the last execution it owned finishes, which
    // is after the newer host has taken over the session.
    older.dispose();

    await expect(detached).resolves.toEqual({ action: 'cancel' });
    expect(pendingApprovalSummaries.get()).toEqual([
      { streamKey: 'live-host', kind: 'retry' },
    ]);
    await waitForApproval('retry', { streamId: 'live-host' });
    decideRetry({ accepted: true });
    await expect(live).resolves.toEqual({
      action: 'retry',
      feedback: undefined,
    });
  });

  it('cancels a retry aborted while its preparation was resolving', async () => {
    const preparation = pDefer<void>();
    const prepareRetry = vi.fn(() => preparation.promise);

    const { interactions } = tui();
    const result = interactions.requestRetry?.(
      ordinaryRetry('abort-at-resolution'),
      { prepareRetry },
    );
    await waitForApproval('retry', { streamId: 'abort-at-resolution' });
    decideRetry({ accepted: true });
    await vi.waitFor(() => expect(prepareRetry).toHaveBeenCalledOnce());

    // Registered after the abort-aware wrapper, so the interrupt lands once
    // that wrapper has resolved and dropped its abort listener, and before the
    // retry's own continuation runs: no await is left to observe the abort.
    void preparation.promise.then(() => {
      clearApprovals();
    });
    preparation.resolve();

    await expect(result).resolves.toEqual({ action: 'cancel' });
  });

  it('shows the retry modal when pre-modal preparation fails', async () => {
    mocks.retryCopyFailure = new Error('retry copy unavailable');

    const { interactions, prepareRetry } = tui();
    const result = interactions.requestRetry?.(
      relayRetry({ streamId: 'preparation-failure', provider: 'openai' }),
    );

    await waitForApproval('retry', { streamId: 'preparation-failure' });
    decideRetry({ accepted: true });

    await expect(result).resolves.toEqual({
      action: 'retry',
      feedback: undefined,
    });
    expect(prepareRetry).toHaveBeenCalledWith('configured', expect.anything());
  });

  it('cancels a retry parked behind another commit without waiting for it', async () => {
    mocks.hasUsableApiKey.mockResolvedValue(true);
    const blockingWrite = pDefer<undefined>();
    mocks.setCliApiMode.mockImplementationOnce(async (mode) => {
      mocks.apiMode = mode;
      await blockingWrite.promise;
    });
    const queuedPreparation = pDefer<void>();
    const queuedPrepare = vi.fn(() => queuedPreparation.promise);

    const { interactions } = tui();
    const blocking = interactions.requestRetry?.(
      relayRetry({ streamId: 'blocking-commit', provider: 'openai' }),
    );
    await vi.waitFor(() => expect(mocks.setCliApiMode).toHaveBeenCalledOnce());

    const queued = interactions.requestRetry?.(
      relayRetry({ streamId: 'queued-commit', provider: 'openai' }),
      { prepareRetry: queuedPrepare },
    );
    await vi.waitFor(() => expect(queuedPrepare).toHaveBeenCalledOnce());
    queuedPreparation.resolve();
    // The retry continuation parks its commit behind the blocked one.
    await queuedPreparation.promise;
    await settleRetryContinuation();

    interactions.cancel({
      streamId: 'queued-commit',
      kind: 'retry',
      cause: 'Cancelled in test.',
    });
    await expect(queued).resolves.toEqual({ action: 'cancel' });
    expect(mocks.setCliApiMode).toHaveBeenCalledOnce();

    blockingWrite.resolve(undefined);
    await expect(blocking).resolves.toEqual({
      action: 'retry',
      decisionSource: 'automatic',
      feedback: undefined,
    });
    expect(mocks.setCliApiMode).toHaveBeenCalledOnce();
  });

  it('serializes a newer switch behind stale-switch rollback', async () => {
    const firstModeSwitch = pDefer<undefined>();
    mocks.hasUsableApiKey.mockResolvedValue(true);
    mocks.setCliApiMode
      .mockImplementationOnce(async (mode) => {
        mocks.apiMode = mode;
        await firstModeSwitch.promise;
      })
      .mockImplementationOnce(async (mode) => {
        mocks.apiMode = mode;
      });

    const { interactions, prepareRetry } = tui();
    void requestSameStreamRetry(interactions, 'first retry');
    await vi.waitFor(() => {
      expect(mocks.setCliApiMode).toHaveBeenCalledTimes(1);
    });

    const second = requestSameStreamRetry(interactions, 'second retry');
    await Promise.resolve();
    await vi.waitFor(() =>
      expect(mocks.setCliApiMode).toHaveBeenCalledTimes(2),
    );
    expect(mocks.apiMode).toBe('included');

    firstModeSwitch.reject(new Error('stale mode switch failed'));
    await expect(second).resolves.toEqual({
      action: 'retry',
      decisionSource: 'automatic',
      feedback: undefined,
    });
    expect(mocks.setCliApiMode.mock.calls.map(([mode]) => mode)).toEqual([
      'personal',
      'included',
      'personal',
    ]);
    expect(mocks.apiMode).toBe('personal');
    expect(prepareRetry).toHaveBeenCalledTimes(2);
    expect(prepareRetry).toHaveBeenNthCalledWith(
      1,
      'personal',
      expect.anything(),
    );
    expect(prepareRetry).toHaveBeenNthCalledWith(
      2,
      'personal',
      expect.anything(),
    );
  });
});
