/**
 * The run's follow-up input: a lease over the session's queue for this run,
 * the blocking wait and the non-blocking drain, and `consume`, which commits
 * one drained batch as canonical user rows plus `flow.step turn.ready` in one
 * ledger transaction. A batch whose rows fail to commit goes back on the
 * queue, so lost input is never acknowledged.
 *
 * A native child loop owns continuation across all of its turns; its inner
 * one-cycle loop uses that queue without becoming a second consumer.
 */
import { Cause, Context, Effect, Layer, SynchronizedRef } from 'effect';

import {
  followUpDisplay,
  userFollowUpInstruction,
} from '@agent/followUp/followUpMessages';
import type {
  FollowUpQueue,
  FollowUpQueueBatch,
  FollowUpQueueBatchItem,
} from '@agent/followUp/FollowUpQueue';
import type { FollowUpConsumerLease } from '@agent/followUp/ToolUseFollowUpQueueManager';
import { logUserMessage } from '@agent/trace';
import { mediaNeedsVisionWarning } from '@agent/runtime/mediaVisionWarning';
import type { MediaAttachmentKind } from '@shared/schemas';
import { RunLedger } from '@shared/session/runLedger';
import type { RunState } from '@shared/session/runStateFold';
import { ensureError } from '@utils/errors/errorMessage';

import { AgentRun } from './run/AgentRun';
import { type InputPart, mediaInputParts } from './run/mediaInput';
import { appendRow, stepRow, type Message } from './loop/rows';

export interface ConsumedFollowUps {
  readonly state: RunState;
  /** The user instruction of the batch, when a user wrote one. */
  readonly instruction: string | undefined;
  readonly synthetic: boolean;
}

export class FollowUps extends Context.Service<
  FollowUps,
  {
    readonly hasQueued: () => boolean;
    /** Queue one maintenance turn; a pending one is not duplicated. */
    readonly appendSynthetic: (text: string) => void;
    /** Block for the next batch; null when the queue was taken away. */
    readonly wait: Effect.Effect<FollowUpQueueBatch | null>;
    /** Take a queued batch without blocking; null when none is queued. */
    readonly drain: Effect.Effect<FollowUpQueueBatch | null>;
    /** Whether a blocking wait ended because the queue was disposed. */
    readonly parkedWaitCancelled: () => boolean;
    /** Cancel an in-flight wait; `clear` also drops queued input, honoured
     *  only while this run holds the consumer lease. */
    readonly interrupt: (queue: 'clear' | 'preserve') => void;
    /** Release the lease: keep queued data for a successor, or end it. */
    readonly release: (next: 'recoverable' | 'terminal') => void;
    /**
     * Commit a batch: its user message rows and `flow.step turn.ready` in one
     * transaction. On failure the batch returns to the queue unconsumed.
     */
    readonly consume: (
      state: RunState,
      batch: FollowUpQueueBatch,
    ) => Effect.Effect<ConsumedFollowUps, Error>;
  }
>()('@texra/agent/FollowUps') {}

export const followUpsLayer: Layer.Layer<
  FollowUps,
  Error,
  AgentRun | RunLedger
> = Layer.effect(
  FollowUps,
  Effect.gen(function* () {
    const run = yield* AgentRun;
    const ledger = yield* RunLedger;
    const { runId, session, logger } = run;
    const manager = session.followUps;
    let lease: FollowUpConsumerLease | undefined;
    let queue: FollowUpQueue;
    const claimed = manager.claimLive(runId, 'flow');
    if (claimed) {
      lease = claimed;
      queue = manager.queue(claimed);
    } else {
      const borrowed = manager.externallyOwnedQueue(runId);
      if (!borrowed) {
        return yield* Effect.fail(
          new Error(
            `Follow-up continuation already has an owner for run ${runId}.`,
          ),
        );
      }
      queue = borrowed;
    }
    let syntheticPending = false;
    let waitCancelled = false;

    const wait = Effect.scoped(
      Effect.gen(function* () {
        const signal = yield* Effect.abortSignal;
        const batch = yield* Effect.promise(() =>
          queue.waitAndDrainAll(signal),
        );
        if (batch === null && !signal.aborted) waitCancelled = true;
        if (batch?.synthetic) syntheticPending = false;
        return batch;
      }),
    );
    const drain = Effect.suspend(() =>
      queue.isEmpty() ? Effect.succeed(null) : wait,
    );

    /** The canonical user message of one batch: every item's text as its
     *  own part, media parts after the item they arrived with. */
    const batchMessage = Effect.fn('FollowUps.batchMessage')(function* (
      items: readonly FollowUpQueueBatchItem[],
    ): Effect.fn.Return<
      { message: Message; kinds: readonly MediaAttachmentKind[] },
      Error
    > {
      const bound = yield* SynchronizedRef.get(run.model);
      const parts: InputPart[] = [];
      const kinds: MediaAttachmentKind[] = [];
      for (const item of items) {
        parts.push({ kind: 'text', text: item.text });
        const files = item.mediaFiles;
        if (!files?.length) continue;
        const warning = mediaNeedsVisionWarning(
          files,
          bound.config.capabilities,
          'pasted',
        );
        if (warning) logger.warn(warning);
        const media = yield* mediaInputParts(
          run.inScope(() =>
            files.map((path) => run.fileService.createLocation(path)),
          ),
          bound,
          logger,
          run.inScope,
        );
        parts.push(...media.parts);
        kinds.push(...media.kinds);
      }
      return { message: { role: 'user', content: parts }, kinds };
    });

    /** Return an unconsumed batch to the queue, synthetic or visible. */
    const restore = (batch: FollowUpQueueBatch): void => {
      if (batch.synthetic) {
        for (const item of batch.items) queue.enqueueSynthetic(item.text);
        syntheticPending = true;
        return;
      }
      queue.restore(
        batch.items.filter(
          (
            item,
          ): item is FollowUpQueueBatchItem & {
            origin: 'user' | 'subagent_result';
          } => item.origin !== 'synthetic',
        ),
      );
    };

    const consume = Effect.fn('FollowUps.consume')(function* (
      state: RunState,
      batch: FollowUpQueueBatch,
    ): Effect.fn.Return<ConsumedFollowUps, Error> {
      const built = yield* Effect.exit(batchMessage(batch.items));
      if (built._tag === 'Failure') {
        restore(batch);
        if (!batch.synthetic) {
          for (const item of batch.items) {
            const display = followUpDisplay(item);
            logUserMessage(logger, display.text, [], display.workflowSummary);
          }
        }
        return yield* Effect.failCause(built.cause);
      }
      const committed = yield* Effect.exit(
        Effect.uninterruptible(
          ledger.appendBatch(runId, state, [
            appendRow(runId, [built.value.message]),
            stepRow(runId, state, 'turn.ready'),
          ]),
        ),
      );
      if (committed._tag === 'Failure') {
        restore(batch);
        return yield* Effect.fail(ensureError(Cause.squash(committed.cause)));
      }
      // The user's rows are durable; the transcript shows what was asked.
      if (!batch.synthetic) {
        for (const item of batch.items) {
          const display = followUpDisplay(item);
          logUserMessage(
            logger,
            display.text,
            built.value.kinds,
            display.workflowSummary,
          );
        }
        run.callbacks.onFollowUpConsumed?.();
      }
      return {
        state: committed.value,
        instruction: batch.synthetic
          ? undefined
          : userFollowUpInstruction(batch.items),
        synthetic: batch.synthetic,
      };
    });

    return {
      hasQueued: () => !queue.isEmpty(),
      appendSynthetic: (text) => {
        if (syntheticPending) return;
        syntheticPending = true;
        queue.enqueueSynthetic(text);
      },
      wait,
      drain,
      parkedWaitCancelled: () => waitCancelled,
      interrupt: (mode) => {
        syntheticPending = false;
        if (mode === 'clear' && lease) {
          queue.dispose();
          return;
        }
        queue.cancelWait();
      },
      release: (next) => {
        if (lease) manager.release(lease, next);
      },
      consume,
    };
  }),
);
