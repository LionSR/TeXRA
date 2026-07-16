// Test support imports
import { createTestSession as createIsolatedTestSession } from '@test/support/sessionTestUtils';

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { ApprovalRequestHandler } from '@controllers/progressView/backend/ApprovalRequestHandler';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import type { SessionEvent } from '@agent/runtime/SessionEventHub';
import type {
  HostBashApprovalResult,
  HostUserQuestionResult,
  PlanApprovalResult,
  ProposalResult,
  RetryResult,
} from '@agent/runtime/HostInteractions';
import { createExtensionHostInteractions } from '@progressView/extensionHostInteractions';
import type {
  AgentProposalPermission,
  BashPermission,
  ExternalInquiryPermission,
  PlanApprovalPermission,
  RetryPermission,
  StreamTabId,
  ToolEditPermission,
  UserQuestionPermission,
} from '@shared/schemas';
import type { ApprovalRequestHandlerSet } from '@controllers/progressView/backend/progressBackendUiConfig';

const mocks = vi.hoisted(() => ({
  approveNativeToolEditApprovals: vi.fn(async () => undefined),
  cancelNativeToolEditApprovals: vi.fn(),
  nativeRequestApproval: vi.fn(),
  getLinterMessages: vi.fn(async () => []),
  pushManualCriticism: vi.fn(() => true),
}));

vi.mock('@frontend/approval/nativeToolEditApproval', () => ({
  approveNativeToolEditApprovals: mocks.approveNativeToolEditApprovals,
  cancelNativeToolEditApprovals: mocks.cancelNativeToolEditApprovals,
  nativeRequestApproval: mocks.nativeRequestApproval,
}));

vi.mock('@frontend/latex/linter', () => ({
  getLinterMessages: mocks.getLinterMessages,
}));

vi.mock('@frontend/latex/inlineCriticism', () => ({
  pushManualCriticism: mocks.pushManualCriticism,
}));

type ShowSpy<T> = ReturnType<typeof vi.fn<(item: T) => void>>;
type DismissSpy = ReturnType<typeof vi.fn<(id: string) => void>>;

interface RecordingTransport<T> {
  readonly show: ShowSpy<T>;
  readonly dismiss: DismissSpy;
}

interface RecordingApprovalHandlerSet extends ApprovalRequestHandlerSet {
  readonly transport: {
    toolEdit: RecordingTransport<ToolEditPermission>;
    bash: RecordingTransport<BashPermission>;
    retry: RecordingTransport<RetryPermission>;
    agentProposal: RecordingTransport<AgentProposalPermission>;
    planApproval: RecordingTransport<PlanApprovalPermission>;
    externalInquiry: RecordingTransport<ExternalInquiryPermission>;
    userQuestion: RecordingTransport<UserQuestionPermission>;
  };
}

function handler<
  T extends { streamId: string },
  K extends keyof T,
  Result = never,
>(
  idField: K,
): {
  handler: ApprovalRequestHandler<T, K, Result>;
  transport: RecordingTransport<T>;
} {
  const transport = {
    show: vi.fn<(item: T) => void>(),
    dismiss: vi.fn<(id: string) => void>(),
  };
  return {
    handler: new ApprovalRequestHandler<T, K, Result>(
      idField,
      transport.show,
      transport.dismiss,
      () => true,
    ),
    transport,
  };
}

function createHandlers(): RecordingApprovalHandlerSet {
  const toolEdit = handler<ToolEditPermission, 'requestId'>('requestId');
  const bash = handler<BashPermission, 'requestId', HostBashApprovalResult>(
    'requestId',
  );
  const retry = handler<RetryPermission, 'streamId', RetryResult>('streamId');
  const agentProposal = handler<
    AgentProposalPermission,
    'proposalId',
    ProposalResult
  >('proposalId');
  const planApproval = handler<
    PlanApprovalPermission,
    'approvalId',
    PlanApprovalResult
  >('approvalId');
  const externalInquiry = handler<ExternalInquiryPermission, 'requestId'>(
    'requestId',
  );
  const userQuestion = handler<
    UserQuestionPermission,
    'requestId',
    HostUserQuestionResult
  >('requestId');

  return {
    toolEdit: toolEdit.handler,
    bash: bash.handler,
    retry: retry.handler,
    agentProposal: agentProposal.handler,
    planApproval: planApproval.handler,
    externalInquiry: externalInquiry.handler,
    userQuestion: userQuestion.handler,
    transport: {
      toolEdit: toolEdit.transport,
      bash: bash.transport,
      retry: retry.transport,
      agentProposal: agentProposal.transport,
      planApproval: planApproval.transport,
      externalInquiry: externalInquiry.transport,
      userQuestion: userQuestion.transport,
    },
  };
}

function createRuntimeHost() {
  return { emit: vi.fn() };
}

const testSessions: SessionHandle[] = [];

afterEach(() => {
  for (const session of testSessions.splice(0)) session.dispose();
});

function createTestSession(): SessionHandle {
  const session = createIsolatedTestSession();
  testSessions.push(session);
  return session;
}

/** Reads the `requestId` passed to a handler's first `.show()` call. */
function firstShowRequestId(show: ReturnType<typeof vi.fn>): string {
  const requestId = (
    show.mock.calls[0]?.[0] as { requestId?: string } | undefined
  )?.requestId;
  if (!requestId) throw new Error('Expected a captured requestId.');
  return requestId;
}

function createInteractions(options: {
  runtimeHost?: ReturnType<typeof createRuntimeHost>;
  handlers?: ApprovalRequestHandlerSet;
  session: SessionHandle;
}) {
  return createExtensionHostInteractions({
    runtimeHost: options.runtimeHost ?? createRuntimeHost(),
    session: options.session,
    getApprovalHandlers: () => options.handlers ?? createHandlers(),
  });
}

function recordSessionEvents(session: SessionHandle): SessionEvent[] {
  const events: SessionEvent[] = [];
  session.events.subscribe((event) => events.push(event), {
    scope: 'session',
  });
  return events;
}

describe('createExtensionHostInteractions', () => {
  it('provides diagnostics and notification capabilities', async () => {
    const session = createTestSession();
    const interactions = createInteractions({ session });
    const showInformationMessage = vi
      .spyOn(vscode.window, 'showInformationMessage')
      .mockResolvedValue(undefined);

    try {
      await expect(
        interactions.readDiagnostics?.('/workspace/paper.tex'),
      ).resolves.toEqual([]);
      expect(
        interactions.addCriticism?.({
          absolutePath: '/workspace/paper.tex',
          line: 2,
          message: 'Tighten this step.',
          severity: 3,
          confidence: 4,
        }),
      ).toEqual({
        accepted: true,
        resolvedPath: '/workspace/paper.tex',
      });
      interactions.notifyUnavailableTools?.('Lean tools are unavailable.');

      expect(mocks.getLinterMessages).toHaveBeenCalledWith(
        '/workspace/paper.tex',
      );
      expect(mocks.pushManualCriticism).toHaveBeenCalledWith({
        absolutePath: '/workspace/paper.tex',
        line: 2,
        message: 'Tighten this step.',
        severity: 3,
        confidence: 4,
      });
      expect(showInformationMessage).toHaveBeenCalledWith(
        'Lean tools are unavailable.',
      );
    } finally {
      showInformationMessage.mockRestore();
    }
  });

  it('runs the selected unavailable-tool notification action', async () => {
    const session = createTestSession();
    const interactions = createInteractions({ session });
    const showInformationMessage = vi
      .spyOn(vscode.window, 'showInformationMessage')
      .mockResolvedValue('Open Lean Setup' as never);
    const executeCommand = vi
      .spyOn(vscode.commands, 'executeCommand')
      .mockResolvedValue(undefined);

    try {
      interactions.notifyUnavailableTools?.(
        'Lean tools are unavailable.',
        'texra.showLeanSetup',
        'Open Lean Setup',
      );

      await vi.waitFor(() => {
        expect(executeCommand).toHaveBeenCalledWith('texra.showLeanSetup');
      });
      expect(showInformationMessage).toHaveBeenCalledWith(
        'Lean tools are unavailable.',
        'Open Lean Setup',
      );
    } finally {
      showInformationMessage.mockRestore();
      executeCommand.mockRestore();
    }
  });

  it('approves already-pending delegated work only in the selected stream', async () => {
    const handlers = createHandlers();
    const session = createTestSession();
    const interactions = createInteractions({ handlers, session });

    const initiatingProposal = interactions.requestAgentProposal?.({
      proposalId: 'proposal-current',
      streamId: 'stream-a' as StreamTabId,
      agent: 'assistant',
      model: 'gpt-5',
      instruction: 'Begin the calculation.',
      memories: [],
      workingDirectory: null,
      agentSource: null,
      agentCategory: 'toolUse',
    });
    const parallelProposal = interactions.requestAgentProposal?.({
      proposalId: 'proposal-parallel',
      streamId: 'stream-a' as StreamTabId,
      agent: 'assistant',
      model: 'gpt-5',
      instruction: 'Check the calculation.',
      memories: [],
      workingDirectory: null,
      agentSource: null,
      agentCategory: 'toolUse',
    });
    const parallelBash = interactions.requestBashApproval?.({
      command: 'lake build',
      streamId: 'stream-a' as StreamTabId,
    });
    const otherStream = interactions.requestBashApproval?.({
      command: 'npm test',
      streamId: 'stream-b' as StreamTabId,
    });

    await expect(
      interactions.approvePendingDelegatedWork(
        'stream-a' as StreamTabId,
        'proposal-current',
      ),
    ).resolves.toBeUndefined();
    await expect(parallelProposal).resolves.toEqual({ action: 'approve' });
    await expect(parallelBash).resolves.toEqual({
      accepted: true,
      userMessage: undefined,
    });
    expect(handlers.transport.agentProposal.dismiss).toHaveBeenCalledWith(
      'proposal-parallel',
    );
    expect(mocks.approveNativeToolEditApprovals).toHaveBeenCalledWith(
      session,
      'stream-a',
    );

    expect(initiatingProposal).toBeDefined();
    expect(otherStream).toBeDefined();
    expect(
      interactions.submitProposalDecision('proposal-current', {
        action: 'approve',
      }),
    ).toBe(true);
    const bashShow = handlers.transport.bash.show;
    const otherRequestId = firstShowRequestId(bashShow);
    const streamBRequestId = (
      bashShow.mock.calls.find(
        ([request]) => request.streamId === 'stream-b',
      )?.[0] as { requestId?: string } | undefined
    )?.requestId;
    expect(streamBRequestId).toBeDefined();
    expect(otherRequestId).not.toBe(streamBRequestId);
    expect(
      interactions.submitBashDecision(streamBRequestId!, {
        action: 'reject',
      }),
    ).toBe(true);
    await expect(initiatingProposal).resolves.toEqual({ action: 'approve' });
    await expect(otherStream).resolves.toEqual({
      accepted: false,
      userMessage: undefined,
    });
  });

  it('shows and resolves plan approvals through existing handlers', async () => {
    const runtimeHost = createRuntimeHost();
    const handlers = createHandlers();
    const session = createTestSession();
    const sessionEvents = recordSessionEvents(session);
    const interactions = createInteractions({
      runtimeHost,
      handlers,
      session,
    });

    const resultPromise = interactions.requestPlanApproval?.({
      approvalId: 'plan-a',
      streamId: 'stream-a' as StreamTabId,
      goalEnabled: true,
      plan: { objective: 'Prove the compactness lemma.' },
    });

    expect(resultPromise).toBeDefined();
    expect(runtimeHost.emit).toHaveBeenCalledWith(
      'requestEnsureProgressView',
      {},
    );
    expect(runtimeHost.emit).not.toHaveBeenCalledWith(
      'setActiveStream',
      expect.anything(),
    );
    expect(sessionEvents).toContainEqual({
      scope: 'session',
      event: {
        type: 'setActiveStream',
        payload: {
          streamId: 'stream-a',
          suppressViewSwitch: true,
          ensureVisible: true,
        },
      },
    });
    expect(handlers.transport.planApproval.show).toHaveBeenCalledWith({
      approvalId: 'plan-a',
      streamId: 'stream-a',
      goalEnabled: true,
      plan: { objective: 'Prove the compactness lemma.' },
    });
    expect(
      interactions.submitPlanDecision('plan-a', {
        action: 'approve_and_goal',
      }),
    ).toBe(true);

    await expect(resultPromise).resolves.toEqual({
      action: 'approve_and_goal',
    });
    expect(handlers.transport.planApproval.dismiss).toHaveBeenCalledWith(
      'plan-a',
    );
    // The request was settled first-wins: a second resolution finds nothing.
    expect(
      interactions.submitPlanDecision('plan-a', { action: 'approve' }),
    ).toBe(false);
  });

  it('rejects a request when its show transport fails synchronously', async () => {
    const handlers = createHandlers();
    handlers.transport.planApproval.show.mockImplementationOnce(() => {
      throw new Error('Progress view transport unavailable.');
    });
    const interactions = createInteractions({
      handlers,
      session: createTestSession(),
    });

    const resultPromise = interactions.requestPlanApproval?.({
      approvalId: 'plan-show-failure',
      streamId: 'stream-a' as StreamTabId,
      goalEnabled: false,
      plan: { objective: 'Fail before becoming pending.' },
    });

    await expect(resultPromise).rejects.toThrow(
      'Progress view transport unavailable.',
    );
    expect(handlers.planApproval.get('plan-show-failure')).toBeUndefined();
    expect(
      interactions.submitPlanDecision('plan-show-failure', {
        action: 'approve',
      }),
    ).toBe(false);
    expect(handlers.transport.planApproval.dismiss).not.toHaveBeenCalled();
  });

  it('surfaces retry requests without stealing active-stream focus (#8246)', () => {
    const handlers = createHandlers();
    const session = createTestSession();
    const sessionEvents = recordSessionEvents(session);
    const interactions = createInteractions({ handlers, session });

    void interactions.requestRetry?.({
      requestId: 'retry:subagent',
      streamId: 'failing-subagent' as StreamTabId,
      operation: 'Model invocation',
    });

    // The stream is registered so its row can carry the pending badge, but
    // the active tab must not switch — the user may be inspecting another
    // stream while a failing subagent re-raises retry requests.
    const activations = sessionEvents.filter(
      (e) => e.scope === 'session' && e.event.type === 'setActiveStream',
    );
    expect(activations).toEqual([
      {
        scope: 'session',
        event: {
          type: 'setActiveStream',
          payload: {
            streamId: 'failing-subagent',
            suppressViewSwitch: true,
            ensureVisible: true,
          },
        },
      },
    ]);
    expect(handlers.transport.retry.show).toHaveBeenCalledWith(
      expect.objectContaining({ streamId: 'failing-subagent' }),
    );
  });

  it('does not let an old retry action resolve its replacement', async () => {
    const handlers = createHandlers();
    const interactions = createInteractions({
      handlers,
      session: createTestSession(),
    });
    const first = interactions.requestRetry?.({
      requestId: 'retry:first',
      streamId: 'stream-a' as StreamTabId,
      operation: 'First model invocation',
    });
    const replacement = interactions.requestRetry?.({
      requestId: 'retry:replacement',
      streamId: 'stream-a' as StreamTabId,
      operation: 'Replacement model invocation',
    });

    await expect(first).resolves.toEqual({ action: 'cancel' });
    expect(
      interactions.submitRetryDecision(
        'stream-a' as StreamTabId,
        'retry:first',
        {
          action: 'retry',
        },
      ),
    ).toBe(false);
    expect(
      interactions.isRetryPending(
        'stream-a' as StreamTabId,
        'retry:replacement',
      ),
    ).toBe(true);
    expect(
      interactions.submitRetryDecision(
        'stream-a' as StreamTabId,
        'retry:replacement',
        { action: 'retry' },
      ),
    ).toBe(true);
    await expect(replacement).resolves.toEqual({ action: 'retry' });
  });

  it('cancels pending retry requests for a removed stream', async () => {
    const runtimeHost = createRuntimeHost();
    const handlers = createHandlers();
    const interactions = createInteractions({
      runtimeHost,
      handlers,
      session: createTestSession(),
    });

    const resultPromise = interactions.requestRetry?.({
      requestId: 'retry:removed-stream',
      streamId: 'stream-a' as StreamTabId,
      operation: 'Model invocation',
    });

    interactions.cancel({ streamId: 'stream-a' as StreamTabId });

    await expect(resultPromise).resolves.toEqual({ action: 'cancel' });
    expect(handlers.transport.retry.dismiss).toHaveBeenCalledWith('stream-a');
  });

  it('routes tool-edit cancellation through the native approval owner', () => {
    const session = createTestSession();
    const interactions = createInteractions({ session });
    const selector = {
      kind: 'toolEdit' as const,
      streamId: 'stream-a' as StreamTabId,
      cause: 'Stream resources released.',
    };

    interactions.cancel(selector);

    expect(mocks.cancelNativeToolEditApprovals).toHaveBeenCalledWith(
      session,
      selector,
    );
  });

  it('forwards a cancellation cause as bash reject feedback', async () => {
    const handlers = createHandlers();
    const interactions = createInteractions({
      handlers,
      session: createTestSession(),
    });

    const resultPromise = interactions.requestBashApproval?.({
      command: 'rm -rf build',
      streamId: 'stream-a' as StreamTabId,
    });

    interactions.cancel({
      streamId: 'stream-a' as StreamTabId,
      cause: 'Stream resources released.',
    });

    await expect(resultPromise).resolves.toEqual({
      accepted: false,
      userMessage: 'Stream resources released.',
    });
    expect(handlers.transport.bash.dismiss).toHaveBeenCalled();
  });

  it('rejects a resolution whose kind does not match the pending request', async () => {
    const handlers = createHandlers();
    const interactions = createInteractions({
      handlers,
      session: createTestSession(),
    });

    const resultPromise = interactions.requestBashApproval?.({
      command: 'echo hi',
      streamId: 'stream-a' as StreamTabId,
    });
    const requestId = firstShowRequestId(handlers.transport.bash.show);

    // A mismatched kind for the same requestId must not settle the pending
    // bash approval as a plan action would (defends against a caller bug
    // resolving the wrong pending kind under a reused/misrouted requestId).
    expect(
      interactions.submitPlanDecision(requestId, { action: 'approve' }),
    ).toBe(false);

    // The correctly-kinded resolution still settles it.
    expect(
      interactions.submitBashDecision(requestId, { action: 'approve' }),
    ).toBe(true);
    await expect(resultPromise).resolves.toEqual({ accepted: true });
  });

  it('a retry-kind cancel clears only the retry, leaving the plan approval pending', async () => {
    const handlers = createHandlers();
    const interactions = createInteractions({
      handlers,
      session: createTestSession(),
    });

    const retryPromise = interactions.requestRetry?.({
      requestId: 'retry:scoped-cancel',
      streamId: 'stream-a' as StreamTabId,
      operation: 'Model invocation',
    });
    const planPromise = interactions.requestPlanApproval?.({
      approvalId: 'plan-a',
      streamId: 'stream-a' as StreamTabId,
      goalEnabled: false,
      plan: { objective: 'Survive a retry-scoped cancel.' },
    });

    // The stop-stream path: clear the retry panel without disturbing other
    // pending interactions on the same stream.
    interactions.cancel({
      streamId: 'stream-a' as StreamTabId,
      kind: 'retry',
      cause: 'Retry request cleared.',
    });

    await expect(retryPromise).resolves.toEqual({ action: 'cancel' });
    expect(handlers.transport.retry.dismiss).toHaveBeenCalledWith('stream-a');

    // The plan approval on the same stream survives untouched and is still
    // resolvable first-wins.
    expect(handlers.transport.planApproval.dismiss).not.toHaveBeenCalled();
    expect(
      interactions.submitPlanDecision('plan-a', { action: 'approve' }),
    ).toBe(true);
    await expect(planPromise).resolves.toEqual({ action: 'approve' });
  });

  it('shows external inquiries without waiting for a user decision', async () => {
    const runtimeHost = createRuntimeHost();
    const handlers = createHandlers();
    const interactions = createInteractions({
      runtimeHost,
      handlers,
      session: createTestSession(),
    });

    await expect(
      interactions.openExternalInquiry?.({
        requestId: 'thread-a',
        threadId: 'thread-a',
        question: 'Which convention should be used?',
        allowBypass: false,
        streamId: 'stream-a' as StreamTabId,
        mode: 'new',
      }),
    ).resolves.toEqual({ threadId: 'thread-a' });

    expect(handlers.transport.externalInquiry.show).toHaveBeenCalledWith({
      requestId: 'thread-a',
      threadId: 'thread-a',
      question: 'Which convention should be used?',
      allowBypass: false,
      streamId: 'stream-a',
      mode: 'new',
    });
    interactions.dismissExternalInquiry('thread-a');
    expect(handlers.transport.externalInquiry.dismiss).toHaveBeenCalledWith(
      'thread-a',
    );
  });

  it('cancels streamless user questions during unscoped cleanup', async () => {
    const handlers = createHandlers();
    const interactions = createInteractions({
      handlers,
      session: createTestSession(),
    });

    const resultPromise = interactions.askUserQuestion?.({
      requestId: 'question-a',
      questions: [
        {
          question: 'Which normalization should be used?',
          options: [{ label: 'Unit volume' }, { label: 'Unit mass' }],
        },
      ],
      allowBypass: false,
      streamId: '',
    });

    interactions.cancel({
      streamId: null,
      cause: 'No stream owns this question.',
    });

    // Cancellation forwards `cause` as agent-visible feedback, matching how
    // a live UI rejection settles (see the desktop host, which does the same).
    await expect(resultPromise).resolves.toEqual({
      submitted: false,
      feedback: 'No stream owns this question.',
    });
    expect(handlers.transport.userQuestion.dismiss).toHaveBeenCalledWith(
      'question-a',
    );
    // The cancelled question was released: a later resolution finds nothing.
    expect(
      interactions.submitUserQuestionDecision('question-a', {
        action: 'submit',
        answers: { choice: 'unit volume' },
      }),
    ).toBe(false);
  });

  it('settles submitted user questions with their answers', async () => {
    const handlers = createHandlers();
    const interactions = createInteractions({
      handlers,
      session: createTestSession(),
    });

    const resultPromise = interactions.askUserQuestion?.({
      requestId: 'question-submit',
      questions: [
        {
          question: 'Which normalization should be used?',
          options: [{ label: 'Unit volume' }, { label: 'Unit mass' }],
        },
      ],
      allowBypass: false,
      streamId: 'stream-a' as StreamTabId,
    });
    const answers = { normalization: 'unit volume' };

    expect(
      interactions.submitUserQuestionDecision('question-submit', {
        action: 'submit',
        answers,
      }),
    ).toBe(true);

    await expect(resultPromise).resolves.toEqual({
      submitted: true,
      answers,
    });
    expect(handlers.transport.userQuestion.dismiss).toHaveBeenCalledWith(
      'question-submit',
    );
  });

  it('delegates tool edit approval to the native VS Code port', async () => {
    const nativeResult = { accepted: true };
    mocks.nativeRequestApproval.mockResolvedValue(nativeResult);
    const session = createTestSession();
    const interactions = createInteractions({ session });
    const request = {
      path: 'paper.tex',
      originalContent: 'A',
      proposedContent: 'B',
      sourceTool: 'edit',
      streamId: 'stream-a' as StreamTabId,
    };

    await expect(interactions.requestToolEditApproval?.(request)).resolves.toBe(
      nativeResult,
    );
    expect(mocks.nativeRequestApproval).toHaveBeenCalledWith(request, {
      session,
    });
  });
});
