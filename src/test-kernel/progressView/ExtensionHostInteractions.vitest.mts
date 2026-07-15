// Test support imports
import { createTestSession as createIsolatedTestSession } from '@test/support/sessionTestUtils';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionHandle } from '@agent/runtime/SessionHandle';
import type { SessionEvent } from '@agent/runtime/SessionEventHub';
import { createExtensionHostInteractions } from '@progressView/extensionHostInteractions';
import type { StreamTabId } from '@shared/schemas';
import type { ApprovalRequestHandlerSet } from '@controllers/progressView/backend/progressBackendUiConfig';

const mocks = vi.hoisted(() => ({
  approveNativeToolEditApprovals: vi.fn(async () => undefined),
  cancelNativeToolEditApprovals: vi.fn(),
  nativeRequestApproval: vi.fn(),
}));

vi.mock('@frontend/approval/nativeToolEditApproval', () => ({
  approveNativeToolEditApprovals: mocks.approveNativeToolEditApprovals,
  cancelNativeToolEditApprovals: mocks.cancelNativeToolEditApprovals,
  nativeRequestApproval: mocks.nativeRequestApproval,
}));

interface RecordingApprovalHandler {
  readonly show: ReturnType<typeof vi.fn>;
  readonly resolve: ReturnType<typeof vi.fn>;
  readonly replay: ReturnType<typeof vi.fn>;
  readonly get: ReturnType<typeof vi.fn>;
  readonly hasPendingForStream: ReturnType<typeof vi.fn>;
  readonly releaseForStream: ReturnType<typeof vi.fn>;
  readonly clear: ReturnType<typeof vi.fn>;
}

function handler(): RecordingApprovalHandler {
  return {
    show: vi.fn(),
    resolve: vi.fn(),
    replay: vi.fn(),
    get: vi.fn(),
    hasPendingForStream: vi.fn(() => false),
    releaseForStream: vi.fn(),
    clear: vi.fn(),
  };
}

function createHandlers(): ApprovalRequestHandlerSet {
  return {
    toolEdit: handler(),
    bash: handler(),
    retry: handler(),
    agentProposal: handler(),
    planApproval: handler(),
    externalInquiry: handler(),
    userQuestion: handler(),
  } as unknown as ApprovalRequestHandlerSet;
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
    expect(handlers.agentProposal.resolve).toHaveBeenCalledWith(
      'proposal-parallel',
    );
    expect(mocks.approveNativeToolEditApprovals).toHaveBeenCalledWith(
      session,
      'stream-a',
    );

    expect(initiatingProposal).toBeDefined();
    expect(otherStream).toBeDefined();
    expect(
      interactions.resolve('proposal-current', {
        kind: 'proposal',
        action: 'approve',
      }),
    ).toBe(true);
    const bashShow = handlers.bash.show as unknown as ReturnType<typeof vi.fn>;
    const otherRequestId = firstShowRequestId(bashShow);
    const streamBRequestId = (
      bashShow.mock.calls.find(
        ([request]) => request.streamId === 'stream-b',
      )?.[0] as { requestId?: string } | undefined
    )?.requestId;
    expect(streamBRequestId).toBeDefined();
    expect(otherRequestId).not.toBe(streamBRequestId);
    expect(
      interactions.resolve(streamBRequestId!, {
        kind: 'bash',
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
    expect(handlers.planApproval.show).toHaveBeenCalledWith({
      approvalId: 'plan-a',
      streamId: 'stream-a',
      goalEnabled: true,
      plan: { objective: 'Prove the compactness lemma.' },
    });
    expect(
      interactions.resolve('plan-a', {
        kind: 'plan',
        action: 'approve_and_goal',
      }),
    ).toBe(true);

    await expect(resultPromise).resolves.toEqual({
      action: 'approve_and_goal',
    });
    expect(handlers.planApproval.resolve).toHaveBeenCalledWith('plan-a');
    // The request was settled first-wins: a second resolution finds nothing.
    expect(
      interactions.resolve('plan-a', { kind: 'plan', action: 'approve' }),
    ).toBe(false);
  });

  it('surfaces retry requests without stealing active-stream focus (#8246)', async () => {
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
    expect(handlers.retry.show).toHaveBeenCalledWith(
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
      interactions.resolveRetry('stream-a' as StreamTabId, 'retry:first', {
        kind: 'retry',
        action: 'retry',
      }),
    ).toBe(false);
    expect(
      interactions.isRetryPending(
        'stream-a' as StreamTabId,
        'retry:replacement',
      ),
    ).toBe(true);
    expect(
      interactions.resolveRetry(
        'stream-a' as StreamTabId,
        'retry:replacement',
        { kind: 'retry', action: 'retry' },
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
    expect(handlers.retry.resolve).toHaveBeenCalledWith('stream-a');
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
    expect(handlers.bash.resolve).toHaveBeenCalled();
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
    const requestId = firstShowRequestId(
      handlers.bash.show as ReturnType<typeof vi.fn>,
    );

    // A mismatched kind for the same requestId must not settle the pending
    // bash approval as a plan action would (defends against a caller bug
    // resolving the wrong pending kind under a reused/misrouted requestId).
    expect(
      interactions.resolve(requestId, { kind: 'plan', action: 'approve' }),
    ).toBe(false);

    // The correctly-kinded resolution still settles it.
    expect(
      interactions.resolve(requestId, { kind: 'bash', action: 'approve' }),
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
    expect(handlers.retry.resolve).toHaveBeenCalledWith('stream-a');

    // The plan approval on the same stream survives untouched and is still
    // resolvable first-wins.
    expect(handlers.planApproval.resolve).not.toHaveBeenCalled();
    expect(
      interactions.resolve('plan-a', { kind: 'plan', action: 'approve' }),
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

    expect(handlers.externalInquiry.show).toHaveBeenCalledWith({
      requestId: 'thread-a',
      threadId: 'thread-a',
      question: 'Which convention should be used?',
      allowBypass: false,
      streamId: 'stream-a',
      mode: 'new',
    });
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
    expect(handlers.userQuestion.resolve).toHaveBeenCalledWith('question-a');
    // The cancelled question was released: a later resolution finds nothing.
    expect(
      interactions.resolve('question-a', {
        kind: 'userQuestion',
        action: 'submit',
      }),
    ).toBe(false);
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
