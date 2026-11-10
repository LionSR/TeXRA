/**
 * The session's follow-up inbox: a run's input is its `followup.queued` rows
 * less its `followup.consumed` ones, read inside the job acting on them, by
 * one reader per run (its generation here); the publisher's one job at a
 * time is the only lock, and when a row may be read is data on it
 * (`holdUntil`, `FollowUpReader`).
 */
import { Context, Effect, Result, type Scope } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import { qualifyAggregateId, type RunId } from '@shared/schemas';
import type { DatabaseReadFailed } from '@shared/session/database';
import { ancestryRows, runRelation } from '@shared/session/runRelation';
import type { DraftBlob } from '@shared/session/historyTurns';
import type { RunInputDraft } from '@shared/session/runState';
import { consumedRow } from '@shared/session/runFacts';
import { isMessage, type QueuedFollowUp } from '@shared/session/runRows';
import type { RunRowsRead } from '@shared/session/runRowReads';
import type { Append, SessionEventsShape } from '@shared/session/sessionEvents';
import type {
  LogWriteError,
  SessionLogShape,
} from '@shared/session/sessionLog';
import type { PerKeyLane } from '@utils/core/perKeyQueue';
import { ensureError } from '@utils/errors/errorMessage';
import { FollowUpReader, needsWake } from './FollowUpReader';
import { queuedRow, type FollowUpSenderInput } from './followUpMessages';

const CHANNEL = 'Inbox';

const CLOSED = Object.freeze({
  kind: 'refused',
  reason: 'notResumable',
} as const);
/** The session doors the inbox works through (the session layer wires them). */
export interface InboxPort {
  /** The session's log: a send is one transaction. */
  readonly log: Pick<
    SessionLogShape,
    'transact' | 'runRows' | 'history' | 'settled'
  >;
  /** Enqueue a job on the session's publisher and return. */
  readonly detach: SessionEventsShape['detach'];
}

/** One message a producer sends. */
export interface InboxItem {
  readonly text: string;
  readonly displayText?: string;
  /** A user's media (e.g. pasted images) and its blobs (`attachedMedia`). */
  readonly media?: QueuedFollowUp['content']['media'];
  readonly blobs?: readonly DraftBlob[];
  readonly from: FollowUpSenderInput;
  /** Identity of a delivery its producer may repeat (a child's result):
   *  the row's `followUpId`, so a replay writes nothing. */
  readonly deliveryId?: string;
  /** A request of the run's own (`/compact`, a model switch), not a message. */
  readonly control?: QueuedFollowUp['control'];
  /** The id a caller named the message by (`followUp.send`; `deliveryId`
   *  is its `sentFollowUpId`): a retry under it answers with the first
   *  send's receipt, another message under it fails `Conflict`. */
  readonly caller?: string;
}

/** How a send landed: queued for the run (a reader here takes it, or its
 *  resume does), a replay of a row already queued, or refused. */
export type Sent =
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'queued' }
  | { readonly kind: 'refused'; readonly reason: Refusal };
/** Why a send wrote nothing: a closed input, a non-parent. */
type Refusal = 'notResumable' | 'notParent';

/** What a send asks of the row and of the run. */
export interface SendOptions {
  /** When the row may be read (`readableMessages`). Absent: at once, or at
   *  the turn's end for a host's notification (`queuedRow`). */
  readonly hold?: QueuedFollowUp['holdUntil'];
  /** Only from the run's parent: its rows' edge, read in this job. */
  readonly fromParent?: boolean;
}

/** A send decided inside a job: its rows, and how it landed. */
type Admission = { rows: readonly RunInputDraft[]; sent: Sent };

/** What observers hear: a run takes no more input, or the inbox closed. */
type InboxClosed =
  | { readonly kind: 'run'; readonly runId: RunId }
  | { readonly kind: 'session' };

/** The session's follow-up inbox; see the module comment. */
export class SessionInbox {
  private readonly readers = new Map<RunId, FollowUpReader>();
  /** Each run's sends, admitted one at a time in call order. */
  readonly sendLanes = new Map<RunId, PerKeyLane>();
  private readonly observers = new Set<(closed: InboxClosed) => void>();
  private disposed = false;

  private readonly port: InboxPort;

  constructor(port: InboxPort) {
    this.port = port;
  }

  /** Append one message to the run's input in one job: refused, writing
   *  nothing, when the input is closed with no reader here; a replay writes
   *  nothing. A row no reader here takes is the sender's to wake the run
   *  for, when {@link owesResume}. */
  send(
    runId: RunId,
    item: InboxItem,
    options: SendOptions = {},
  ): Effect.Effect<Sent, LogWriteError | DatabaseReadFailed> {
    if (this.disposed) return Effect.succeed(CLOSED);
    return this.port.log.transact((tx) =>
      this.admit(runId, item, options, tx.append),
    );
  }

  /** Open the run's reader for the generation running it (the caller's
   *  scope); the registry admits one at a time, so a second is a defect. */
  open(runId: RunId): Effect.Effect<FollowUpReader, never, Scope.Scope> {
    return Effect.acquireRelease(
      Effect.suspend(() => {
        if (this.readers.has(runId))
          return Effect.die(new Error(`Run ${runId} already has a reader`));
        const input = new FollowUpReader(
          this.read(runId).pipe(
            Effect.map(({ followUps }) => followUps),
            Effect.orDie,
          ),
        );
        if (this.disposed) input.end();
        else this.readers.set(runId, input);
        return Effect.succeed(input);
      }),
      (input) => Effect.sync(() => this.release(runId, input, false)),
    );
  }

  /** End the run's reader `input`; `terminal`: the observers hear the run
   *  takes no more input here, on the publisher after the sends already
   *  admitted, and only if none left a row queued. Idempotent. */
  release(runId: RunId, input: FollowUpReader, terminal: boolean): void {
    if (this.readers.get(runId) !== input) return;
    this.readers.delete(runId);
    input.end();
    if (!terminal) return;
    this.port.detach(
      Effect.fnUntraced({ self: this }, function* () {
        if (this.readers.has(runId) || queued(yield* this.read(runId))) return;
        this.notify({ kind: 'run', runId });
      }),
    );
  }

  /** Whether the run is owed a resume: its input obliges one
   *  (`needsWake`) and no reader here takes it, read once the publisher
   *  settled. Undefined only if the input could not be read (`wakeRun`'s
   *  caller resumes it). */
  owesResume(runId: RunId): Effect.Effect<boolean | undefined> {
    return Effect.gen({ self: this }, function* () {
      yield* this.port.log.settled;
      if (this.disposed || this.readers.has(runId)) return false;
      const input = yield* this.read(runId);
      return !input.inputClosed && needsWake(input);
    }).pipe(
      Effect.catch((error) =>
        Effect.as(
          warnWith(
            `Run ${runId} was not woken; an explicit Resume delivers what is queued`,
          )(error),
          undefined,
        ),
      ),
    );
  }

  /** Close the run's input (`followup.closed`), unless a message is queued,
   *  read in the same transaction; a failure is logged. */
  closeInput(runId: RunId): Effect.Effect<void> {
    if (this.disposed) return Effect.void;
    const run = qualifyAggregateId('run', runId);
    return this.port.log
      .transact((tx) =>
        Effect.gen({ self: this }, function* () {
          const input = yield* this.read(runId);
          if (queued(input)) return false;
          // A request the run never applied closes with its input.
          yield* tx.append([
            ...input.followUps.map(({ followUpId }) =>
              consumedRow(runId, followUpId, {
                kind: 'dropped',
                reason: 'closed',
              }),
            ),
            { type: 'followup.closed', aggregateId: run },
          ]);
          return true;
        }),
      )
      .pipe(
        // Only a closed input that committed ends the reader.
        Effect.tap((closed) => Effect.sync(() => closed && this.forget(runId))),
        Effect.asVoid,
        Effect.catch(warnWith(`Run ${runId}: closing its input failed`)),
      );
  }

  /** A run that takes no more input (deleted: its `run.removed` row closes
   *  its input; or closed): its reader ends and the observers hear it. */
  forget(runId: RunId): void {
    if (this.disposed) return;
    this.readers.get(runId)?.end();
    this.readers.delete(runId);
    this.notify({ kind: 'run', runId });
  }

  /** Hear each run that takes no more input, and the inbox's own close. */
  onClosed(observer: (closed: InboxClosed) => void): () => void {
    if (this.disposed) return () => {};
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  /** End every reader and refuse every later send. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const input of this.readers.values()) input.end();
    this.readers.clear();
    this.notify({ kind: 'session' });
    this.observers.clear();
  }

  private readonly admit: (
    runId: RunId,
    item: InboxItem,
    options: SendOptions,
    append: Append,
  ) => Effect.Effect<Sent, LogWriteError | DatabaseReadFailed> = Effect.fn(
    'SessionInbox.admit',
  )(
    { self: this },
    function* (
      runId: RunId,
      item: InboxItem,
      options: SendOptions,
      append: Append,
    ) {
      const { rows, sent } = yield* this.admission(runId, item, options);
      if (rows.length > 0) yield* append(rows);
      return sent;
    },
  );

  /** One send decided in the caller's job: the row the job appends with
   *  its own, and how it landed (see {@link send}). */
  admission(
    runId: RunId,
    item: InboxItem,
    options: SendOptions,
  ): Effect.Effect<Admission, DatabaseReadFailed> {
    const closed = (input: RunRowsRead<'input'>) =>
      this.disposed || (!this.readers.has(runId) && input.inputClosed);
    const only = (sent: Sent): Admission => ({ rows: [], sent });
    // The reader hears the row: it reads committed rows, so a wake ahead
    // of the commit costs it one empty read.
    const landed = (replay: boolean) =>
      Effect.sync((): Sent => {
        const reader = this.readers.get(runId);
        reader?.notify();
        return replay ? { kind: 'duplicate' } : { kind: 'queued' };
      });
    return Effect.gen({ self: this }, function* () {
      const input = yield* this.read(runId);
      if (closed(input)) return only(CLOSED);
      const sender = item.from.kind === 'run' ? item.from.runId : null;
      if (options.fromParent === true && input.parent?.id !== sender)
        return only({ kind: 'refused', reason: 'notParent' });
      // Stamped inside the job, from the parent edges the rows record.
      const line = yield* ancestryRows(this.read, runId, sender);
      const row = queuedRow(item, options.hold, (from) =>
        runRelation(from, runId, (id) => line.get(id)?.parent?.id),
      );
      const queuedStill = input.followUps.some(
        (f) => f.followUpId === row.followUpId,
      );
      if (!queuedStill && !input.taken.has(row.followUpId)) {
        const aggregate = qualifyAggregateId('run', runId);
        const queued = { type: 'followup.queued', ...row } as const;
        return {
          rows: [{ ...queued, aggregateId: aggregate }],
          sent: yield* landed(false),
        };
      }
      // A caller's id that is queued or taken was answered before the send
      // by `sentBefore`, in the same per-run lane.
      return queuedStill
        ? { rows: [], sent: yield* landed(true) }
        : only({ kind: 'duplicate' });
    });
  }

  /** The run's input, lifecycle and parent as its committed rows say them. */
  readonly read = (
    runId: RunId,
  ): Effect.Effect<RunRowsRead<'input'>, DatabaseReadFailed> =>
    Effect.suspend(() =>
      this.port.log.runRows(qualifyAggregateId('run', runId), 'input'),
    );

  private notify(closed: InboxClosed): void {
    for (const observer of this.observers) {
      const ran = Result.try({
        try: () => observer(closed),
        catch: ensureError,
      });
      if (Result.isFailure(ran))
        this.port.detach(() =>
          warnWith('An inbox observer threw')(ran.failure),
        );
    }
  }
}

/** Log `message` at warn with the failure behind it. */
const warnWith =
  (message: string) =>
  (cause: unknown): Effect.Effect<void> =>
    Effect.logWarning(message).pipe(
      Effect.annotateLogs({ data: cause }),
      withLogChannel(CHANNEL),
    );

/** Whether the run has a pending message, not just one of its own requests. */
const queued = (input: RunRowsRead<'input'>): boolean =>
  input.followUps.some(isMessage);

/** The session's follow-up inbox ({@link SessionInbox}): every run's input,
 *  one reader each, which every message to a run is admitted through.
 *  Built by the session layer and disposed with the session. */
export class Inbox extends Context.Service<Inbox, SessionInbox>()(
  '@texra-ai/harness/session/Inbox',
) {}
