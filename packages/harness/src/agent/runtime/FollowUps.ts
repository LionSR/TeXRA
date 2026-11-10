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
 * own `AgentRun`); it is never a context service. A child's launch opens in
 * its parent's tool-call fiber, so a context service would hand the child
 * its parent's input.
 */
import { Effect, type FileSystem, Result, type Scope, ScopedRef } from 'effect';

import { userFollowUpInstruction } from '@agent/followUp/followUpMessages';
import { Inbox } from '@agent/followUp/Inbox';
import type {
  FollowUpBatch,
  FollowUpReader,
} from '@agent/followUp/FollowUpReader';
import { logUserMessage } from '@agent/trace/traceLogs';
import {
  ACTIVATED_SKILLS_MAX,
  type MediaAttachmentKind,
  type StoredInputPart,
} from '@shared/schemas';
import { consumedRow, isInstruction } from '@shared/session/runFacts';
import type { QueuedFollowUp } from '@shared/session/runRows';
import type { RunHistoryDraft, RunState } from '@shared/session/runState';
import type { Alongside } from '@shared/session/sessionEvents';
import { SessionLog, type RunCell } from '@shared/session/runHistory';
import { followUpDisplay } from '@shared/subagentFollowup';
import { activatedSkillNames } from '@skills/runtimeSkills';
import { sha256 } from '@utils/core/idHash';
import { formatDelivery } from './deliveryEnvelope';
import {
  skippedMediaPart,
  storedMediaPart,
  storedPdfPages,
  type InputPart,
} from './run/mediaInput';
import { blobRows } from './run/recordedRequest';
import { appendRow, positionRow } from './loop/rows';
import { hooksOf } from './loop/hooks';
import { resolveActivations } from './loop/step';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import type { AgentRunShape } from './run/AgentRun';
import type { SessionServices } from './rootLaunch';
import type { AppendedMessage } from './providerMessages';

/** A batch as the rows that consume it: its message's `append` carries what
 *  the delivery changes (the instruction it stores, the skills it
 *  activates). `delivered` logs them once durable. */
interface BatchRows {
  readonly rows: readonly RunHistoryDraft[];
  readonly delivered: () => void;
}

/** How one batch commits. */
interface ConsumeOptions {
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
  /** The run's reader: what is pending, read from its rows. */
  readonly reader: Pick<
    FollowUpReader,
    'hasPending' | 'controls' | 'read' | 'next'
  >;
  /** End the reader: the run stays recoverable, or takes no more input. */
  readonly release: (next: 'recoverable' | 'terminal') => void;
  /**
   * Commit a batch through the run's cell: its `followup.consumed` rows, its
   * user message, and the position it opens, in one batch, answering the
   * state it folds to. On failure nothing is consumed and the run's rows
   * still queue the batch.
   */
  readonly consume: (
    cell: RunCell,
    batch: FollowUpBatch,
    options?: ConsumeOptions,
  ) => Effect.Effect<
    RunState,
    Error,
    FileSystem.FileSystem | ChildProcessSpawner | SessionServices
  >;
}

/** Open `run`'s own reader for the enclosing scope. */
export const claimFollowUps = Effect.fn('FollowUps.claim')(function* (
  run: AgentRunShape,
): Effect.fn.Return<FollowUps, never, Scope.Scope | Inbox | SessionLog> {
  const { runId, logger } = run;
  const inbox = yield* Inbox;
  const log = yield* SessionLog;
  // Ended with the scope; the run's settleRun ends it first, saying
  // whether the run takes more input.
  const reader = yield* inbox.open(runId);

  /** The canonical user message of one batch: every item's text as its
   *  own part, media parts after it; `kinds[i]` is item i's badges. A
   *  child's delivery is rendered here, once, as the envelope the model
   *  reads (`formatDelivery`). The media is the row's by address; a PDF for
   *  a model that takes images but no PDF is sent as its pages, as an
   *  opening message's is. A medium the model does not take, or one whose
   *  pages cannot be rendered, is a text part saying so
   *  (`skippedMediaPart`): the model is told, in the row that carries the
   *  message. */
  const batchMessage = Effect.fn('FollowUps.batchMessage')(function* (
    followUps: readonly QueuedFollowUp[],
  ) {
    const { capabilities } = (yield* ScopedRef.get(run.model)).config;
    const parts: (InputPart | StoredInputPart)[] = [];
    const kinds: (readonly MediaAttachmentKind[])[] = [];
    for (const { content } of followUps) {
      if ('delivery' in content) {
        parts.push({ kind: 'text', text: formatDelivery(content.delivery) });
        kinds.push([]);
        continue;
      }
      parts.push({ kind: 'text', text: content.text });
      const badges: MediaAttachmentKind[] = [];
      for (const { name, mimeType, digest } of content.media ?? []) {
        const part = storedMediaPart(mimeType, digest, capabilities);
        if (part !== null) {
          parts.push(part);
          if (part.kind === 'image' || part.kind === 'document')
            badges.push(part.kind);
        } else if (
          mimeType === 'application/pdf' &&
          capabilities.supportsVision
        ) {
          const base64 = (yield* log.blobs([digest]))(digest);
          const pages = yield* Effect.result(storedPdfPages(name, base64));
          if (Result.isSuccess(pages)) {
            parts.push(...pages.success);
            badges.push('document');
          } else parts.push(skippedMediaPart(name, pages.failure.message));
        } else
          parts.push(skippedMediaPart(name, 'the model does not accept it'));
      }
      kinds.push(badges);
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
      const media = 'delivery' in content ? undefined : content.media;
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
    /** The turn the batch's message becomes part of. */
    turn: number,
  ): Effect.fn.Return<
    BatchRows,
    Error,
    FileSystem.FileSystem | ChildProcessSpawner | SessionServices
  > {
    const followUps = batch.kind === 'followUps' ? batch.followUps : [];
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
    const instruction = userFollowUpInstruction(
      followUps.map((followUp) => followUp.content),
    );
    // What the user typed runs the step's UserPromptSubmit hooks, recorded
    // with the message their context joins.
    const typed = followUps.flatMap(({ followUpId, content }) =>
      content.from.kind === 'user' && !('delivery' in content)
        ? [{ followUpId, text: content.text }]
        : [],
    );
    const hooked =
      typed.length === 0
        ? { rows: [], parts: [] }
        : yield* (yield* hooksOf(run)).prompt(
            state,
            typed[0].followUpId,
            typed.map(({ text }) => text).join('\n\n'),
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
        followUps.flatMap(({ content }) =>
          isInstruction(content) ? [content.text] : [],
        ),
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
      rows: [
        ...blobRows(
          runId,
          state,
          instruction === undefined ? [] : [instruction],
        ),
        ...followUps.map((followUp) =>
          consumedRow(runId, followUp.followUpId, { kind: 'turn', turn }),
        ),
        ...hooked.rows,
        appendRow(runId, [message], { input }),
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
    RunState,
    Error,
    FileSystem.FileSystem | ChildProcessSpawner | SessionServices
  > {
    const state = yield* cell.current;
    // The batch's message opens the next turn, or joins the one running.
    const opens = options.position !== false;
    const built = yield* batchRows(state, batch, state.turn + (opens ? 1 : 0));
    const rows = [...(options.rows ?? []), ...built.rows];
    const committed = yield* cell.append(
      opens ? [...rows, positionRow(runId, state, 'turn.ready')] : rows,
      options.alongside,
    );
    built.delivered();
    return committed;
  });

  return {
    reader,
    // A child takes no more input once its loop ends: its parent resumes it.
    release: (next) =>
      inbox.release(
        runId,
        reader,
        next === 'terminal' || run.entry.parent !== null,
      ),
    consume,
  };
});
