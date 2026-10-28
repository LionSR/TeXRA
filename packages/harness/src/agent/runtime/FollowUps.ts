/**
 * The run's follow-up input: the `followup.queued` rows that have no
 * `followup.consumed` (the session publisher's pending set), the blocking
 * wait and the non-blocking probe, and `consume`, the one way a batch leaves
 * the queue: it commits the batch's `followup.consumed` rows with the user
 * message they become, and, when the batch starts a turn, `run.position
 * turn.ready`, in one batch of the run's cell. A crash before that commit
 * leaves the rows queued, so the next consumer delivers them again; after
 * it, nothing re-delivers them.
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
import { Effect, type FileSystem, type Scope, SynchronizedRef } from 'effect';

import {
  followUpDisplay,
  userFollowUpInstruction,
} from '@agent/followUp/followUpMessages';
import type { FollowUpBatch } from '@agent/followUp/RunInput';
import { logUserMessage } from '@agent/trace';
import {
  ACTIVATED_SKILLS_MAX,
  type MediaAttachmentKind,
  type StoredInputPart,
} from '@shared/schemas';
import {
  consumedRow,
  type InputPoint,
  isInstruction,
} from '@shared/session/runFacts';
import type { QueuedFollowUp } from '@shared/session/runRows';
import type { RunHistoryDraft, RunState } from '@shared/session/runState';
import type { Alongside } from '@shared/session/sessionEvents';
import type { RunCell } from '@shared/session/runHistory';
import { activatedSkillNames } from '@skills/runtimeSkills';
import { sha256 } from '@utils/core/idHash';
import { storedMediaPart } from './run/mediaInput';
import { blobRows } from './run/requestContext';
import { appendRow, positionRow } from './loop/rows';
import { promptHooks } from './loop/hooks';
import { resolveActivations } from './loop/step';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import type { AgentRunShape } from './run/AgentRun';
import type { AppendedMessage } from './storedTurn';

/** A batch as the rows that consume it: its message's `append` carries what
 *  the delivery changes (the instruction it stores, the skills it
 *  activates). `delivered` logs them once durable. */
interface BatchRows {
  readonly rows: readonly RunHistoryDraft[];
  /** Whether the rows carry a message a turn answers. */
  readonly turn: boolean;
  readonly delivered: () => void;
}

/** How one batch commits. */
export interface ConsumeOptions {
  /** Rows committed before the batch's: a turn's end and a child's
   *  delivery, so one batch carries the boundary and the next input. */
  readonly rows?: readonly RunHistoryDraft[];
  readonly alongside?: Alongside<Error>;
  /** Whether a batch with a message starts a turn (`run.position
   *  turn.ready`, the default) or joins the one running (delivery at the
   *  next request, `false`). */
  readonly position?: boolean;
}

export interface FollowUps {
  /** Whether `next` would return now: a message readable at `at`, or a
   *  `/compact`. */
  readonly hasPending: (at: InputPoint) => Effect.Effect<boolean>;
  /** The run's own pending requests (`/compact`, a model switch). */
  readonly controls: Effect.Effect<readonly QueuedFollowUp[]>;
  /** The messages readable at `at`, when there are any; nothing is taken. */
  readonly read: (at: InputPoint) => Effect.Effect<FollowUpBatch | null>;
  /** Block for the next batch readable at `at`; null once the generation
   *  ended. */
  readonly next: (at: InputPoint) => Effect.Effect<FollowUpBatch | null>;
  /** End the reader: the run stays recoverable, or takes no more input. */
  readonly release: (next: 'recoverable' | 'terminal') => void;
  /**
   * Commit a batch through the run's cell: its `followup.consumed` rows, its
   * user message, and the position it opens, in one batch, answering the
   * state it folds to and whether a message was delivered (`turn` is false
   * when every item was a notice of an ended child). On failure nothing is
   * consumed and the run's rows still queue the batch.
   */
  readonly consume: (
    cell: RunCell,
    batch: FollowUpBatch,
    options?: ConsumeOptions,
  ) => Effect.Effect<
    { readonly state: RunState; readonly turn: boolean },
    Error,
    FileSystem.FileSystem | ChildProcessSpawner
  >;
}

/** Open `run`'s own reader for the enclosing scope. */
export const claimFollowUps = Effect.fn('FollowUps.claim')(function* (
  run: AgentRunShape,
): Effect.fn.Return<FollowUps, never, Scope.Scope> {
  const { runId, session, logger } = run;
  // Ended with the scope; the run's settleRun arm ends it first, saying
  // whether the run takes more input.
  const input = yield* session.followUps.open(runId);

  /** The canonical user message of one batch: every item's text as its
   *  own part, media parts after it; `kinds[i]` is item i's badges.
   *  The media is the row's by address: a medium the model does not take
   *  is skipped with a transcript warning. */
  const batchMessage = Effect.fn('FollowUps.batchMessage')(function* (
    followUps: readonly QueuedFollowUp[],
  ) {
    const { capabilities } = (yield* SynchronizedRef.get(run.model)).config;
    const parts: StoredInputPart[] = [];
    const kinds: (readonly MediaAttachmentKind[])[] = [];
    for (const { content } of followUps) {
      parts.push({ kind: 'text', text: content.text });
      const media = (content.media ?? []).flatMap(
        ({ name, mimeType, digest }) => {
          const part = storedMediaPart(mimeType, digest, capabilities);
          if (part === null)
            logger.warn(`Skipping ${name}: the model does not accept it.`);
          return part === null ? [] : [part];
        },
      );
      parts.push(...media);
      kinds.push(
        media.flatMap((part) =>
          part.kind === 'image' || part.kind === 'document' ? [part.kind] : [],
        ),
      );
    }
    return {
      message: { role: 'user', content: parts } satisfies AppendedMessage,
      kinds,
    };
  });

  const logFollowUps = (
    followUps: readonly QueuedFollowUp[],
    kinds: readonly (readonly MediaAttachmentKind[])[],
  ): void => {
    for (const [i, { content }] of followUps.entries()) {
      const { text, scriptSummary } = followUpDisplay(content);
      const { media } = content;
      const attachments = kinds[i];
      logUserMessage(logger, text, { attachments, media, scriptSummary });
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
    BatchRows,
    Error,
    FileSystem.FileSystem | ChildProcessSpawner
  > {
    const followUps = batch.kind === 'followUps' ? batch.followUps : [];
    const stale = batch.kind === 'followUps' ? batch.stale : [];
    const turn = batch.kind === 'synthetic' || followUps.length > 0;
    const built =
      batch.kind === 'synthetic'
        ? {
            message: {
              role: 'user',
              content: [{ kind: 'text', text: batch.text }],
            } satisfies AppendedMessage,
            kinds: [],
          }
        : yield* batchMessage(followUps);
    if (stale.length > 0) {
      logger.debug(
        `Consumed ${stale.length} progress notice(s) of ended subagents without delivering them.`,
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
    const message: AppendedMessage = {
      ...built.message,
      content: [...built.message.content, ...hooked.parts],
    };
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
        ...blobRows(runId, state, [
          ...(instruction === undefined ? [] : [instruction]),
        ]),
        ...[...followUps, ...stale].map((followUp) =>
          consumedRow(runId, followUp.followUpId),
        ),
        ...hooked.rows,
        ...(turn ? [appendRow(runId, [message], { input })] : []),
      ],
      // The user's rows are durable; the transcript shows what was asked.
      delivered: () => logFollowUps(followUps, built.kinds),
    };
  });

  /** Commit one batch. */
  const consume = Effect.fn('FollowUps.consume')(function* (
    cell: RunCell,
    batch: FollowUpBatch,
    options: ConsumeOptions = {},
  ): Effect.fn.Return<
    { readonly state: RunState; readonly turn: boolean },
    Error,
    FileSystem.FileSystem | ChildProcessSpawner
  > {
    const state = yield* cell.current;
    const built = yield* batchRows(state, batch);
    const rows = [...(options.rows ?? []), ...built.rows];
    const opens = built.turn && options.position !== false;
    const committed = yield* cell.append(
      opens ? [...rows, positionRow(runId, state, 'turn.ready')] : rows,
      options.alongside,
    );
    built.delivered();
    return { state: committed, turn: built.turn };
  });

  return {
    hasPending: input.hasPending,
    controls: input.controls,
    read: input.read,
    next: input.next,
    // A child takes no more input once its loop ends: its parent resumes it.
    release: (next) =>
      session.followUps.release(
        runId,
        input,
        next === 'terminal' || run.entry.parent !== null,
      ),
    consume,
  };
});
