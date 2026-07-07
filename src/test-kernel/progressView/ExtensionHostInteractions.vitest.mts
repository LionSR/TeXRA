import { describe, expect, it, vi } from 'vitest';

import { createExtensionHostInteractions } from '@progressView/extensionHostInteractions';
import type { OutputFileInfo, StreamTabId } from '@shared/schemas';
import type { ApprovalRequestHandlerSet } from '@shared/progressView/backend/progressBackendUiConfig';

const mocks = vi.hoisted(() => ({
  nativeRequestApproval: vi.fn(),
}));

vi.mock('@frontend/approval/nativeToolEditApproval', () => ({
  nativeRequestApproval: mocks.nativeRequestApproval,
}));

interface RecordingApprovalHandler<T extends { streamId: string }> {
  readonly show: ReturnType<typeof vi.fn>;
  readonly resolve: ReturnType<typeof vi.fn>;
  readonly replay: ReturnType<typeof vi.fn>;
  readonly get: ReturnType<typeof vi.fn>;
  readonly hasPendingForStream: ReturnType<typeof vi.fn>;
  readonly releaseForStream: ReturnType<typeof vi.fn>;
  readonly clear: ReturnType<typeof vi.fn>;
  readonly pendingSize: number;
}

function handler<
  T extends { streamId: string },
>(): RecordingApprovalHandler<T> {
  return {
    show: vi.fn(),
    resolve: vi.fn(),
    replay: vi.fn(),
    get: vi.fn(),
    hasPendingForStream: vi.fn(() => false),
    releaseForStream: vi.fn(),
    clear: vi.fn(),
    pendingSize: 0,
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

/** Reads the `requestId` passed to a handler's first `.show()` call. */
function firstShowRequestId(show: ReturnType<typeof vi.fn>): string {
  const requestId = (
    show.mock.calls[0]?.[0] as { requestId?: string } | undefined
  )?.requestId;
  if (!requestId) throw new Error('Expected a captured requestId.');
  return requestId;
}

function createInteractions(options?: {
  runtimeHost?: ReturnType<typeof createRuntimeHost>;
  handlers?: ApprovalRequestHandlerSet;
  removeStream?: (streamId: StreamTabId) => void;
  handleProgressEvent?: (event: unknown, payload: unknown) => void;
}) {
  const handleProgressEvent = options?.handleProgressEvent ?? (() => undefined);
  return createExtensionHostInteractions({
    runtimeHost: options?.runtimeHost ?? createRuntimeHost(),
    getApprovalHandlers: () => options?.handlers ?? createHandlers(),
    removeStream: options?.removeStream ?? (() => {}),
    handleProgressEvent: (event, payload) =>
      handleProgressEvent(event, payload),
  });
}

describe('createExtensionHostInteractions', () => {
  it('shows and resolves plan approvals through existing handlers', async () => {
    const runtimeHost = createRuntimeHost();
    const handlers = createHandlers();
    const interactions = createInteractions({
      runtimeHost,
      handlers,
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
    expect(runtimeHost.emit).toHaveBeenCalledWith('setActiveStream', {
      streamId: 'stream-a',
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

  it('cancels pending retry requests for a removed stream', async () => {
    const runtimeHost = createRuntimeHost();
    const handlers = createHandlers();
    const interactions = createInteractions({
      runtimeHost,
      handlers,
    });

    const resultPromise = interactions.requestRetry?.({
      streamId: 'stream-a' as StreamTabId,
      operation: 'Model invocation',
    });

    interactions.cancelForStream('stream-a' as StreamTabId);

    await expect(resultPromise).resolves.toEqual({ action: 'cancel' });
    expect(handlers.retry.resolve).toHaveBeenCalledWith('stream-a');
  });

  it('forwards a cancellation cause as bash reject feedback', async () => {
    const handlers = createHandlers();
    const interactions = createInteractions({ handlers });

    const resultPromise = interactions.requestBashApproval?.({
      command: 'rm -rf build',
      streamId: 'stream-a' as StreamTabId,
    });

    interactions.cancelForStream(
      'stream-a' as StreamTabId,
      'Stream resources released.',
    );

    await expect(resultPromise).resolves.toEqual({
      accepted: false,
      userMessage: 'Stream resources released.',
    });
    expect(handlers.bash.resolve).toHaveBeenCalled();
  });

  it('rejects a resolution whose kind does not match the pending request', async () => {
    const handlers = createHandlers();
    const interactions = createInteractions({ handlers });

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

  it('shows external inquiries without waiting for a user decision', async () => {
    const runtimeHost = createRuntimeHost();
    const handlers = createHandlers();
    const interactions = createInteractions({
      runtimeHost,
      handlers,
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

    interactions.cancelUnscoped?.('No stream owns this question.');

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
    const interactions = createInteractions();
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
    expect(mocks.nativeRequestApproval).toHaveBeenCalledWith(request);
  });

  it('handles extension removeStream requests through the progress lifecycle callback', () => {
    const removed: StreamTabId[] = [];
    const interactions = createInteractions({
      removeStream: (streamId) => removed.push(streamId),
    });

    expect(
      interactions.handleProgressEvent('removeStream', {
        streamId: 'child-a' as StreamTabId,
      }),
    ).toBe(true);
    expect(removed).toEqual(['child-a']);
  });

  it('routes backend progress events through the supplied callback', () => {
    const handleProgressEvent = vi.fn(
      (_event: unknown, _payload: unknown) => undefined,
    );
    const interactions = createInteractions({ handleProgressEvent });

    expect(
      interactions.handleProgressEvent('setActiveStream', {
        streamId: 'stream-a' as StreamTabId,
      }),
    ).toBe(true);

    expect(handleProgressEvent).toHaveBeenCalledWith('setActiveStream', {
      streamId: 'stream-a',
    });
  });

  it('leaves addOutputFiles to the session run-fact path', () => {
    const handleProgressEvent = vi.fn(
      (_event: unknown, _payload: unknown) => undefined,
    );
    const interactions = createInteractions({ handleProgressEvent });
    const outputFile: OutputFileInfo = {
      source: 'paper.tex',
      location: {
        kind: 'workspace',
        absolutePath: '/workspace/paper.tex',
        relativePath: 'paper.tex',
      },
      round: 1,
      lineage: null,
      diff: null,
    };

    expect(
      interactions.handleProgressEvent('addOutputFiles', {
        streamId: 'stream-a' as StreamTabId,
        filesByRound: { 1: [outputFile] },
      }),
    ).toBe(true);

    expect(handleProgressEvent).not.toHaveBeenCalled();
  });
});
