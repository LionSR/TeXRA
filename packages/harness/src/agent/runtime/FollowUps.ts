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
 * The run's conversation opens its own reader (`claimFollowUps`, from its
 * own `AgentRun`); it is never a context service. A child launched from a
 * parent's tool call runs in that call's fiber, so a context service would
 * hand the child its parent's input.
 */
import { randomUUID } from 'node:crypto';

import {
  Cause,
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
import type { FollowUpBatch, ViewEdit } from '@agent/followUp/RunInput';
import { logUserMessage } from '@agent/trace';
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
import { sha256 } from '@utils/core/idHash';
import { ensureError } from '@utils/errors/errorMessage';
import { type InputPart, mediaInputParts } from './run/mediaInput';

import { blobRows } from './run/requestContext';
import {
  appendRow,
  rowAggregate,
  positionRow,
  type Message,
} from './loop/rows';
import { promptHooks } from './loop/hooks';
import { resolveActivations } from './loop/step';
import type { AgentRunShape } from './run/AgentRun';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

/** A batch as the rows that consume it, for a caller that commits them in
 *  its own batch: its message's `append` carries what the delivery changes
 *  (the instruction it stores, the skills it activates). `delivered` logs
 *  them once durable. */
export interface JoinedFollowUps {
  readonly rows: readonly RunHistoryDraft[];
  /** Whether the rows carry a message a turn answers. */
  readonly turn: boolean;
  readonly delivered: () => void;
}

/** A turn's end, committed in the batch that consumes the next input. */
export interface Boundary {
  readonly rows: readonly RunHistoryDraft[];
}

export interface ConsumedFollowUps {
  readonly state: RunState;
  /** False when every item was a progress notice of an ended child: the
   *  batch was consumed without a message, and no turn follows. */
  readonly turn: boolean;
}

export interface FollowUps {
  readonly hasQueued: Effect.Effect<boolean>;
  /** The run's own pending requests (`/compact`, a model switch). */
  readonly controls: Effect.Effect<readonly QueuedFollowUp[]>;
  /** The queued messages a take would read now, without taking them. */
  readonly takeQueued: Effect.Effect<FollowUpBatch | null>;
  /** Queue a view edit, taken at the loop's next park before any input:
   *  false while another is queued or once the input has ended. */
  readonly editView: (edit: ViewEdit) => Effect.Effect<boolean>;
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
  /** End the reader: the run stays recoverable, or takes no more input. */
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
    /** What the batch commits on: `state`, moved first by a step that
     *  must precede it (a background compaction a reset settles). */
    prepare?: (state: RunState) => Effect.Effect<RunState, Error>,
    /** The turn boundary this batch commits with (input already queued
     *  when the turn ended). */
    boundary?: Boundary,
  ) => Effect.Effect<
    ConsumedFollowUps,
    Error,
    FileSystem.FileSystem | ChildProcessSpawner
  >;
}

/** Open `run`'s own reader for the enclosing scope. */
export const claimFollowUps = Effect.fn('FollowUps.claim')(function* (
  run: AgentRunShape,
  runHistory: RunHistory['Service'],
): Effect.fn.Return<FollowUps, never, Scope.Scope> {
  const { runId, session, logger } = run;
  // Ended with the scope; the run's settleRun arm ends it first, saying
  // whether the run takes more input.
  const input = yield* session.followUps.open(runId);

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
      isTerminalOutcomePhase(session.view.run(child as RunId)?.status)
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
   *  they carry, stored in the same batch so the append that names them
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
    const current = state.input.activated ?? [];
    const activated = found.some((name) => !current.includes(name))
      ? [
          ...new Set([
            ...current.filter((name) => !found.includes(name)),
            ...found,
          ]),
        ].slice(-ACTIVATED_SKILLS_MAX)
      : undefined;
    // The pointers commit beside the blobs: no crash separates them. The
    // launch's instruction is `null`.
    const input = {
      ...(instruction !== undefined && {
        instruction:
          instruction === run.config.instruction ? null : sha256(instruction),
      }),
      ...(activated !== undefined && { activated }),
    };
    return {
      turn,
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
        ...(turn ? [appendRow(runId, [message], { input })] : []),
      ],
      // The user's rows are durable; the transcript shows what was asked.
      delivered: () => logFollowUps(followUps, built.kinds),
    };
  });

  /** Commit one batch; a view edit's waiter settles on every exit: its
   *  commit, a refusal, or a stop before either. */
  const consume = Effect.fn('FollowUps.consume')(
    function* (
      current: RunState,
      batch: FollowUpBatch,
      prepare?: (state: RunState) => Effect.Effect<RunState, Error>,
      boundary?: Boundary,
    ): Effect.fn.Return<
      ConsumedFollowUps,
      Error,
      FileSystem.FileSystem | ChildProcessSpawner
    > {
      const state = prepare === undefined ? current : yield* prepare(current);
      const joined = yield* batchRows(state, batch);
      const committed = yield* Effect.uninterruptible(
        runHistory.appendBatch(runId, state, [
          ...(boundary?.rows ?? []),
          ...joined.rows,
          ...(joined.turn ? [positionRow(runId, state, 'turn.ready')] : []),
        ]),
      );
      joined.delivered();
      return { state: committed, turn: joined.turn };
    },
    (effect, _state, batch) =>
      batch.kind !== 'edit'
        ? effect
        : effect.pipe(
            Effect.onExit((exit) =>
              Deferred.done(
                batch.edit.done,
                Exit.isSuccess(exit)
                  ? Exit.void
                  : Exit.fail(
                      Cause.hasInterruptsOnly(exit.cause)
                        ? new Error(
                            'The task stopped before its view was edited.',
                          )
                        : ensureError(Cause.squash(exit.cause)),
                    ),
              ),
            ),
          ),
  );

  return {
    hasQueued: input.hasQueued,
    controls: input.controls,
    takeQueued: input.takeQueued,
    editView: (edit) => input.editView(edit),
    wait: input.take,
    // Only a user stop joins: that halt carries no error fact to clear and
    // no turn.ready row to write, which is why the join skips `consume`'s.
    joinStopped: (state) =>
      state.at !== 'halted' || state.outcome !== 'cancelled'
        ? Effect.succeed(null)
        : Effect.gen(function* () {
            if (!(yield* input.hasQueued)) return null;
            // A take reads what the rows queue and consumes nothing, so a
            // declined batch, or a `/compact`'s wake, is left for the
            // ordinary wait.
            const batch = yield* input.take;
            if (batch?.kind === 'synthetic') return null;
            // A view edit waits for the park this stopped turn ends at.
            if (batch?.kind === 'edit') {
              if (!(yield* input.editView(batch.edit)))
                Deferred.doneUnsafe(
                  batch.edit.done,
                  Effect.fail(
                    new Error('The task stopped before its view was edited.'),
                  ),
                );
              return null;
            }
            return batch === null ||
              !batch.followUps.some((f) => isInstruction(f.content))
              ? null
              : yield* batchRows(state, batch);
          }),
    // A child takes no more input once its loop ends: its parent resumes it.
    release: (next) =>
      session.followUps.release(
        runId,
        input,
        next === 'terminal' ||
          (session.runs.getHandle(runId)?.parent ?? null) !== null,
      ),
    consume,
  };
});
