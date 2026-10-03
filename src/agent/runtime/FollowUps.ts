/**
 * The run's follow-up input: the `followup.queued` rows that have no
 * `followup.consumed` (the session publisher's pending set), the blocking
 * wait and the non-blocking probe, and `consume`, which commits one batch's
 * `followup.consumed` rows with the user message they become and
 * `run.position turn.ready`, in one run history transaction (C3). A crash before
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
 *
 * The run's conversation claims it for itself (`claimFollowUps`, from its
 * own `AgentRun`); it is never a context service. A child launched from a
 * parent's tool call runs in that call's fiber, so a context service would
 * hand the child its parent's input: a round-mode child that settled it
 * ended the parent's lease, and the parked parent halted cancelled.
 */
import { randomUUID } from 'node:crypto';

import {
  Deferred,
  Effect,
  Exit,
  type FileSystem,
  type Scope,
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
  type ViewEdit,
} from '@agent/followUp/RunInput';
import { logUserMessage } from '@agent/trace';
import { mediaNeedsVisionWarning } from '@agent/runtime/mediaVisionWarning';
import {
  ACTIVATED_SKILLS_MAX,
  type MediaAttachmentKind,
  type RunId,
} from '@shared/schemas';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';
import { subagentProgressRunId } from '@shared/subagentFollowup';
import type { RunHistory } from '@shared/session/runHistory';
import type { QueuedFollowUp } from '@shared/session/runRows';
import type { RunHistoryDraft, RunState } from '@shared/session/runStateFold';

import { activatedSkillNames } from '@skills/runtimeSkills';
import { sha256 } from '@tools/catalogEntries';
import { type InputPart, mediaInputParts } from './run/mediaInput';

import { blobRows } from './run/requestContext';
import {
  appendRow,
  rowAggregate,
  snapshotRow,
  positionRow,
  type Message,
  type ToolUseLoopState,
} from './loop/rows';
import { promptHooks } from './loop/hooks';
import { resolveActivations } from './loop/step';
import type { AgentRunShape } from './run/AgentRun';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

/** A batch as the rows that consume it, for a caller that commits them in
 *  its own batch with a snapshot carrying `recorded`, the address of the
 *  instruction they store and the activated skills' names: the one record
 *  of what the
 *  delivery changes. `delivered` logs them once durable. */
export interface JoinedFollowUps {
  readonly rows: readonly RunHistoryDraft[];
  readonly recorded: Partial<
    Pick<ToolUseLoopState, 'instruction' | 'activated'>
  >;
  /** Whether the rows carry a message a turn answers. */
  readonly turn: boolean;
  readonly delivered: () => void;
}

export interface ConsumedFollowUps {
  readonly state: RunState;
  /** False when every item was a progress notice of an ended child: the
   *  batch was consumed without a message, and no turn follows. */
  readonly turn: boolean;
}

export interface FollowUps {
  readonly hasQueued: () => boolean;
  /** Queue one maintenance turn; a pending one is not duplicated. */
  readonly appendSynthetic: (text: string) => void;
  /** Queue a view edit, taken at the loop's next park before any input:
   *  false while another is queued or once the input has ended. */
  readonly editView: (edit: ViewEdit) => boolean;
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
   * `run.position turn.ready` in one transaction. On failure nothing is
   * consumed and the run's rows still queue the batch. A view edit commits
   * its `context.edit`, and a handoff's note as the message, the same way,
   * and settles the edit's `done` with the commit.
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

/** Claim `run`'s own follow-up input for the enclosing scope. */
export const claimFollowUps = Effect.fn('FollowUps.claim')(function* (
  run: AgentRunShape,
  runHistory: RunHistory['Service'],
): Effect.fn.Return<FollowUps, Error, Scope.Scope> {
  const { runId, session, logger } = run;
  const manager = session.followUps;
  // The lease is claimed here and the caller's scope releases it.
  // The run's settleRun arm decides recoverable-vs-terminal on every exit
  // after the run opened; this finalizer backstops the exits that never
  // reach it, because a failed acquire or a thrown attach releases nothing
  // under acquireUseRelease semantics, and the lease must not outlive the
  // scope that claimed it (the run-loop design,
  // .agents/docs/implemented/architecture/2026-09-21-effect-design-run-loop-programs.md).
  let released = false;
  const lease = yield* Effect.acquireRelease(
    Effect.sync(() => manager.claimLive(runId, 'loop')),
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
    if (batch?.kind === 'synthetic') syntheticPending = false;
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
      logUserMessage(logger, display.text, kinds, display.scriptSummary);
    }
  };

  /** The rows that consume one batch: its `followup.consumed` rows, the one
   *  user message they become, and the instruction and skill activations
   *  they carry, stored in the same batch so the snapshot that names them
   *  never outlives them. */
  const batchRows = Effect.fn('FollowUps.batchRows')(function* (
    state: RunState,
    batch: FollowUpBatch,
  ): Effect.fn.Return<
    JoinedFollowUps,
    Error,
    FileSystem.FileSystem | ChildProcessSpawner
  > {
    const all = batch.kind === 'followUps' ? batch.followUps : [];
    const edit = batch.kind === 'edit' ? batch.edit : null;
    // A handoff's note is what its user typed, delivered as their follow-up
    // is, in the batch that resets the view: no row ever queued it.
    const handedOff: QueuedFollowUp[] =
      edit?.handoff == null
        ? []
        : [
            {
              followUpId: randomUUID(),
              content: { text: edit.handoff, from: { kind: 'user' } },
            },
          ];
    const followUps = [
      ...handedOff,
      ...all.filter((followUp) => !endedChildProgress(followUp)),
    ];
    const turn = batch.kind === 'synthetic' || followUps.length > 0;
    const built = yield* (
      batch.kind === 'synthetic'
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
    const instruction = userFollowUpInstruction(
      followUps.map((followUp) => followUp.content),
    );
    // What the user typed runs the step's UserPromptSubmit hooks, recorded
    // with the message their context joins.
    const typed = followUps.filter(
      ({ content }) => content.from.kind === 'user',
    );
    const hooked =
      typed.length === 0
        ? { rows: [], parts: [] }
        : yield* promptHooks(
            run,
            state,
            typed[0].followUpId,
            typed.map(({ content }) => content.text).join('\n\n'),
          );
    const message: Message =
      built.message.role === 'user'
        ? {
            ...built.message,
            content: [...built.message.content, ...hooked.parts],
          }
        : built.message;
    // A skill the user activated, and the run's current step resolves,
    // joins the run's recorded activations by name, the latest
    // `ACTIVATED_SKILLS_MAX` kept; each step resolves them again.
    const found = yield* resolveActivations(
      run,
      activatedSkillNames(
        followUps
          .filter(({ content }) => isInstruction(content))
          .map(({ content }) => content.text),
      ),
    );
    const current = state.loop?.activated ?? [];
    const activated = found.some((name) => !current.includes(name))
      ? [
          ...new Set([
            ...current.filter((name) => !found.includes(name)),
            ...found,
          ]),
        ].slice(-ACTIVATED_SKILLS_MAX)
      : undefined;
    return {
      turn,
      // The pointers commit beside the blobs: no crash separates them. The
      // launch's instruction is the absence of one.
      recorded: {
        ...(instruction === undefined
          ? {}
          : {
              instruction:
                instruction === run.config.instruction
                  ? undefined
                  : sha256(instruction),
            }),
        ...(activated === undefined ? {} : { activated }),
      },
      rows: [
        // A reset replaces the whole view, the context updates in it too:
        // the next step renders them anew.
        ...(edit === null
          ? []
          : [
              {
                type: 'context.edit' as const,
                aggregateId: rowAggregate(runId),
                payload: {
                  cause:
                    edit.handoff === null
                      ? ('reset' as const)
                      : ('handoff' as const),
                  trigger: null,
                  base: state.lastEdit,
                  range: { from: 0, to: state.messages.length },
                  messages: [],
                  usage: null,
                },
              },
            ]),
        ...blobRows(runId, state, [
          ...(instruction === undefined ? [] : [instruction]),
        ]),
        ...all.map((followUp) => ({
          type: 'followup.consumed' as const,
          aggregateId: rowAggregate(runId),
          followUpId: followUp.followUpId,
        })),
        ...hooked.rows,
        ...(turn ? [appendRow(runId, [message])] : []),
      ],
      // The user's rows are durable; the transcript shows what was asked.
      delivered: () => logFollowUps(followUps, built.kinds),
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
    const joined = yield* batchRows(state, batch).pipe(
      Effect.tapError((error) =>
        batch.kind === 'edit'
          ? Deferred.fail(batch.edit.done, error)
          : Effect.void,
      ),
    );
    const committed = yield* Effect.uninterruptible(
      runHistory
        .appendBatch(runId, state, [
          ...joined.rows,
          // The input that recovers a failed run clears the error fact in
          // the same transaction, so a resume taken between this batch and
          // the next turn's snapshot does not read the run as still failed.
          ...(joined.turn
            ? [
                ...snapshotRow(runId, state, {
                  runtime: { lastError: null },
                  ...(state.loop
                    ? { state: { ...state.loop, ...joined.recorded } }
                    : {}),
                }),
                positionRow(runId, state, 'turn.ready'),
              ]
            : []),
        ])
        .pipe(
          Effect.onExit((exit) =>
            batch.kind === 'edit'
              ? Deferred.done(batch.edit.done, Exit.asVoid(exit))
              : Effect.void,
          ),
        ),
    );
    joined.delivered();
    return { state: committed, turn: joined.turn };
  });

  return {
    hasQueued: () => input.hasQueued(),
    appendSynthetic: (text) => {
      if (syntheticPending) return;
      syntheticPending = true;
      input.wake(text);
    },
    editView: (edit) => input.editView(edit),
    wait: Effect.map(input.take, taken),
    joinStopped: (state) =>
      state.at === 'halted' &&
      // Only a user stop joins: that halt carries no error fact to clear and
      // no turn.ready row to write, which is why the join skips `consume`'s.
      state.outcome === 'cancelled' &&
      input.hasQueued() &&
      !syntheticPending
        ? Effect.flatMap(input.take, (batch) => {
            // `!syntheticPending`: no maintenance wake is queued, so this
            // take is follow-ups, which stay queued until consumed, and a
            // declined batch is left for the ordinary wait.
            if (batch?.kind === 'synthetic') {
              return Effect.die(
                new Error('joinStopped took a wake none was pending.'),
              );
            }
            // A view edit waits for the park this stopped turn ends at.
            if (batch?.kind === 'edit') {
              if (!input.editView(batch.edit))
                Deferred.doneUnsafe(
                  batch.edit.done,
                  Effect.fail(
                    new Error('The task stopped before its view was edited.'),
                  ),
                );
              return Effect.succeed(null);
            }
            return batch === null ||
              !batch.followUps.some((f) => isInstruction(f.content))
              ? Effect.succeed(null)
              : batchRows(state, batch);
          })
        : Effect.succeed(null),
    release: (next) => {
      if (released || !lease) return;
      released = true;
      manager.release(lease, next);
    },
    consume,
  };
});
