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
    expect(interactions.pending()).toEqual([
      { id: 'plan-a', kind: 'plan', streamId: 'stream-a' },
    ]);

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
    expect(interactions.pending()).toEqual([]);
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
    expect(interactions.pending()).toEqual([]);
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

    await expect(resultPromise).resolves.toEqual({ submitted: false });
    expect(handlers.userQuestion.resolve).toHaveBeenCalledWith('question-a');
    expect(interactions.pending()).toEqual([]);
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
