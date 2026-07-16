// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { afterEach, describe, expect, it, vi } from 'vitest';

const notifyMock = vi.hoisted(() => vi.fn());

vi.mock('@cli/chat/tui/notifications/terminalNotifier', () => ({
  notify: notifyMock,
}));

import { defaultSession } from '@agent/runtime/SessionHandle';
import {
  approvalPayloadStreamId,
  approvalQueueStatus,
  clearApprovals,
  clearApprovalsWhere,
  currentApproval,
  enqueueApproval,
  pendingApprovalSummaries,
  promoteApprovalsForStream,
  ROOT_APPROVAL_STREAM_KEY,
  type ApprovalPayload,
} from '@cli/chat/tui/state/approvalQueue';
import { enqueueTuiApproval } from '@cli/chat/tui/state/subscribeApprovals';
import type { StreamTabId } from '@shared/schemas';

function bashPayload(streamId: string): ApprovalPayload {
  return {
    kind: 'bash',
    payload: {
      requestId: `bash-${streamId}`,
      allowBypass: true,
      streamId,
      command: 'echo ok',
    },
  };
}

function externalInquiryPayload(streamId: string): ApprovalPayload {
  return {
    kind: 'externalInquiry',
    payload: {
      requestId: `external-${streamId}`,
      mode: 'followUp' as const,
      question: 'Please verify the finite enumeration independently.',
      threadId: 'ei_000000000001',
      allowBypass: false,
      streamId,
    },
  };
}

afterEach(() => {
  clearApprovals();
  notifyMock.mockClear();
});

describe('CLI approval queue', () => {
  it('activates each approval only when it becomes the foreground modal', async () => {
    const presented: string[] = [];
    const first = bashPayload('child-1');
    const second = bashPayload('child-2');

    const firstResult = enqueueApproval(first, {
      onPresent: () => presented.push('child-1'),
    });
    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload).toBe(first);
    });
    expect(presented).toEqual(['child-1']);

    const secondResult = enqueueApproval(second, {
      onPresent: () => presented.push('child-2'),
    });
    await Promise.resolve();
    expect(currentApproval.get()?.payload).toBe(first);
    expect(presented).toEqual(['child-1']);

    currentApproval.get()?.decide({ accepted: true });
    await expect(firstResult).resolves.toEqual({ accepted: true });
    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload).toBe(second);
    });
    expect(presented).toEqual(['child-1', 'child-2']);

    currentApproval.get()?.decide({ accepted: false });
    await expect(secondResult).resolves.toEqual({ accepted: false });
    expect(currentApproval.get()).toBeUndefined();
  });

  it('labels queued human-input prompts separately from approvals', async () => {
    const question = externalInquiryPayload('question-1');
    const questionResult = enqueueApproval(question);

    expect(approvalQueueStatus.get()).toEqual({
      depth: 1,
      kind: 'question',
    });
    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload).toBe(question);
    });

    currentApproval.get()?.decide({ accepted: true });
    await expect(questionResult).resolves.toEqual({ accepted: true });
    expect(approvalQueueStatus.get()).toEqual({
      depth: 0,
      kind: 'approval',
    });

    const approval = bashPayload('approval-1');
    const mixedQuestion = externalInquiryPayload('question-2');
    const approvalResult = enqueueApproval(approval);
    const mixedQuestionResult = enqueueApproval(mixedQuestion);

    expect(approvalQueueStatus.get()).toEqual({
      depth: 2,
      kind: 'request',
    });
    currentApproval.get()?.decide({ accepted: false });
    await expect(approvalResult).resolves.toEqual({ accepted: false });
    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload).toBe(mixedQuestion);
    });
    expect(approvalQueueStatus.get()).toEqual({
      depth: 1,
      kind: 'question',
    });

    currentApproval.get()?.decide({ accepted: false });
    await expect(mixedQuestionResult).resolves.toEqual({ accepted: false });
  });

  it('interrupts active and queued approvals without wedging the queue', async () => {
    const first = bashPayload('child-1');
    const second = bashPayload('child-2');
    const firstResult = enqueueApproval(first);
    const secondResult = enqueueApproval(second);

    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload).toBe(first);
    });
    expect(approvalQueueStatus.get()).toEqual({
      depth: 2,
      kind: 'approval',
    });

    clearApprovals();

    const interrupted = {
      accepted: false,
      userMessage: 'Session interrupted.',
    };
    await expect(firstResult).resolves.toEqual(interrupted);
    await expect(secondResult).resolves.toEqual(interrupted);
    expect(currentApproval.get()).toBeUndefined();
    expect(approvalQueueStatus.get()).toEqual({
      depth: 0,
      kind: 'approval',
    });

    const next = bashPayload('child-3');
    const nextResult = enqueueApproval(next);
    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload).toBe(next);
    });

    currentApproval.get()?.decide({ accepted: true });
    await expect(nextResult).resolves.toEqual({ accepted: true });

    const cancelledDuringPresentation = enqueueApproval(
      bashPayload('child-4'),
      { onPresent: clearApprovals },
    );
    await expect(cancelledDuringPresentation).resolves.toEqual(interrupted);
    expect(currentApproval.get()).toBeUndefined();
  });

  it('notifies only when a TUI approval becomes the foreground modal', async () => {
    const emit = vi.spyOn(defaultSession().events, 'emit');
    const first = bashPayload('child-1');
    const second = bashPayload('child-2');

    try {
      const firstResult = enqueueTuiApproval(first);
      await vi.waitFor(() => {
        expect(currentApproval.get()?.payload).toBe(first);
      });
      expect(emit).toHaveBeenNthCalledWith(1, {
        scope: 'session',
        event: {
          type: 'setActiveStream',
          payload: { streamId: 'child-1' },
        },
      });
      expect(notifyMock).toHaveBeenNthCalledWith(1, {
        kind: 'approvalNeeded',
      });

      const secondResult = enqueueTuiApproval(second);
      await Promise.resolve();
      expect(currentApproval.get()?.payload).toBe(first);
      expect(notifyMock).toHaveBeenCalledTimes(1);

      currentApproval.get()?.decide({ accepted: true });
      await expect(firstResult).resolves.toEqual({ accepted: true });
      await vi.waitFor(() => {
        expect(currentApproval.get()?.payload).toBe(second);
      });
      expect(emit).toHaveBeenNthCalledWith(2, {
        scope: 'session',
        event: {
          type: 'setActiveStream',
          payload: { streamId: 'child-2' },
        },
      });
      expect(notifyMock).toHaveBeenNthCalledWith(2, {
        kind: 'approvalNeeded',
      });

      currentApproval.get()?.decide({ accepted: false });
      await expect(secondResult).resolves.toEqual({ accepted: false });
    } finally {
      emit.mockRestore();
    }
  });

  it('extracts stream ids from every approval payload used by the TUI', () => {
    expect(approvalPayloadStreamId(bashPayload('child-bash'))).toBe(
      'child-bash',
    );
    expect(
      approvalPayloadStreamId({
        kind: 'toolEdit',
        payload: { streamId: 'child-edit' },
      } as ApprovalPayload),
    ).toBe('child-edit');
    expect(
      approvalPayloadStreamId({
        kind: 'retry',
        payload: { streamId: 'child-retry' },
      } as ApprovalPayload),
    ).toBe('child-retry');
    expect(
      approvalPayloadStreamId({
        kind: 'externalInquiry',
        payload: { streamId: '' },
      } as ApprovalPayload),
    ).toBeUndefined();
  });

  // Regression coverage for #7306: the per-stream cancel previously only cancelled
  // retry routes, leaving bash/tool-edit/plan/proposal/user-question requests
  // permanently pending on a stream-scoped interrupt. HostInteractions.cancel
  // now settles a stream via clearApprovalsWhere with a streamId predicate
  // (see subscribeApprovals.ts), so this exercises that same multi-kind clear.
  it('clears every pending kind for a stream via clearApprovalsWhere, leaving other streams alone', async () => {
    const planPayload = {
      kind: 'plan',
      payload: { approvalId: 'approval-1', streamId: 'stream-a' },
    } as ApprovalPayload;
    const staleForStreamA = bashPayload('stream-a');
    const untouched = bashPayload('stream-b');
    const presented: string[] = [];

    const planResult = enqueueApproval(planPayload, {
      onPresent: () => presented.push('plan'),
    });
    const staleResult = enqueueApproval(staleForStreamA, {
      onPresent: () => presented.push('stale'),
    });
    const untouchedResult = enqueueApproval(untouched, {
      onPresent: () => presented.push('untouched'),
    });

    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload).toBe(planPayload);
    });

    clearApprovalsWhere(
      (payload) => approvalPayloadStreamId(payload) === 'stream-a',
    );

    const interrupted = {
      accepted: false,
      userMessage: 'Session interrupted.',
    };
    await expect(planResult).resolves.toEqual(interrupted);
    await expect(staleResult).resolves.toEqual(interrupted);

    // stream-b was never touched and now becomes the foreground modal.
    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload).toBe(untouched);
    });
    expect(presented).toEqual(['plan', 'untouched']);
    currentApproval.get()?.decide({ accepted: true });
    await expect(untouchedResult).resolves.toEqual({ accepted: true });
  });

  it('summarizes pending items in global FIFO order, keying stream-less payloads to the root', async () => {
    enqueueApproval(bashPayload('child-1'));
    // Empty streamId is normalized to undefined by approvalPayloadStreamId,
    // so session-wide payloads carry the root stream key — interleaved here
    // to pin that consumers folding buckets still see first-to-present order.
    enqueueApproval(bashPayload(''));
    enqueueApproval(externalInquiryPayload('child-1'));
    enqueueApproval(bashPayload('child-2'));

    expect(pendingApprovalSummaries.get()).toEqual([
      { streamKey: 'child-1', kind: 'bash' },
      { streamKey: ROOT_APPROVAL_STREAM_KEY, kind: 'bash' },
      { streamKey: 'child-1', kind: 'externalInquiry' },
      { streamKey: 'child-2', kind: 'bash' },
    ]);

    clearApprovals();
    expect(pendingApprovalSummaries.get()).toEqual([]);
  });

  it('promotes a stream to the head without settling, resolving, or re-presenting', async () => {
    const presented: string[] = [];
    const first = bashPayload('child-1');
    const second = bashPayload('child-2');
    const firstResult = enqueueApproval(first, {
      onPresent: () => presented.push('child-1'),
    });
    const secondResult = enqueueApproval(second, {
      onPresent: () => presented.push('child-2'),
    });
    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload).toBe(first);
    });

    promoteApprovalsForStream('child-2' as StreamTabId);

    // The promoted item is foregrounded; nothing was settled or resolved.
    expect(currentApproval.get()?.payload).toBe(second);
    expect(approvalQueueStatus.get().depth).toBe(2);
    expect(presented).toEqual(['child-1', 'child-2']);

    // The summaries reflect the promoted order, so per-row suffixes agree
    // with what will present next.
    expect(pendingApprovalSummaries.get()).toEqual([
      { streamKey: 'child-2', kind: 'bash' },
      { streamKey: 'child-1', kind: 'bash' },
    ]);

    // Promoting an absent stream is a no-op.
    promoteApprovalsForStream('missing' as StreamTabId);
    expect(currentApproval.get()?.payload).toBe(second);

    // Settling the promoted head re-presents the demoted item — but its
    // presentation side effects do not fire a second time.
    currentApproval.get()?.decide({ accepted: true });
    await expect(secondResult).resolves.toEqual({ accepted: true });
    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload).toBe(first);
    });
    expect(presented).toEqual(['child-1', 'child-2']);

    currentApproval.get()?.decide({ accepted: false });
    await expect(firstResult).resolves.toEqual({ accepted: false });
  });

  it('promotes session-wide items together with the root stream when asked', async () => {
    const childItem = bashPayload('child-1');
    const sessionWide = bashPayload('');
    const rootItem = bashPayload('root');
    const childResult = enqueueApproval(childItem);
    const sessionWideResult = enqueueApproval(sessionWide);
    const rootResult = enqueueApproval(rootItem);
    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload).toBe(childItem);
    });

    promoteApprovalsForStream('root' as StreamTabId, {
      includeSessionWide: true,
    });

    // Session-wide and root items lead, preserving their relative order.
    expect(pendingApprovalSummaries.get()).toEqual([
      { streamKey: ROOT_APPROVAL_STREAM_KEY, kind: 'bash' },
      { streamKey: 'root', kind: 'bash' },
      { streamKey: 'child-1', kind: 'bash' },
    ]);
    expect(currentApproval.get()?.payload).toBe(sessionWide);

    currentApproval.get()?.decide({ accepted: true });
    await expect(sessionWideResult).resolves.toEqual({ accepted: true });
    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload).toBe(rootItem);
    });
    currentApproval.get()?.decide({ accepted: true });
    await expect(rootResult).resolves.toEqual({ accepted: true });
    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload).toBe(childItem);
    });
    currentApproval.get()?.decide({ accepted: false });
    await expect(childResult).resolves.toEqual({ accepted: false });
  });
});
