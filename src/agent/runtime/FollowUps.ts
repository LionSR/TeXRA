/**
 * The run's follow-up input: the `followup.queued` rows that have no
 * `followup.consumed` (the session publisher's pending set), the blocking
 * wait and the non-blocking probe, and `consume`, which commits one batch's
 * `followup.consumed` rows with the user message they become and
 * `flow.step turn.ready`, in one ledger transaction (C3). A crash before
 * that commit leaves the rows queued, so the next consumer delivers them
 * again; after it, nothing re-delivers them.
 *
 * One batch enters the conversation as **one** user message carrying every
 * queued item as its own text part, not one message per item. The retired
 * engine appended a message per item and left each provider's handler to
 * merge them, because chat protocols reject consecutive user turns; the one
 * message is that merge, done once, where the row is written. The
 * provider-visible difference is the message count of a multi-item batch.
 *
 * A native child's delivery driver owns continuation while this service
 * reads its input in the same live run, without a second queue consumer.
 */
import {
  Context,
  Effect,
  type FileSystem,
  Layer,
  SynchronizedRef,
} from 'effect';

import {
  followUpDisplay,
  isInstruction,
  userFollowUpInstruction,
} from '@agent/followUp/followUpMessages';
import {
  FollowUpContinuationOwned,
  type FollowUpBatch,
} from '@agent/followUp/RunInput';
import { logUserMessage } from '@agent/trace';
import { mediaNeedsVisionWarning } from '@agent/runtime/mediaVisionWarning';
import type { MediaAttachmentKind, RunId } from '@shared/schemas';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';
import { subagentProgressRunId } from '@shared/subagentFollowup';
import { RunLedger } from '@shared/session/runLedger';
import type { QueuedFollowUp } from '@shared/session/runRows';
import type { RunLedgerDraft, RunState } from '@shared/session/runStateFold';

import { AgentRun } from './run/AgentRun';
import { type InputPart, mediaInputParts } from './run/mediaInput';
import {
  appendRow,
  rowAggregate,
  snapshotRow,
  stepRow,
  type Message,
} from './loop/rows';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

/** A batch as the rows that consume it, for a caller that commits them in
 *  its own batch; `delivered` logs them once durable and returns the user
 *  instruction they carry. */
export interface JoinedFollowUps {
  readonly rows: readonly RunLedgerDraft[];
  /** Whether the rows carry a message a turn answers. */
  readonly turn: boolean;
  readonly delivered: () => string | undefined;
}

export interface ConsumedFollowUps {
  readonly state: RunState;
  /** False when every item was a progress notice of an ended child: the
   *  batch was consumed without a message, and no turn follows. */
  readonly turn: boolean;
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
    readonly wait: Effect.Effect<FollowUpBatch | null>;
    /**
     * A run the user stopped (its last step a cancelled halt): the follow-up
     * batch queued for it, as rows the caller commits in its own transaction
     * so one request carries both. Null, without waiting, for any other run
     * or when no user follow-up is queued.
     */
    readonly joinStopped: (
      state: RunState,
    ) => Effect.Effect<
      JoinedFollowUps | null,
      Error,
      FileSystem.FileSystem | ChildProcessSpawner
    >;
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
    ) => Effect.Effect<
      ConsumedFollowUps,
      Error,
      FileSystem.FileSystem | ChildProcessSpawner
    >;
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
    // The lease is claimed at layer build and the layer scope releases it.
    // The run's settleRun arm decides recoverable-vs-terminal on every exit
    // after the run opened; this finalizer backstops the exits that never
    // reach it, because a failed acquire or a thrown attach releases nothing
    // under acquireUseRelease semantics, and the lease must not outlive the
    // scope that claimed it (the run-loop design,
    // .agents/docs/implemented/architecture/2026-09-21-effect-design-run-loop-programs.md).
    let released = false;
    const lease = yield* Effect.acquireRelease(
      Effect.sync(() => manager.claimLive(runId, 'flow')),
      (held) =>
        Effect.sync(() => {
          if (!released && held) {
            released = true;
            manager.release(held, 'recoverable');
          }
        }),
    );
    const input = manager.attachInput(runId, lease);
    if (!input) {
      return yield* new FollowUpContinuationOwned({
        message: `Follow-up continuation already has an owner for run ${runId}.`,
      });
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
      FileSystem.FileSystem | ChildProcessSpawner
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

    /** A progress notice whose child run has ended: stale once its child is
     *  terminal, so it is consumed without becoming a message. Results and
     *  errors always deliver. */
    const endedChildProgress = ({ content }: QueuedFollowUp): boolean => {
      const child =
        content.from.kind === 'run' && content.from.relation === 'child'
          ? subagentProgressRunId(content.text)
          : undefined;
      return (
        child !== undefined &&
        isTerminalOutcomePhase(session.runView(child as RunId)?.status)
      );
    };

    const logFollowUps = (
      followUps: readonly QueuedFollowUp[],
      kinds: readonly MediaAttachmentKind[],
    ): void => {
      for (const { content } of followUps) {
        const display = followUpDisplay(content);
        logUserMessage(logger, display.text, kinds, display.workflowSummary);
      }
    };

    /** The rows that consume one batch: its `followup.consumed` rows and
     *  the one user message they become. */
    const batchRows = Effect.fn('FollowUps.batchRows')(function* (
      batch: FollowUpBatch,
    ): Effect.fn.Return<
      JoinedFollowUps,
      Error,
      FileSystem.FileSystem | ChildProcessSpawner
    > {
      const all = batch.synthetic ? [] : batch.followUps;
      const followUps = all.filter((followUp) => !endedChildProgress(followUp));
      const turn = batch.synthetic || followUps.length > 0;
      const built = yield* (
        batch.synthetic
          ? Effect.succeed({
              message: {
                role: 'user',
                content: [{ kind: 'text', text: batch.text }],
              } satisfies Message,
              kinds: [],
            })
          : batchMessage(followUps)
      ).pipe(
        Effect.tapCause(() => Effect.sync(() => logFollowUps(followUps, []))),
      );
      if (all.length > followUps.length) {
        logger.debug(
          `Consumed ${all.length - followUps.length} progress notice(s) of ended subagents without delivering them.`,
        );
      }
      return {
        turn,
        rows: [
          ...all.map((followUp) => ({
            type: 'followup.consumed' as const,
            aggregateId: rowAggregate(runId),
            followUpId: followUp.followUpId,
          })),
          ...(turn ? [appendRow(runId, [built.message])] : []),
        ],
        // The user's rows are durable; the transcript shows what was asked.
        delivered: () => {
          logFollowUps(followUps, built.kinds);
          return userFollowUpInstruction(
            followUps.map((followUp) => followUp.content),
          );
        },
      };
    });

    const consume = Effect.fn('FollowUps.consume')(function* (
      state: RunState,
      batch: FollowUpBatch,
    ): Effect.fn.Return<
      ConsumedFollowUps,
      Error,
      FileSystem.FileSystem | ChildProcessSpawner
    > {
      const joined = yield* batchRows(batch);
      const committed = yield* Effect.uninterruptible(
        ledger.appendBatch(runId, state, [
          ...joined.rows,
          // The input that recovers a failed run clears the error fact in
          // the same transaction, so a resume taken between this batch and
          // the next turn's snapshot does not read the run as still failed.
          ...(joined.turn
            ? [
                snapshotRow(runId, state, { runtime: { lastError: null } }),
                stepRow(runId, state, 'turn.ready'),
              ]
            : []),
        ]),
      );
      return {
        state: committed,
        turn: joined.turn,
        instruction: joined.delivered(),
        synthetic: batch.synthetic,
      };
    });

    return {
      hasQueued: () => input.hasQueued(),
      appendSynthetic: (text) => {
        if (syntheticPending) return;
        syntheticPending = true;
        input.wake(text);
      },
      wait: Effect.map(input.take, taken),
      joinStopped: (state) =>
        state.step === 'halted' &&
        // Only a user stop joins: that halt carries no error fact to clear and
        // no turn.ready row to write, which is why the join skips `consume`'s.
        state.outcome === 'cancelled' &&
        input.hasQueued() &&
        !syntheticPending
          ? Effect.flatMap(input.take, (batch) => {
              // `!syntheticPending`: no maintenance wake is queued, so this
              // take is follow-ups, which stay queued until consumed, and a
              // declined batch is left for the ordinary wait.
              if (batch?.synthetic) {
                return Effect.die(
                  new Error('joinStopped took a wake none was pending.'),
                );
              }
              return batch === null ||
                !batch.followUps.some((f) => isInstruction(f.content))
                ? Effect.succeed(null)
                : batchRows(batch);
            })
          : Effect.succeed(null),
      release: (next) => {
        if (released || !lease) return;
        released = true;
        manager.release(lease, next);
      },
      consume,
    };
  }),
);
