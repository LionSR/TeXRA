import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResultMeta } from '@agent/storage';

const mocks = vi.hoisted(() => ({
  writeResultMeta: vi.fn(),
  writeReport: vi.fn(),
  submitFollowUp: vi.fn(),
}));

vi.mock('@agent/storage/ExecutionKVStore', () => ({
  getExecutionStore: vi.fn(() => ({
    writeReport: mocks.writeReport,
    writeResultMeta: mocks.writeResultMeta,
  })),
}));

vi.mock('@agent/followUp/ToolUseFollowUp', () => ({
  submitFollowUp: mocks.submitFollowUp,
}));

import { deliverChildRunFollowUp } from '@agent/followUp/childRunDelivery';
import {
  persistChildRunReport,
  persistChildRunResultMeta,
} from '@agent/storage/childRunPersistence';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

describe('child run delivery', () => {
  beforeEach(() => vi.clearAllMocks());

  it('persists reports and result manifests', async () => {
    const resultMeta = {
      producer: 'subagent',
      agentName: 'review',
      wallTimeMs: 1,
      result: {
        category: 'toolUse',
        outcome: 'completed',
        response: 'done',
        files: [],
        cost: 0,
      },
    } satisfies ResultMeta;

    await persistChildRunReport('exec-1' as ExecutionId, 'payload');
    await persistChildRunResultMeta('exec-1' as ExecutionId, resultMeta);
    expect(mocks.writeReport).toHaveBeenCalledWith('payload');
    expect(mocks.writeResultMeta).toHaveBeenCalledWith(resultMeta);
  });

  it('propagates persistence failures', async () => {
    const err = new Error('disk full');
    mocks.writeReport.mockRejectedValue(err);
    await expect(
      persistChildRunReport('exec-1' as ExecutionId, 'payload'),
    ).rejects.toBe(err);
  });

  it('submits delivery and recovery as one operation', async () => {
    const session = { tag: 'owner' };
    mocks.submitFollowUp.mockResolvedValue({ status: 'queued' });

    await expect(
      deliverChildRunFollowUp({
        targetStreamId: 'parent' as StreamTabId,
        followUp: { text: 'done', origin: 'subagent_result' },
        session: session as never,
      }),
    ).resolves.toEqual({ kind: 'delivered' });
    expect(mocks.submitFollowUp).toHaveBeenCalledWith(
      'parent',
      { text: 'done', origin: 'subagent_result' },
      {
        session,
        mode: 'child_delivery',
      },
    );
  });

  it('carries the refusal reason for a parent that did not accept delivery', async () => {
    function deliverToParent(followUp: {
      text: string;
    }): ReturnType<typeof deliverChildRunFollowUp> {
      return deliverChildRunFollowUp({
        targetStreamId: 'parent' as StreamTabId,
        followUp,
        session: {} as never,
      });
    }

    mocks.submitFollowUp.mockResolvedValueOnce({
      status: 'failed',
      reason: 'finished',
    });
    await expect(deliverToParent({ text: 'done' })).resolves.toEqual({
      kind: 'failed',
      reason: 'finished',
    });

    mocks.submitFollowUp.mockResolvedValueOnce({
      status: 'failed',
      reason: 'not_resumable',
    });
    await expect(deliverToParent({ text: 'late' })).resolves.toEqual({
      kind: 'failed',
      reason: 'not_resumable',
    });
  });
});
