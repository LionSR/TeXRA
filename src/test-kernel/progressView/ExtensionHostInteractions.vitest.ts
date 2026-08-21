// Third-party imports
import pDefer from 'p-defer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { SessionEvent } from '@agent/runtime/SessionEventHub';
import type { HostApprovalBypassStateUpdate } from '@agent/runtime/HostInteractions';
import type { ProgressHostInteractionsOptions } from '@controllers/progressView/backend/progressHostInteractions';
import { createExtensionHostInteractions } from '@progressView/extensionHostInteractions';
import type { StreamTabId } from '@shared/schemas';
import { createTestSession as createIsolatedTestSession } from '@test/support/sessionTestUtils';

// Local file imports
import { createRecordingApprovalHandlers } from './approvalHandlerSetHarness';

const mocks = vi.hoisted(() => ({
  getLinterMessages: vi.fn(async () => []),
  pushManualCriticism: vi.fn(() => true),
}));

vi.mock('@frontend/latex/linter', () => ({
  getLinterMessages: mocks.getLinterMessages,
}));

vi.mock('@frontend/latex/inlineCriticism', () => ({
  pushManualCriticism: mocks.pushManualCriticism,
}));

/** The caller-supplied presentation host `emit` routes interaction events to. */
function createPresentationSink() {
  return { emit: vi.fn() };
}

/** Stands in for the session's tool-edit approval controller. */
function createToolEditApprovals() {
  return {
    approvePendingForStream: vi.fn(async (): Promise<void> => {}),
    cancel: vi.fn(),
    requestApproval: vi.fn(),
  };
}

const STREAM_A = 'stream-a' as StreamTabId;
const STREAM_B = 'stream-b' as StreamTabId;

const NORMALIZATION_QUESTION = {
  question: 'Which normalization should be used?',
  options: [{ label: 'Unit volume' }, { label: 'Unit mass' }],
};

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

/**
 * One handler set per interactions instance: `getApprovalHandlers` must return
 * the same set on every call, because `cancel()` reaches all seven kinds and
 * has to find the requests `show()` recorded.
 */
function createInteractions(
  options: {
    presentationSink?: ReturnType<typeof createPresentationSink>;
    setApprovalBypassState?: (update: HostApprovalBypassStateUpdate) => void;
    session?: SessionHandle;
  } = {},
) {
  const handlers = createRecordingApprovalHandlers();
  const toolEditApprovals = createToolEditApprovals();
  const session = options.session ?? createTestSession();
  return {
    handlers,
    session,
    toolEditApprovals,
    interactions: createExtensionHostInteractions({
      interactions: options.presentationSink ?? createPresentationSink(),
      session,
      getApprovalHandlers: () => handlers,
      getToolEditApprovals: () =>
        toolEditApprovals as unknown as ReturnType<
          ProgressHostInteractionsOptions['getToolEditApprovals']
        >,
      setApprovalBypassState: options.setApprovalBypassState ?? vi.fn(),
    }),
  };
}

function recordSessionEvents(session: SessionHandle): SessionEvent[] {
  const events: SessionEvent[] = [];
  session.events.subscribe((event) => events.push(event), {
    scope: 'session',
  });
  return events;
}

/** A deferred retry preparation that rejects when its AbortSignal fires. */
function createDeferredPreparation() {
  const deferred = pDefer<void>();
  let signal: AbortSignal | undefined;
  const prepareRetry = vi.fn(
    async (_selection: string, abortSignal?: AbortSignal) => {
      if (!abortSignal) return;
      signal = abortSignal;
      abortSignal.addEventListener(
        'abort',
        () => deferred.reject(abortSignal.reason ?? new Error('aborted')),
        { once: true },
      );
      return deferred.promise;
    },
  );
  return { deferred, prepareRetry, signal: () => signal };
}

describe('createExtensionHostInteractions', () => {
  it('forwards emit to the caller-supplied presentation host (#9251)', () => {
    const presentationSink = createPresentationSink();
    const { interactions } = createInteractions({ presentationSink });

    interactions.emit?.('requestShowError', { message: 'boom' });

    expect(presentationSink.emit).toHaveBeenCalledWith('requestShowError', {
      message: 'boom',
    });
  });

  it('forwards approval bypass state through the host port', () => {
    const setApprovalBypassState = vi.fn();
    const { interactions } = createInteractions({ setApprovalBypassState });
    const update = {
      streamId: 'stream:bypass',
      kind: 'bash',
      bypassActive: true,
    } as const;

    interactions.setApprovalBypassState?.(update);

    expect(setApprovalBypassState).toHaveBeenCalledWith(update);
  });

  it('provides diagnostics and criticism capabilities', async () => {
    const { interactions } = createInteractions();

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
  });

  it('approves already-pending delegated work only in the selected stream', async () => {
    const { handlers, interactions, toolEditApprovals } = createInteractions();

    function requestProposal(requestId: string, instruction: string) {
      return interactions.requestAgentProposal?.({
        requestId,
        streamId: STREAM_A,
        agent: 'assistant',
        model: 'gpt-5',
        instruction,
        memories: [],
        workingDirectory: null,
        agentSource: null,
        agentCategory: 'toolUse',
      });
    }

    const initiatingProposal = requestProposal(
      'proposal-current',
      'Begin the calculation.',
    );
    const parallelProposal = requestProposal(
      'proposal-parallel',
      'Check the calculation.',
    );
    const parallelBash = interactions.requestBashApproval?.({
      command: 'lake build',
      streamId: STREAM_A,
    });
    const otherStream = interactions.requestBashApproval?.({
      command: 'npm test',
      streamId: STREAM_B,
    });

    await expect(
      interactions.approvePendingDelegatedWork(STREAM_A, 'proposal-current'),
    ).resolves.toBeUndefined();
    await expect(parallelProposal).resolves.toEqual({ action: 'approve' });
    await expect(parallelBash).resolves.toEqual({ action: 'approve' });
    expect(handlers.transport.proposal.dismiss).toHaveBeenCalledWith(
      'proposal-parallel',
    );
    expect(toolEditApprovals.approvePendingForStream).toHaveBeenCalledWith(
      'stream-a',
    );

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
    await expect(otherStream).resolves.toEqual({ action: 'reject' });
  });

  it('shows and resolves plan approvals through existing handlers', async () => {
    const presentationSink = createPresentationSink();
    const { handlers, interactions, session } = createInteractions({
      presentationSink,
    });
    const sessionEvents = recordSessionEvents(session);

    const resultPromise = interactions.requestPlanApproval?.({
      requestId: 'plan-a',
      streamId: STREAM_A,
      goalEnabled: true,
      plan: { objective: 'Prove the compactness lemma.' },
    });

    expect(resultPromise).toBeDefined();
    expect(presentationSink.emit).toHaveBeenCalledWith(
      'requestEnsureProgressView',
      {},
    );
    expect(presentationSink.emit).not.toHaveBeenCalledWith(
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
      requestId: 'plan-a',
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
    const { handlers, interactions } = createInteractions();
    handlers.transport.planApproval.show.mockImplementationOnce(() => {
      throw new Error('Progress view transport unavailable.');
    });

    const resultPromise = interactions.requestPlanApproval?.({
      requestId: 'plan-show-failure',
      streamId: STREAM_A,
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
    const session = createTestSession();
    const sessionEvents = recordSessionEvents(session);
    const { handlers, interactions } = createInteractions({ session });

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
    const { interactions } = createInteractions();
    const first = interactions.requestRetry?.({
      requestId: 'retry:first',
      streamId: STREAM_A,
      operation: 'First model invocation',
    });
    const replacement = interactions.requestRetry?.({
      requestId: 'retry:replacement',
      streamId: STREAM_A,
      operation: 'Replacement model invocation',
    });

    await expect(first).resolves.toEqual({ action: 'cancel' });
    expect(
      interactions.submitRetryDecision(STREAM_A, 'retry:first', {
        action: 'retry',
      }),
    ).toBe(false);
    expect(interactions.isRetryPending(STREAM_A, 'retry:replacement')).toBe(
      true,
    );
    expect(
      interactions.submitRetryDecision(STREAM_A, 'retry:replacement', {
        action: 'retry',
      }),
    ).toBe(true);
    await expect(replacement).resolves.toEqual({ action: 'retry' });
  });

  it('prepares a progress-view retry before settling it', async () => {
    const { interactions } = createInteractions();
    const prepareRetry = vi.fn(async () => undefined);
    const result = interactions.requestRetry?.(
      {
        requestId: 'retry:prepared',
        streamId: STREAM_A,
        operation: 'Model invocation',
      },
      { prepareRetry },
    );

    expect(
      interactions.submitRetryDecision(STREAM_A, 'retry:prepared', {
        action: 'retry',
      }),
    ).toBe(true);
    await expect(result).resolves.toEqual({ action: 'retry' });
    expect(prepareRetry).toHaveBeenCalledWith('configured', expect.anything());
  });

  it('prepares the personal route for the API-key retry switch', async () => {
    const { interactions } = createInteractions();
    const prepareRetry = vi.fn(async () => undefined);
    const result = interactions.requestRetry?.(
      {
        requestId: 'retry:personal',
        streamId: STREAM_A,
        operation: 'Model invocation',
      },
      { prepareRetry },
    );

    await expect(
      interactions.submitRetryWithPersonalCredentials(
        STREAM_A,
        'retry:personal',
        'switched to the stored key',
      ),
    ).resolves.toBe(true);
    await expect(result).resolves.toEqual({
      action: 'retry',
      feedback: 'switched to the stored key',
    });
    expect(prepareRetry).toHaveBeenCalledWith('personal', expect.anything());
  });

  it('denies a personal-credential retry when client preparation fails', async () => {
    const { interactions } = createInteractions();
    const prepareRetry = vi.fn(async () => {
      throw new Error('replacement client failed');
    });
    const result = interactions.requestRetry?.(
      {
        requestId: 'retry:prepare-failure',
        streamId: STREAM_A,
        operation: 'Model invocation',
      },
      { prepareRetry },
    );

    await expect(
      interactions.submitRetryWithPersonalCredentials(
        STREAM_A,
        'retry:prepare-failure',
      ),
    ).resolves.toBe(false);
    await expect(result).resolves.toEqual({
      action: 'deny',
      reason: 'replacement client failed',
    });
  });

  it('does not let a stale preparation settle its replacement request', async () => {
    const { interactions } = createInteractions();
    const first = createDeferredPreparation();
    const replacement = createDeferredPreparation();

    const firstResult = interactions.requestRetry?.(
      {
        requestId: 'retry:stale-prep',
        streamId: STREAM_A,
        operation: 'First invocation',
      },
      { prepareRetry: first.prepareRetry },
    );
    expect(
      interactions.submitRetryDecision(STREAM_A, 'retry:stale-prep', {
        action: 'retry',
      }),
    ).toBe(true);
    await vi.waitFor(() => expect(first.prepareRetry).toHaveBeenCalledOnce());

    const replacementResult = interactions.requestRetry?.(
      {
        requestId: 'retry:replacement-prep',
        streamId: STREAM_A,
        operation: 'Replacement invocation',
      },
      { prepareRetry: replacement.prepareRetry },
    );
    await expect(firstResult).resolves.toEqual({ action: 'cancel' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The stale settle saw the abort, but must not delete or deny the newer
    // request's preparation.
    expect(
      interactions.isRetryPending(STREAM_A, 'retry:replacement-prep'),
    ).toBe(true);
    expect(
      interactions.submitRetryDecision(STREAM_A, 'retry:replacement-prep', {
        action: 'retry',
      }),
    ).toBe(true);
    replacement.deferred.resolve();
    await expect(replacementResult).resolves.toEqual({ action: 'retry' });
  });

  it('rejects a conflicting personal-credential selection while a plain retry prepares', async () => {
    const { interactions } = createInteractions();
    const preparation = createDeferredPreparation();

    const result = interactions.requestRetry?.(
      {
        requestId: 'retry:conflict',
        streamId: STREAM_A,
        operation: 'First invocation',
      },
      { prepareRetry: preparation.prepareRetry },
    );
    expect(
      interactions.submitRetryDecision(STREAM_A, 'retry:conflict', {
        action: 'retry',
      }),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(preparation.prepareRetry).toHaveBeenCalledOnce(),
    );

    await expect(
      interactions.submitRetryWithPersonalCredentials(
        STREAM_A,
        'retry:conflict',
      ),
    ).resolves.toBe(false);

    expect(preparation.prepareRetry).toHaveBeenCalledTimes(1);
    expect(preparation.prepareRetry).toHaveBeenCalledWith(
      'configured',
      expect.anything(),
    );

    preparation.deferred.resolve();
    await expect(result).resolves.toEqual({ action: 'retry' });
  });

  it('aborts an in-flight personal preparation when the retry is dismissed', async () => {
    const { interactions } = createInteractions();
    const preparation = createDeferredPreparation();

    const result = interactions.requestRetry?.(
      {
        requestId: 'retry:cancel-prep',
        streamId: STREAM_A,
        operation: 'First invocation',
      },
      { prepareRetry: preparation.prepareRetry },
    );
    const personal = interactions.submitRetryWithPersonalCredentials(
      STREAM_A,
      'retry:cancel-prep',
    );
    await vi.waitFor(() =>
      expect(preparation.prepareRetry).toHaveBeenCalledOnce(),
    );

    expect(
      interactions.submitRetryDecision(STREAM_A, 'retry:cancel-prep', {
        action: 'cancel',
      }),
    ).toBe(true);
    expect(preparation.signal()?.aborted).toBe(true);
    await expect(personal).resolves.toBe(false);
    await expect(result).resolves.toEqual({ action: 'cancel' });
  });

  it('removes a canceled preparation from the retry map', async () => {
    const abortSpy = vi.spyOn(AbortController.prototype, 'abort');
    try {
      const { interactions } = createInteractions({
        session: createTestSession(),
      });
      const preparation = createDeferredPreparation();

      const result = interactions.requestRetry?.(
        {
          requestId: 'retry:cancel-map',
          streamId: STREAM_A,
          operation: 'First invocation',
        },
        { prepareRetry: preparation.prepareRetry },
      );
      const personal = interactions.submitRetryWithPersonalCredentials(
        STREAM_A,
        'retry:cancel-map',
      );
      await vi.waitFor(() =>
        expect(preparation.prepareRetry).toHaveBeenCalledOnce(),
      );

      interactions.cancel({ streamId: STREAM_A, kind: 'retry' });
      await expect(personal).resolves.toBe(false);
      await expect(result).resolves.toEqual({ action: 'cancel' });
      expect(preparation.signal()?.aborted).toBe(true);

      const abortsFor = (signal: AbortSignal | undefined) =>
        abortSpy.mock.instances.filter(
          (instance) => (instance as AbortController).signal === signal,
        ).length;
      expect(abortsFor(preparation.signal())).toBe(1);

      // If the canceled preparation stayed in the retry map, a replacement
      // request would abort its old controller again before overwriting the
      // entry. Removal keeps the old controller's abort count at exactly one.
      const replacement = interactions.requestRetry?.({
        requestId: 'retry:after-cancel',
        streamId: STREAM_A,
        operation: 'Replacement invocation',
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(abortsFor(preparation.signal())).toBe(1);

      interactions.cancel({ streamId: STREAM_A, kind: 'retry' });
      await expect(replacement).resolves.toEqual({ action: 'cancel' });
    } finally {
      abortSpy.mockRestore();
    }
  });

  it('wraps cancel-path settlement when the dismiss transport throws', async () => {
    const { handlers, interactions } = createInteractions();
    const result = interactions.requestRetry?.({
      requestId: 'retry:cancel-settlement',
      streamId: STREAM_A,
      operation: 'Model invocation',
    });
    handlers.transport.retry.dismiss.mockImplementationOnce(() => {
      throw new Error('Progress view dismiss transport unavailable.');
    });

    expect(
      interactions.submitRetryDecision(STREAM_A, 'retry:cancel-settlement', {
        action: 'cancel',
      }),
    ).toBe(true);
    await expect(result).resolves.toEqual({ action: 'cancel' });
    expect(handlers.transport.retry.dismiss).toHaveBeenCalledWith('stream-a');
  });

  it('cancels pending retry requests for a removed stream', async () => {
    const presentationSink = createPresentationSink();
    const { handlers, interactions } = createInteractions({
      presentationSink,
      session: createTestSession(),
    });

    const resultPromise = interactions.requestRetry?.({
      requestId: 'retry:removed-stream',
      streamId: STREAM_A,
      operation: 'Model invocation',
    });

    interactions.cancel({ streamId: 'stream-a' as StreamTabId });

    await expect(resultPromise).resolves.toEqual({ action: 'cancel' });
    expect(handlers.transport.retry.dismiss).toHaveBeenCalledWith('stream-a');
  });

  it('routes tool-edit cancellation through the session approval controller', () => {
    const session = createTestSession();
    const { interactions, toolEditApprovals } = createInteractions({ session });
    const selector = {
      kind: 'toolEdit' as const,
      streamId: STREAM_A,
      cause: 'Stream resources released.',
    };

    interactions.cancel(selector);

    expect(toolEditApprovals.cancel).toHaveBeenCalledWith(selector);
  });

  it('forwards a bash cancellation cause without user provenance', async () => {
    const { handlers, interactions } = createInteractions();

    const resultPromise = interactions.requestBashApproval?.({
      command: 'rm -rf build',
      streamId: STREAM_A,
    });

    interactions.cancel({
      streamId: STREAM_A,
      cause: 'Stream resources released.',
    });

    await expect(resultPromise).resolves.toEqual({
      action: 'reject',
      cause: 'Stream resources released.',
    });
    expect(handlers.transport.bash.dismiss).toHaveBeenCalled();
  });

  it('rejects a resolution whose kind does not match the pending request', async () => {
    const { handlers, interactions } = createInteractions();

    const resultPromise = interactions.requestBashApproval?.({
      command: 'echo hi',
      streamId: STREAM_A,
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
    await expect(resultPromise).resolves.toEqual({ action: 'approve' });
  });

  it('a retry-kind cancel clears only the retry, leaving the plan approval pending', async () => {
    const { handlers, interactions } = createInteractions();

    const retryPromise = interactions.requestRetry?.({
      requestId: 'retry:scoped-cancel',
      streamId: STREAM_A,
      operation: 'Model invocation',
    });
    const planPromise = interactions.requestPlanApproval?.({
      requestId: 'plan-a',
      streamId: STREAM_A,
      goalEnabled: false,
      plan: { objective: 'Survive a retry-scoped cancel.' },
    });

    // The stop-stream path: clear the retry panel without disturbing other
    // pending interactions on the same stream.
    interactions.cancel({
      streamId: STREAM_A,
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
    const presentationSink = createPresentationSink();
    const { handlers, interactions } = createInteractions({
      presentationSink,
      session: createTestSession(),
    });

    await expect(
      interactions.openExternalInquiry?.({
        requestId: 'thread-a',
        threadId: 'thread-a',
        question: 'Which convention should be used?',
        allowBypass: false,
        streamId: STREAM_A,
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
    const { handlers, interactions } = createInteractions();

    const resultPromise = interactions.askUserQuestion?.({
      requestId: 'question-a',
      questions: [NORMALIZATION_QUESTION],
      allowBypass: false,
      streamId: '',
    });

    interactions.cancel({
      streamId: null,
      cause: 'No stream owns this question.',
    });

    // Cancellation remains distinct from a live UI rejection with feedback.
    await expect(resultPromise).resolves.toEqual({
      action: 'reject',
      cause: 'No stream owns this question.',
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
    const { handlers, interactions } = createInteractions();

    const resultPromise = interactions.askUserQuestion?.({
      requestId: 'question-submit',
      questions: [NORMALIZATION_QUESTION],
      allowBypass: false,
      streamId: STREAM_A,
    });
    const answers = { normalization: 'unit volume' };

    expect(
      interactions.submitUserQuestionDecision('question-submit', {
        action: 'submit',
        answers,
      }),
    ).toBe(true);

    await expect(resultPromise).resolves.toEqual({
      action: 'submit',
      answers,
    });
    expect(handlers.transport.userQuestion.dismiss).toHaveBeenCalledWith(
      'question-submit',
    );
  });

  it('delegates tool edit approval to the session approval controller', async () => {
    const approvalResult = { action: 'apply', appliedContent: 'B' } as const;
    const session = createTestSession();
    const { interactions, toolEditApprovals } = createInteractions({ session });
    toolEditApprovals.requestApproval.mockResolvedValue(approvalResult);
    const request = {
      path: 'paper.tex',
      originalContent: 'A',
      proposedContent: 'B',
      sourceTool: 'edit',
      streamId: STREAM_A,
    };

    await expect(interactions.requestToolEditApproval?.(request)).resolves.toBe(
      approvalResult,
    );
    expect(toolEditApprovals.requestApproval).toHaveBeenCalledWith(request);
  });
});
