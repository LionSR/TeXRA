import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResultMeta } from '@agent/storage';

const mocks = vi.hoisted(() => ({
  commit: vi.fn(),
  submitFollowUp: vi.fn(),
}));

vi.mock('@agent/followUp/ToolUseFollowUp', () => ({
  submitFollowUp: mocks.submitFollowUp,
}));

import { deliverChildRunFollowUp } from '@agent/followUp/childRunDelivery';
import { persistChildRunDelivery } from '@agent/storage/childRunDeliveryPersistence';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { RunId } from '@shared/schemas';

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

    mocks.commit.mockReturnValue(Effect.succeed([]));
    await Effect.runPromise(
      persistChildRunDelivery(
        { commit: mocks.commit } as unknown as SessionHandle,
        'exec-1' as RunId,
        'payload',
        resultMeta,
      ),
    );
    expect(mocks.commit).toHaveBeenCalledWith([
      expect.objectContaining({ type: 'run.report', report: 'payload' }),
      expect.objectContaining({ type: 'run.result', result: resultMeta }),
    ]);
  });

  it('propagates persistence failures', async () => {
    const err = new Error('disk full');
    mocks.commit.mockReturnValue(Effect.die(err));
    await expect(
      Effect.runPromise(
        persistChildRunDelivery(
          { commit: mocks.commit } as unknown as SessionHandle,
          'exec-1' as RunId,
          'payload',
          undefined,
        ),
      ),
    ).rejects.toBe(err);
  });

  it('submits delivery and recovery as one operation', async () => {
    const session = { tag: 'owner' };
    mocks.submitFollowUp.mockReturnValue(Effect.succeed({ status: 'queued' }));

    await expect(
      Effect.runPromise(
        deliverChildRunFollowUp({
          targetRunId: 'parent' as RunId,
          followUp: { text: 'done', origin: 'subagent_result' },
          session: session as never,
        }),
      ),
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
    }): Promise<Effect.Success<ReturnType<typeof deliverChildRunFollowUp>>> {
      return Effect.runPromise(
        deliverChildRunFollowUp({
          targetRunId: 'parent' as RunId,
          followUp,
          session: {} as never,
        }),
      );
    }

    mocks.submitFollowUp.mockReturnValueOnce(
      Effect.succeed({
        status: 'failed',
        reason: 'finished',
      }),
    );
    await expect(deliverToParent({ text: 'done' })).resolves.toEqual({
      kind: 'failed',
      reason: 'finished',
    });

    mocks.submitFollowUp.mockReturnValueOnce(
      Effect.succeed({
        status: 'failed',
        reason: 'not_resumable',
      }),
    );
    await expect(deliverToParent({ text: 'late' })).resolves.toEqual({
      kind: 'failed',
      reason: 'not_resumable',
    });
  });
});
