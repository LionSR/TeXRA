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
  hasUsableApiKey: vi.fn(),
  handleExternalInquiryAction: vi.fn(),
  invalidateApiKeyCache: vi.fn(),
  preferSubscription: true,
  preferKimiCode: false,
  glmCodingPlan: false,
  notify: vi.fn(),
  openRouter: false,
  retryCopyFailure: undefined as Error | undefined,
  secrets: {},
  setCliCodexSubscription: vi.fn(),
  setCliCodingPlanSubscription: vi.fn(),
  refreshSubscriptionPreferenceViews: vi.fn(),
  setGLMCodingPlan: vi.fn(),
  updateGlobalState: vi.fn(),
}));

vi.mock('@tools/inquiry/inquiryActions', () => ({
  handleExternalInquiryAction: mocks.handleExternalInquiryAction,
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
      workspace: { getWorkspacePath: () => undefined },
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
import { resetCliState, streams } from '@cli/chat/tui/state/cliState';
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
import { createTuiCliContext } from '@test/cli/fixtures/cliContext';
import { setGoalSessionBashAutoApproval } from '@tools/goal';
import {
  isApprovalBypassedForStream,
  isBashApprovalBypassedForStream,
  proposalApprovals,
} from '@tools/approval';

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
  const cliContext = createTuiCliContext(contextOverrides);
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

/** Coding-plan retry on the shared `same-stream` stream the replacement cases
 *  below queue two requests against. */
function requestSameStreamRetry(
  interactions: HostInteractions,
  message: string,
): ReturnType<NonNullable<HostInteractions['requestRetry']>> {
  return interactions.requestRetry?.({
    ...kimiCodeSubscriptionRetry('same-stream'),
    errorMessage: message,
  } as RetryPermission);
}

/** Transient retry with no subscription exhaustion behind it. */
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

function kimiCodeSubscriptionRetry(
  streamId: string,
  model = 'kimi3',
): RetryPermission {
  const message = 'Kimi Code subscription usage limit reached.';
  return {
    streamId,
    operation: 'model request',
    model,
    errorMessage: message,
    errorDetails: {
      message,
      exhaustionReason: 'kimi-code-subscription',
      provider: 'moonshot',
    },
  } as RetryPermission;
}

function glmCodingPlanRetry(streamId: string): RetryPermission {
  const message = 'GLM Coding Plan usage limit reached.';
  return {
    streamId,
    operation: 'model request',
    model: 'glm46',
    errorMessage: message,
    errorDetails: {
      message,
      exhaustionReason: 'glm-coding-plan',
      provider: 'glm',
    },
  } as RetryPermission;
}

function decideRetry(decision: ApprovalDecision): void {
  const pending = currentApproval.get();
  expect(pending?.payload.kind).toBe('retry');
  pending?.decide(decision);
}

/** The pre-switch route: the ChatGPT subscription is still preferred. */
function expectChatGptSubscriptionRoute(): void {
  expect(mocks.preferSubscription).toBe(true);
}

function expectNoPreferenceWrites(): void {
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
  disableQuotaRoute: 'chatgpt',
};

async function waitForApproval(
  kind: string,
  data: Record<string, unknown>,
  tui?: Record<string, unknown>,
): Promise<void> {
  await vi.waitFor(() => {
    expect(currentApproval.get()?.payload).toMatchObject({
      kind,
      data,
      ...(tui ? { tui } : {}),
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
    expectChatGptSubscriptionRoute();
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
  mocks.preferSubscription = true;
  mocks.openRouter = false;
  mocks.apiKeyExistsUncached.mockResolvedValue(true);
  mocks.hasUsableApiKey.mockResolvedValue(false);
  // `restoreEnabled` for Kimi Code writes the stored key directly so the
  // catalog row's OpenRouter exclusion does not fire on a restore.
  mocks.updateGlobalState.mockImplementation(
    async (key: string, value: unknown) => {
      if (key === GlobalStateKey.USE_OPENROUTER) {
        mocks.openRouter = value === true;
      }
      if (key === GlobalStateKey.KIMI_CODE_PREFER) {
        mocks.preferKimiCode = value === true;
      }
    },
  );
  mocks.setCliCodexSubscription.mockImplementation(async (enabled) => {
    mocks.preferSubscription = enabled;
    return { effective: enabled, target: 'global' };
  });
  mocks.setCliCodingPlanSubscription.mockImplementation(async (id, enabled) => {
    if (id === 'kimiCode') mocks.preferKimiCode = enabled;
    if (id === 'glmCodingPlan') mocks.glmCodingPlan = enabled;
  });
  mocks.setGLMCodingPlan.mockImplementation(async (enabled) => {
    mocks.glmCodingPlan = enabled;
  });
});

afterEach(() => {
  clearApprovals();
  defaultSession().approvals.clearAll();
  defaultSession().interactions.cancel({ cause: 'All approvals cleared.' });
  resetCliState();
  mocks.retryCopyFailure = undefined;
  mocks.apiKeyExistsUncached.mockReset();
  mocks.hasUsableApiKey.mockReset();
  mocks.handleExternalInquiryAction.mockReset();
  mocks.invalidateApiKeyCache.mockReset();
  mocks.notify.mockReset();
  mocks.setCliCodexSubscription.mockReset();
  mocks.setCliCodingPlanSubscription.mockReset();
  mocks.refreshSubscriptionPreferenceViews.mockReset();
  mocks.setGLMCodingPlan.mockReset();
  mocks.updateGlobalState.mockReset();
});

describe('TUI retry approvals', () => {
  it('preserves the lifecycle cause when an external inquiry is interrupted', async () => {
    const { interactions } = tui();
    await interactions.openExternalInquiry?.({
      requestId: 'inquiry-interrupted',
      allowBypass: false,
      streamId: 'inquiry-stream',
      mode: 'new',
      question: 'Which external fact should be checked?',
      threadId: 'thread-interrupted',
      sessionLinks: null,
      draft: null,
      transcript: null,
    });
    await waitForApproval('externalInquiry', {
      threadId: 'thread-interrupted',
    });

    clearApprovals();

    await vi.waitFor(() =>
      expect(mocks.handleExternalInquiryAction).toHaveBeenCalledWith({
        action: 'drop',
        threadId: 'thread-interrupted',
        cause: 'Session interrupted.',
      }),
    );
  });

  it('drops a note-free external inquiry without synthesized feedback', async () => {
    const { interactions } = tui();
    await interactions.openExternalInquiry?.({
      requestId: 'inquiry-note-free',
      allowBypass: false,
      streamId: 'inquiry-stream',
      mode: 'new',
      question: 'Which external fact should be checked?',
      threadId: 'thread-note-free',
      sessionLinks: null,
      draft: null,
      transcript: null,
    });
    await waitForApproval('externalInquiry', {
      threadId: 'thread-note-free',
    });

    currentApproval.get()?.decide({ accepted: false });

    await vi.waitFor(() =>
      expect(mocks.handleExternalInquiryAction).toHaveBeenCalledWith({
        action: 'drop',
        threadId: 'thread-note-free',
      }),
    );
  });

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
      action: 'apply',
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
      requestId: 'proposal-bypass',
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
      requestId: 'proposal-current',
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
      data: {
        requestId: 'plan-excluded',
        streamId,
        goalEnabled: false,
        plan: { objective: 'Keep the approval categories distinct.' },
      },
    });
    void enqueueApproval({
      kind: 'retry',
      data: {
        requestId: 'retry-excluded',
        streamId,
        operation: 'model request',
      },
      tui: {},
    });
    void enqueueApproval({
      kind: 'externalInquiry',
      data: {
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
      data: {
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
      data: {
        requestId: 'other-stream-bash',
        allowBypass: true,
        streamId: 'other-approval-stream',
        command: 'lake test',
      },
    });

    await waitForApproval('proposal', { requestId: 'proposal-current' });
    currentApproval.get()?.decide({ accepted: true, bypass: 'superYolo' });

    await expect(proposal).resolves.toEqual({ action: 'approve' });
    await expect(edit).resolves.toEqual({
      action: 'apply',
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
      requestId: 'proposal-one-off',
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

  it('fails closed when a switchable retry does not identify its provider', async () => {
    mocks.hasUsableApiKey.mockResolvedValue(true);
    const { interactions, prepareRetry } = tui();
    const result = interactions.requestRetry?.({
      streamId: 's1',
      operation: 'model request',
      errorMessage: 'ChatGPT subscription usage limit reached.',
      errorDetails: {
        message: 'ChatGPT subscription usage limit reached.',
        exhaustionReason: 'chatgpt-subscription',
      },
    } as RetryPermission);

    await waitForApproval(
      'retry',
      {},
      {
        personalApiKeyAvailable: false,
        missingPersonalApiKeyMessage: expect.stringContaining(
          'provider could not be identified',
        ),
      },
    );
    decideRetry({ accepted: false });

    await expect(result).resolves.toEqual({ action: 'cancel' });
    expect(mocks.hasUsableApiKey).not.toHaveBeenCalled();
    expectNoCredentialChange(prepareRetry);
  });

  it('falls back to the retry modal when API key lookup fails', async () => {
    mocks.hasUsableApiKey.mockRejectedValue(new Error('keychain unavailable'));

    const { interactions } = tui();
    const retry = chatGptSubscriptionRetry('s2');
    void interactions.requestRetry?.(retry);

    await waitForApproval(
      'retry',
      { streamId: 's2' },
      {
        personalApiKeyAvailable: false,
        missingPersonalApiKeyMessage:
          'TeXRA could not check whether the OpenAI API key is available. Press n to dismiss, then use `/key` to try again.',
      },
    );
  });

  it('does not auto-switch when a retry provider is not an API provider', async () => {
    mocks.hasUsableApiKey.mockResolvedValue(true);

    const { interactions } = tui();
    const retry = {
      streamId: 'unknown-provider',
      operation: 'model request',
      errorMessage: 'ChatGPT subscription usage limit reached.',
      errorDetails: {
        message: 'ChatGPT subscription usage limit reached.',
        exhaustionReason: 'chatgpt-subscription',
        provider: 'custom-provider',
      },
    } as RetryPermission;
    void interactions.requestRetry?.(retry);

    await waitForApproval('retry', { streamId: 'unknown-provider' });
    expect(mocks.hasUsableApiKey).not.toHaveBeenCalled();
  });

  it('requires an explicit decision before switching a ChatGPT subscription retry to an API key', async () => {
    mocks.hasUsableApiKey.mockImplementation(
      async (_secrets, provider: ApiProvider) => provider === 'openai',
    );

    const { interactions, prepareRetry } = tui();
    const result = interactions.requestRetry?.(chatGptSubscriptionRetry('s3'));

    await waitForApproval(
      'retry',
      {
        streamId: 's3',
        errorMessage: 'ChatGPT subscription usage limit reached.',
      },
      { personalApiKeyAvailable: true },
    );
    expect(mocks.hasUsableApiKey).toHaveBeenCalledTimes(1);
    expectNoPreferenceWrites();

    decideRetry(PERSONAL_KEY_RETRY);

    await expect(result).resolves.toEqual({
      action: 'retry',
      feedback: undefined,
    });
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

  it('auto-switches a Kimi Code subscription limit to the stored Moonshot key', async () => {
    mocks.preferKimiCode = true;
    mocks.hasUsableApiKey.mockImplementation(
      async (_secrets, provider: ApiProvider) => provider === 'moonshot',
    );

    const { interactions, prepareRetry } = tui();
    const result = interactions.requestRetry?.(
      kimiCodeSubscriptionRetry('kimi-limit'),
    );

    await expect(result).resolves.toEqual({
      action: 'retry',
      decisionSource: 'automatic',
      feedback: undefined,
    });
    expect(mocks.setCliCodingPlanSubscription).toHaveBeenCalledWith(
      'kimiCode',
      false,
    );
    expect(prepareRetry).toHaveBeenCalledWith('personal', expect.anything());
    // The plan must be off before the client rebuild: endpoint and credential
    // resolution read the live preference, so rebuilding first would prepare
    // the retry against the exhausted coding route again.
    expect(
      mocks.setCliCodingPlanSubscription.mock.invocationCallOrder[0],
    ).toBeLessThan(prepareRetry.mock.invocationCallOrder[0] ?? 0);
    // The modal's quota warning was skipped, so the terminal notification is
    // the only signal that a persisted preference was flipped.
    expect(mocks.notify).toHaveBeenCalledWith('credentialSwitched');
    expect(prepareRetry.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      mocks.notify.mock.invocationCallOrder[0] ?? 0,
    );
    expect(currentApproval.get()).toBeUndefined();
  });

  it('announces the credential switch only after the personal client is prepared', async () => {
    mocks.preferKimiCode = true;
    mocks.hasUsableApiKey.mockImplementation(
      async (_secrets, provider: ApiProvider) => provider === 'moonshot',
    );
    const prepareRetry = vi.fn(async () => {
      throw new Error('Moonshot client construction failed');
    });

    const { interactions } = tui();
    const result = interactions.requestRetry?.(
      kimiCodeSubscriptionRetry('kimi-notify-failure'),
      { prepareRetry },
    );

    await expect(result).resolves.toEqual({
      action: 'deny',
      reason: 'Moonshot client construction failed',
    });
    // The automatic decision must not announce a switch that then rolled back.
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.preferKimiCode).toBe(true);
  });

  it('keeps the modal for a Kimi Code-exclusive model with no Moonshot fallback', async () => {
    mocks.preferKimiCode = true;
    mocks.hasUsableApiKey.mockImplementation(
      async (_secrets, provider: ApiProvider) => provider === 'moonshot',
    );

    const { interactions, prepareRetry } = tui();
    const result = interactions.requestRetry?.(
      kimiCodeSubscriptionRetry('kimi-exclusive', 'kimiCoding'),
    );

    // A stored Moonshot key must not auto-switch a kimi-for-coding model:
    // the coding endpoint is its only route, so the switch would retry the
    // same exhausted credential without a human decision. The modal is shown
    // without the API-key switch affordance, so the key availability lookup is
    // skipped as well.
    await waitForApproval('retry', { streamId: 'kimi-exclusive' });
    expect(
      (
        currentApproval.get()?.payload as
          { tui?: { personalApiKeyAvailable?: boolean } } | undefined
      )?.tui?.personalApiKeyAvailable,
    ).toBeUndefined();
    expect(mocks.hasUsableApiKey).not.toHaveBeenCalled();
    decideRetry({ accepted: false });

    await expect(result).resolves.toEqual({ action: 'cancel' });
    expectNoCredentialChange(prepareRetry);
    expect(mocks.notify).not.toHaveBeenCalledWith('credentialSwitched');
  });

  it.each([
    {
      name: 'Kimi Code',
      retry: () => kimiCodeSubscriptionRetry('plan-no-key'),
    },
    { name: 'GLM Coding Plan', retry: () => glmCodingPlanRetry('plan-no-key') },
  ])(
    'falls back to the modal for a $name retry without a usable fallback key',
    async ({ retry }) => {
      mocks.preferKimiCode = true;
      mocks.glmCodingPlan = true;
      mocks.hasUsableApiKey.mockResolvedValue(false);

      const { interactions, prepareRetry } = tui();
      const result = interactions.requestRetry?.(retry());

      await waitForApproval(
        'retry',
        { streamId: 'plan-no-key' },
        { personalApiKeyAvailable: false },
      );
      decideRetry({ accepted: false });

      await expect(result).resolves.toEqual({ action: 'cancel' });
      expectNoCredentialChange(prepareRetry);
    },
  );

  it('auto-switches a GLM Coding Plan limit to the stored GLM key', async () => {
    mocks.glmCodingPlan = true;
    mocks.hasUsableApiKey.mockImplementation(
      async (_secrets, provider: ApiProvider) => provider === 'glm',
    );

    const { interactions, prepareRetry } = tui();
    const result = interactions.requestRetry?.(glmCodingPlanRetry('glm-limit'));

    await expect(result).resolves.toEqual({
      action: 'retry',
      decisionSource: 'automatic',
      feedback: undefined,
    });
    expect(mocks.setCliCodingPlanSubscription).toHaveBeenCalledWith(
      'glmCodingPlan',
      false,
    );
    expect(
      mocks.setCliCodingPlanSubscription.mock.invocationCallOrder[0],
    ).toBeLessThan(prepareRetry.mock.invocationCallOrder[0] ?? 0);
    expect(mocks.notify).toHaveBeenCalledWith('credentialSwitched');
    expect(currentApproval.get()).toBeUndefined();
  });

  it('restores the coding-plan preference when the fallback client cannot be prepared', async () => {
    mocks.preferKimiCode = true;
    mocks.hasUsableApiKey.mockImplementation(
      async (_secrets, provider: ApiProvider) => provider === 'moonshot',
    );
    const prepareRetry = vi.fn(async () => {
      throw new Error('Moonshot client construction failed');
    });

    const { interactions } = tui();
    const result = interactions.requestRetry?.(
      kimiCodeSubscriptionRetry('kimi-prepare-fails'),
      { prepareRetry },
    );

    await expect(result).resolves.toEqual({
      action: 'deny',
      reason: 'Moonshot client construction failed',
    });
    // The plan was disabled before the failed preparation, so it must be put
    // back: a retry that never ran leaves no settings behind.
    expect(mocks.preferKimiCode).toBe(true);
    expect(mocks.updateGlobalState).toHaveBeenCalledWith(
      GlobalStateKey.KIMI_CODE_PREFER,
      true,
    );
    expect(mocks.refreshSubscriptionPreferenceViews).toHaveBeenCalled();
    expectNoPreferenceWrites();
  });

  it('restores the coding-plan preference when cancellation interrupts client preparation', async () => {
    mocks.preferKimiCode = true;
    mocks.hasUsableApiKey.mockImplementation(
      async (_secrets, provider: ApiProvider) => provider === 'moonshot',
    );
    const preparation = pDefer<void>();
    const prepareRetry = vi.fn(async () => preparation.promise);

    const { interactions } = tui();
    const result = interactions.requestRetry?.(
      kimiCodeSubscriptionRetry('kimi-cancel-prepare'),
      { prepareRetry },
    );
    await vi.waitFor(() => expect(prepareRetry).toHaveBeenCalledOnce());
    expect(mocks.preferKimiCode).toBe(false);

    interactions.cancel({ streamId: 'kimi-cancel-prepare', kind: 'retry' });
    await expect(result).resolves.toEqual({ action: 'cancel' });
    preparation.resolve();
    await settleRetryContinuation();

    expect(mocks.preferKimiCode).toBe(true);
    expect(mocks.updateGlobalState).toHaveBeenCalledWith(
      GlobalStateKey.KIMI_CODE_PREFER,
      true,
    );
  });

  it('serializes coding-plan rollback ahead of a newer coding-plan switch', async () => {
    mocks.preferKimiCode = true;
    mocks.hasUsableApiKey.mockImplementation(
      async (_secrets, provider: ApiProvider) => provider === 'moonshot',
    );
    const firstPreparation = pDefer<void>();
    const firstPrepare = vi.fn(async () => firstPreparation.promise);
    const secondPrepare = vi.fn(async () => undefined);

    const { interactions } = tui();
    const first = interactions.requestRetry?.(
      kimiCodeSubscriptionRetry('plan-race-first'),
      { prepareRetry: firstPrepare },
    );
    await vi.waitFor(() => expect(firstPrepare).toHaveBeenCalledOnce());
    expect(mocks.preferKimiCode).toBe(false);

    const second = interactions.requestRetry?.(
      kimiCodeSubscriptionRetry('plan-race-second'),
      { prepareRetry: secondPrepare },
    );
    await settleRetryContinuation();
    // The second switch must wait behind the first switch's rollback: only
    // the first disable has committed so far.
    expect(mocks.setCliCodingPlanSubscription).toHaveBeenCalledTimes(1);

    firstPreparation.reject(new Error('first fallback failed'));
    await expect(first).resolves.toEqual({
      action: 'deny',
      reason: 'first fallback failed',
    });
    await expect(second).resolves.toEqual({
      action: 'retry',
      decisionSource: 'automatic',
      feedback: undefined,
    });
    expect(mocks.updateGlobalState).toHaveBeenCalledWith(
      GlobalStateKey.KIMI_CODE_PREFER,
      true,
    );
    // The stale rollback restores the plan before the newer switch disables it
    // again, so the second retry still runs on the personal route.
    expect(
      mocks.updateGlobalState.mock.invocationCallOrder[0] ?? 0,
    ).toBeLessThan(
      mocks.setCliCodingPlanSubscription.mock.invocationCallOrder[1] ?? 0,
    );
    expect(mocks.preferKimiCode).toBe(false);
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

    await expect(result).resolves.toEqual({
      action: 'deny',
      reason: expect.stringContaining('Kimi preference write failed'),
    });
    expect(mocks.preferKimiCode).toBe(true);
    expect(mocks.openRouter).toBe(true);
    expect(mocks.updateGlobalState).toHaveBeenCalledWith(
      GlobalStateKey.KIMI_CODE_PREFER,
      true,
    );
    expect(mocks.refreshSubscriptionPreferenceViews).toHaveBeenCalledOnce();
  });

  it('does not offer or apply the subscription switch without an OpenAI API key', async () => {
    mocks.hasUsableApiKey.mockResolvedValue(false);

    const { interactions, prepareRetry } = tui();
    const result = interactions.requestRetry?.(
      chatGptSubscriptionRetry('missing-openai-key'),
    );

    await waitForApproval(
      'retry',
      { streamId: 'missing-openai-key' },
      { personalApiKeyAvailable: false },
    );
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
    expectChatGptSubscriptionRoute();
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
    expectChatGptSubscriptionRoute();

    // A later /api, /key, login, or logout selection owns this value now.
    mocks.preferSubscription = true;
    preparation.resolve();

    await expect(result).resolves.toEqual({
      action: 'deny',
      reason: 'OpenAI client construction failed',
    });
    expectNoPreferenceWrites();
    expectChatGptSubscriptionRoute();
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
      expectChatGptSubscriptionRoute();
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
    expect(mocks.preferSubscription).toBe(false);
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

    void interactions.requestRetry?.(chatGptSubscriptionRetry('commit-race'));
    await expect(first).resolves.toEqual({ action: 'cancel' });
    preparation.resolve();
    await preparation.promise;
    await vi.waitFor(() => {
      expectChatGptSubscriptionRoute();
    });

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
      chatGptSubscriptionRetry('preparing-stream'),
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
      chatGptSubscriptionRetry('cleared-retry'),
    );
    await waitForApproval('retry', { streamId: 'cleared-retry' });
    clearApprovals();

    await expect(cleared).resolves.toEqual({ action: 'cancel' });

    const refused = interactions.requestRetry?.(
      chatGptSubscriptionRetry('refused-retry'),
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
        chatGptSubscriptionRetry(streamId),
      );
      invalidate(handle);
      await expect(result).resolves.toEqual({ action: 'cancel' });

      resolveLookup?.(true);
      await settleRetryContinuation();

      expectNoPreferenceWrites();
      expect(currentApproval.get()).toBeUndefined();
    },
  );

  it('cancels an active retry modal when approvals are cleared', async () => {
    mocks.hasUsableApiKey.mockResolvedValue(false);

    const { interactions } = tui();
    const result = interactions.requestRetry?.(
      chatGptSubscriptionRetry('modal-interrupt'),
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

    expect(mocks.setCliCodingPlanSubscription).not.toHaveBeenCalled();
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
    const olderResult = older.interactions.requestRetry?.({
      ...chatGptSubscriptionRetry('shared-stream'),
      errorMessage: 'older host retry',
    } as RetryPermission);
    await waitForApproval('retry', { errorMessage: 'older host retry' });

    const newerResult = newer.interactions.requestRetry?.({
      ...chatGptSubscriptionRetry('shared-stream'),
      errorMessage: 'newer host retry',
    } as RetryPermission);
    await vi.waitFor(() => {
      expect(pendingApprovalSummaries.get()).toHaveLength(2);
    });
    expect(currentApproval.get()?.payload).toMatchObject({
      kind: 'retry',
      data: { errorMessage: 'older host retry' },
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
      chatGptSubscriptionRetry('detached-host'),
    );
    const live = newer.interactions.requestRetry?.(
      chatGptSubscriptionRetry('live-host'),
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
      chatGptSubscriptionRetry('preparation-failure'),
    );

    await waitForApproval('retry', { streamId: 'preparation-failure' });
    decideRetry({ accepted: true });

    await expect(result).resolves.toEqual({
      action: 'retry',
      feedback: undefined,
    });
    expect(prepareRetry).toHaveBeenCalledWith('configured', expect.anything());
  });
});
