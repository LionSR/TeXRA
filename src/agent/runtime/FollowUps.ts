/**
 * The run's follow-up input: one Effect `Queue` per run, seeded from the
 * folded `followup.queued` rows that have no `followup.consumed`, the
 * blocking wait and the non-blocking drain, and `consume`, which commits one
 * batch's `followup.consumed` rows with the user message they become and
 * `flow.step turn.ready`, in one ledger transaction (C3). A crash before
 * that commit leaves the rows queued, so the next consumer's seed delivers
 * them again; after it, nothing re-delivers them.
 *
 * One batch enters the conversation as **one** user message carrying every
 * queued item as its own text part, not one message per item. The retired
 * engine appended a message per item and left each provider's handler to
 * merge them, because chat protocols reject consecutive user turns; the one
 * message is that merge, done once, where the row is written. The
 * provider-visible difference is the message count of a multi-item batch.
 *
 * A native child loop owns continuation across all of its turns; its inner
 * one-cycle loop reads that owner's queue without becoming a second consumer.
 */
import {
  Cause,
  Context,
  Effect,
  type FileSystem,
  Layer,
  SynchronizedRef,
} from 'effect';

import {
  followUpDisplay,
  userFollowUpInstruction,
} from '@agent/followUp/followUpMessages';
import {
  RunInput,
  type FollowUpBatch,
  type QueuedFollowUp,
} from '@agent/followUp/RunInput';
import { logUserMessage } from '@agent/trace';
import { mediaNeedsVisionWarning } from '@agent/runtime/mediaVisionWarning';
import type { MediaAttachmentKind } from '@shared/schemas';
import { RunLedger } from '@shared/session/runLedger';
import type { RunState } from '@shared/session/runStateFold';
import { ensureError } from '@utils/errors/errorMessage';

import { AgentRun } from './run/AgentRun';
import { type InputPart, mediaInputParts } from './run/mediaInput';
import {
  appendRow,
  rowAggregate,
  runtimeSnapshotRow,
  stepRow,
  type Message,
} from './loop/rows';

export interface ConsumedFollowUps {
  readonly state: RunState;
  /** The user instruction of the batch, when a user wrote one. */
  readonly instruction: string | undefined;
  readonly synthetic: boolean;
}

export class FollowUps extends Context.Service<
  FollowUps,
  {
    /**
     * Seed the run's queue from its folded state, once the loop has loaded
     * it: the follow-ups a crash or an unowned wait left queued.
     */
    readonly seed: (state: RunState | null) => void;
    readonly hasQueued: () => boolean;
    /** Queue one maintenance turn; a pending one is not duplicated. */
    readonly appendSynthetic: (text: string) => void;
    /** Block for the next batch; null when the queue was taken away. */
    readonly wait: Effect.Effect<FollowUpBatch | null>;
    /** Take a queued batch without blocking; null when none is queued. */
    readonly drain: Effect.Effect<FollowUpBatch | null>;
    /** Release the lease: keep the run recoverable, or end it. */
    readonly release: (next: 'recoverable' | 'terminal') => void;
    /**
     * Commit a batch: its `followup.consumed` rows, its user message, and
     * `flow.step turn.ready` in one transaction. On failure nothing is
     * consumed and the run's rows still queue the batch.
     */
    readonly consume: (
      state: RunState,
      batch: FollowUpBatch,
    ) => Effect.Effect<ConsumedFollowUps, Error, FileSystem.FileSystem>;
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
    // The queue exists before the lease is claimed: nothing yields between
    // the claim and the service that releases it.
    const created = yield* RunInput.make;
    const lease = manager.claimLive(runId, 'flow');
    const input = manager.attachInput(runId, created, lease);
    if (!input) {
      return yield* Effect.fail(
        new Error(
          `Follow-up continuation already has an owner for run ${runId}.`,
        ),
      );
    }
    let syntheticPending = false;

    const taken = (batch: FollowUpBatch | null) => {
      if (batch?.synthetic) syntheticPending = false;
      return batch;
    };

    /** The canonical user message of one batch: every item's text as its
     *  own part, media parts after the item they arrived with. */
    const batchMessage = Effect.fn('FollowUps.batchMessage')(function* (
      followUps: readonly QueuedFollowUp[],
    ): Effect.fn.Return<
      { message: Message; kinds: readonly MediaAttachmentKind[] },
      Error,
      FileSystem.FileSystem
    > {
      const bound = yield* SynchronizedRef.get(run.model);
      const parts: InputPart[] = [];
      const kinds: MediaAttachmentKind[] = [];
      for (const { content } of followUps) {
        parts.push({ kind: 'text', text: content.text });
        const files = content.mediaFiles;
        if (!files?.length) continue;
        const warning = mediaNeedsVisionWarning(
          files,
          bound.config.capabilities,
          'pasted',
        );
        if (warning) logger.warn(warning);
        const media = yield* mediaInputParts(
          files.map((path) => run.fileService.createLocation(path)),
          bound,
          logger,
          run.session.roots.config,
        );
        parts.push(...media.parts);
        kinds.push(...media.kinds);
      }
      return { message: { role: 'user', content: parts }, kinds };
    });

    const logFollowUps = (
      followUps: readonly QueuedFollowUp[],
      kinds: readonly MediaAttachmentKind[],
    ): void => {
      for (const { content } of followUps) {
        const display = followUpDisplay(content);
        logUserMessage(logger, display.text, kinds, display.workflowSummary);
      }
    };

    const consume = Effect.fn('FollowUps.consume')(function* (
      state: RunState,
      batch: FollowUpBatch,
    ): Effect.fn.Return<ConsumedFollowUps, Error, FileSystem.FileSystem> {
      const followUps = batch.synthetic ? [] : batch.followUps;
      const built = yield* Effect.exit(
        batch.synthetic
          ? Effect.succeed({
              message: {
                role: 'user',
                content: [{ kind: 'text', text: batch.text }],
              } satisfies Message,
              kinds: [],
            })
          : batchMessage(followUps),
      );
      if (built._tag === 'Failure') {
        logFollowUps(followUps, []);
        return yield* Effect.failCause(built.cause);
      }
      const committed = yield* Effect.exit(
        Effect.uninterruptible(
          ledger.appendBatch(runId, state, [
            ...followUps.map((followUp) => ({
              type: 'followup.consumed' as const,
              aggregateId: rowAggregate(runId),
              followUpId: followUp.followUpId,
            })),
            appendRow(runId, [built.value.message]),
            // The input that recovers a failed run clears the error fact in
            // the same transaction, so a resume taken between this batch and
            // the next turn's snapshot does not read the run as still failed.
            runtimeSnapshotRow(runId, state, { lastError: null }),
            stepRow(runId, state, 'turn.ready'),
          ]),
        ),
      );
      if (committed._tag === 'Failure') {
        return yield* Effect.fail(ensureError(Cause.squash(committed.cause)));
      }
      // The user's rows are durable; the transcript shows what was asked.
      logFollowUps(followUps, built.value.kinds);
      return {
        state: committed.value,
        instruction: userFollowUpInstruction(
          followUps.map((followUp) => followUp.content),
        ),
        synthetic: batch.synthetic,
      };
    });

    return {
      seed: (state) => input.seed(state?.followUps ?? [], state?.followUpIds),
      hasQueued: () => input.hasQueued(),
      appendSynthetic: (text) => {
        if (syntheticPending) return;
        syntheticPending = true;
        input.wake(text);
      },
      wait: Effect.map(input.take, taken),
      drain: Effect.map(input.poll, taken),
      release: (next) => {
        if (lease) manager.release(lease, next);
      },
      consume,
    };
  }),
);
