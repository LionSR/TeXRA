import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearApprovals,
  currentApproval,
  enqueueApproval,
  type ApprovalPayload,
} from '@cli/chat/tui/state/approvalQueue';
import { approvalPayloadStreamId } from '@cli/chat/tui/state/subscribeApprovals';

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

afterEach(() => {
  clearApprovals();
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
