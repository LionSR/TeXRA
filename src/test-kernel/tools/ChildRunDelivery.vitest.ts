import { it } from '@effect/vitest';
import { Cause, Effect, Exit } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

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
import type { RunId, StreamTabId } from '@shared/schemas';

describe('child run delivery', () => {
  beforeEach(() => vi.clearAllMocks());

  it.effect('persists reports and result manifests', () =>
    Effect.gen(function* () {
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
      yield* persistChildRunDelivery(
        { commit: mocks.commit } as unknown as SessionHandle,
        'exec-1' as RunId,
        'payload',
        resultMeta,
      );
      expect(mocks.commit).toHaveBeenCalledWith([
        expect.objectContaining({
          type: 'execution.report',
          report: 'payload',
        }),
        expect.objectContaining({
          type: 'execution.result',
          result: resultMeta,
        }),
      ]);
    }),
  );

  it.effect('propagates persistence failures', () =>
    Effect.gen(function* () {
      const err = new Error('disk full');
      mocks.commit.mockReturnValue(Effect.die(err));
      const exit = yield* Effect.exit(
        persistChildRunDelivery(
          { commit: mocks.commit } as unknown as SessionHandle,
          'exec-1' as RunId,
          'payload',
          undefined,
        ),
      );
      expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toBe(
        err,
      );
    }),
  );

  it.effect('submits delivery and recovery as one operation', () =>
    Effect.gen(function* () {
      const session = { tag: 'owner' };
      mocks.submitFollowUp.mockReturnValue(
        Effect.succeed({ status: 'queued' }),
      );

      expect(
        yield* deliverChildRunFollowUp({
          targetStreamId: 'parent' as StreamTabId,
          followUp: { text: 'done', origin: 'subagent_result' },
          session: session as never,
        }),
      ).toEqual({ kind: 'delivered' });
      expect(mocks.submitFollowUp).toHaveBeenCalledWith(
        'parent',
        { text: 'done', origin: 'subagent_result' },
        {
          session,
          mode: 'child_delivery',
        },
      );
    }),
  );

  it.effect(
    'carries the refusal reason for a parent that did not accept delivery',
    () =>
      Effect.gen(function* () {
        const deliverToParent = (followUp: { text: string }) =>
          deliverChildRunFollowUp({
            targetStreamId: 'parent' as StreamTabId,
            followUp,
            session: {} as never,
          });

        mocks.submitFollowUp.mockReturnValueOnce(
          Effect.succeed({
            status: 'failed',
            reason: 'finished',
          }),
        );
        expect(yield* deliverToParent({ text: 'done' })).toEqual({
          kind: 'failed',
          reason: 'finished',
        });

        mocks.submitFollowUp.mockReturnValueOnce(
          Effect.succeed({
            status: 'failed',
            reason: 'not_resumable',
          }),
        );
        expect(yield* deliverToParent({ text: 'late' })).toEqual({
          kind: 'failed',
          reason: 'not_resumable',
        });
      }),
  );
});
