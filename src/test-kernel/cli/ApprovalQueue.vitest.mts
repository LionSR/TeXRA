import { afterEach, describe, expect, it, vi } from 'vitest';

const notifyMock = vi.hoisted(() => vi.fn());
const runtimeApprovalMocks = vi.hoisted(() => ({
  applyRuntimeApprovalDecisionBypass: vi.fn(),
  resolveRuntimeBashApproval: vi.fn(),
  setRuntimeToolEditApprovalHandler: vi.fn(),
}));
const runtimeCoordinatorMocks = vi.hoisted(() => ({
  cancelRuntimeRetry: vi.fn(),
  resolveRuntimePlanApproval: vi.fn(),
  resolveRuntimeProposal: vi.fn(),
  triggerRuntimeRetry: vi.fn(),
}));
const apiModeMock = vi.hoisted(() => ({
  setCliApiMode: vi.fn(),
}));
const codexSubscriptionMock = vi.hoisted(() => ({
  setCliCodexSubscription: vi.fn(),
}));

vi.mock('@cli/chat/tui/notifications/terminalNotifier', () => ({
  notify: notifyMock,
}));
vi.mock('@agent/runtime/approvalCommands', () => runtimeApprovalMocks);
vi.mock('@agent/runtime/runCoordinatorCommands', () => runtimeCoordinatorMocks);
vi.mock('@cli/runtime/apiAccessMode', () => apiModeMock);
vi.mock('@cli/chat/tui/state/codexSubscription', () => codexSubscriptionMock);

import {
  approvalPayloadStreamId,
  approvalQueueStatus,
  clearApprovals,
  clearApprovalsForStream,
  currentApproval,
  enqueueApproval,
  type ApprovalPayload,
} from '@cli/chat/tui/state/approvalQueue';
import {
  enqueueTuiApproval,
  installTuiApprovals,
} from '@cli/chat/tui/state/subscribeApprovals';
import type { CliContext } from '@cli/runtime/cliContext';
import type { CliRuntimeHost } from '@cli/runtime/runtimeHost';

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
      question: 'Please verify the finite enumeration independently.',
      threadId: `thread-${streamId}`,
      allowBypass: false,
      streamId,
    },
  };
}

afterEach(() => {
  clearApprovals();
  notifyMock.mockClear();
  vi.clearAllMocks();
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
  });

  it('clears only queued approvals for the requested stream', async () => {
    const root = bashPayload('root-stream');
    const child = bashPayload('child-stream');
    const rootResult = enqueueApproval(root);

    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload).toBe(root);
    });
    const childResult = enqueueApproval(child);

    clearApprovalsForStream('child-stream');

    await expect(childResult).resolves.toEqual({
      accepted: false,
      userMessage: 'Session interrupted.',
    });
    expect(currentApproval.get()?.payload).toBe(root);
    expect(approvalQueueStatus.get()).toEqual({
      depth: 1,
      kind: 'approval',
    });

    currentApproval.get()?.decide({ accepted: true });
    await expect(rootResult).resolves.toEqual({ accepted: true });
  });

  it('clears an active stream approval without blocking later approvals', async () => {
    const child = bashPayload('child-stream');
    const root = bashPayload('root-stream');
    const childResult = enqueueApproval(child);

    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload).toBe(child);
    });
    const rootResult = enqueueApproval(root);

    clearApprovalsForStream('child-stream');

    await expect(childResult).resolves.toEqual({
      accepted: false,
      userMessage: 'Session interrupted.',
    });
    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload).toBe(root);
    });

    currentApproval.get()?.decide({ accepted: true });
    await expect(rootResult).resolves.toEqual({ accepted: true });
  });

  it('notifies only when a TUI approval becomes the foreground modal', async () => {
    const host = { emit: vi.fn() } as unknown as CliRuntimeHost;
    const first = bashPayload('child-1');
    const second = bashPayload('child-2');

    const firstResult = enqueueTuiApproval(first, host);
    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload).toBe(first);
    });
    expect(host.emit).toHaveBeenNthCalledWith(1, 'setActiveStream', {
      streamId: 'child-1',
    });
    expect(notifyMock).toHaveBeenNthCalledWith(1, {
      kind: 'approvalNeeded',
    });

    const secondResult = enqueueTuiApproval(second, host);
    await Promise.resolve();
    expect(currentApproval.get()?.payload).toBe(first);
    expect(notifyMock).toHaveBeenCalledTimes(1);

    currentApproval.get()?.decide({ accepted: true });
    await expect(firstResult).resolves.toEqual({ accepted: true });
    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload).toBe(second);
    });
    expect(host.emit).toHaveBeenNthCalledWith(2, 'setActiveStream', {
      streamId: 'child-2',
    });
    expect(notifyMock).toHaveBeenNthCalledWith(2, {
      kind: 'approvalNeeded',
    });

    currentApproval.get()?.decide({ accepted: false });
    await expect(secondResult).resolves.toEqual({ accepted: false });
  });

  it('applies subscription-off retry decisions before retrying', async () => {
    const order: string[] = [];
    apiModeMock.setCliApiMode.mockImplementation(async () => {
      order.push('api-mode');
    });
    codexSubscriptionMock.setCliCodexSubscription.mockImplementation(
      async () => {
        order.push('subscription');
      },
    );
    runtimeCoordinatorMocks.triggerRuntimeRetry.mockImplementation(() => {
      order.push('retry');
    });
    const host = { emit: vi.fn() } as unknown as CliRuntimeHost;
    const context = {
      approvalPolicy: 'ask',
      mode: 'interactive',
    } as CliContext;
    const uninstall = installTuiApprovals(host, context);

    host.emit('showRetryRequest', {
      streamId: 'stream-retry',
      operation: 'model call',
      errorMessage: 'ChatGPT subscription limit reached.',
    });
    await vi.waitFor(() => {
      expect(currentApproval.get()?.payload.kind).toBe('retry');
    });

    currentApproval.get()?.decide({
      accepted: true,
      apiMode: 'personal',
      disableChatGptSubscription: true,
      userMessage: 'Use API key and retry.',
    });
    await vi.waitFor(() => {
      expect(runtimeCoordinatorMocks.triggerRuntimeRetry).toHaveBeenCalledWith({
        streamId: 'stream-retry',
        feedback: 'Use API key and retry.',
      });
    });

    expect(apiModeMock.setCliApiMode).toHaveBeenCalledWith('personal');
    expect(codexSubscriptionMock.setCliCodexSubscription).toHaveBeenCalledWith(
      false,
    );
    expect(order).toEqual(['api-mode', 'subscription', 'retry']);

    uninstall();
  });

  it('extracts stream ids from every approval payload used by the TUI', () => {
    expect(approvalPayloadStreamId(bashPayload('child-bash'))).toBe(
      'child-bash',
    );
    expect(
      approvalPayloadStreamId({
        kind: 'toolEdit',
        request: { streamId: 'child-edit' },
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
});
