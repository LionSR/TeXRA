/**
 * The session's follow-up inbox. A run's input is a file appended to: each
 * message is one `followup.queued` row, and what a run still has to read is
 * its queued rows less its `followup.consumed` ones, read from the store
 * inside the job that acts on them (`read`). There is one reader per run, the generation running it here, which
 * the run registry already admits one at a time; the run's database claim is
 * the only lock. When a row may be read is data on the row (`holdUntil`),
 * evaluated by the fold a take reads (`RunInput`).
 */
import { Deferred, Effect, Result, type Scope } from 'effect';

import type { ResumeRunResult } from '@agent/runtime/resumeRun';
import type { SessionLog } from '@agent/runtime/SessionHandle';
import { withLogChannel } from '@logger/effectLog';
import {
  qualifyAggregateId,
  type RunId,
  type SessionEventDraft,
} from '@shared/schemas';
import {
  heldElsewhereBy,
  type DatabaseReadFailed,
} from '@shared/session/database';
import { runRelation } from '@shared/session/runRelation';
import {
  FOLLOW_UP_TYPES,
  foldRunRows,
  isFollowUpRow,
  lifecycleOf,
  RUN_LIFECYCLE_TYPES,
  type QueuedFollowUp,
  type RunRows,
} from '@shared/session/runRows';
import {
  afterCommit,
  type Append,
  type SessionEventsShape,
} from '@shared/session/sessionEvents';
import { ensureError } from '@utils/errors/errorMessage';
import { RunInput } from './RunInput';
import { queuedRow } from './followUpMessages';
import type { FollowUpSenderInput } from './followUpSender';

const CHANNEL = 'Inbox';

/** The rows a run's input is read from. */
const INPUT_TYPES = [...FOLLOW_UP_TYPES, ...RUN_LIFECYCLE_TYPES];
/** A run's input: what is queued, every follow-up id named, if closed. */
type InputRows = RunRows & { readonly closed: boolean };

/** The session doors the inbox works through (the session layer wires them). */
export interface InboxPort {
  /** The session's log: a send is one transaction under the run's claim. */
  readonly log: Pick<SessionLog, 'transact' | 'rows' | 'hold'>;
  /** Enqueue a job on the session's publisher and return. */
  readonly detach: SessionEventsShape['detach'];
  /** The run's parent as the session view folds it; `null` at top level. */
  readonly parentOf: (runId: RunId) => RunId | null | undefined;
  /** Whether a generation of the run is live in this process. */
  readonly live: (runId: RunId) => boolean;
}

/** One message a producer sends. */
export interface InboxItem {
  readonly text: string;
  readonly displayText?: string;
  /** Media file paths (e.g. pasted images) attached to a user's message. */
  readonly mediaFiles?: readonly string[];
  readonly from: FollowUpSenderInput;
  /** Identity of a delivery its producer may repeat (a child's result,
   *  #9531): the row's `followUpId`, so a replay writes nothing. */
  readonly deliveryId?: string;
  /** A request of the run's own (`/compact`, a model switch), not a message. */
  readonly control?: QueuedFollowUp['control'];
}

/** How a send landed. `queued.read`: a reader here takes it; `queued.wake`:
 *  nobody here will (no generation is live and no resume is in flight), and
 *  the caller owes the run a resume. */
export type Sent =
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'queued'; readonly read: boolean; readonly wake: boolean }
  | { readonly kind: 'refused'; readonly reason?: 'owned_elsewhere' };

/** What a send asks of the row and of the run. */
export interface SendOptions {
  /** When the row may be read: only beside an instruction (a pause notice,
   *  which never wakes a run). Absent: at once. */
  readonly hold?: QueuedFollowUp['holdUntil'];
  /** Owe the run a resume when no generation here will read the row. */
  readonly wake?: boolean;
}

/** A resume's result, and whether this caller joined one in flight. */
type Resumed = { readonly result: ResumeRunResult; readonly joined: boolean };

/** A send decided inside a job: its rows, and how it landed. */
type Admission = { rows: readonly SessionEventDraft[]; sent: Sent };

/** What observers hear: a run takes no more input, or the inbox closed. */
export type InboxClosed =
  | { readonly kind: 'run'; readonly runId: RunId }
  | { readonly kind: 'session' };

/** The session's follow-up inbox; see the module comment. */
export class Inbox {
  private readonly readers = new Map<RunId, RunInput>();
  private readonly resumes = new Map<
    RunId,
    Deferred.Deferred<ResumeRunResult, Error>
  >();
  private readonly observers = new Set<(closed: InboxClosed) => void>();
  private disposed = false;

  private readonly port: InboxPort;

  constructor(port: InboxPort) {
    this.port = port;
  }

  /** Append one message to the run's input in one job under its claim:
   *  refused, writing nothing, when the input is closed with no reader here
   *  or another live process holds the run; a replay writes nothing. */
  send(
    runId: RunId,
    item: InboxItem,
    options: SendOptions = {},
  ): Effect.Effect<Sent, Error> {
    if (this.disposed) return Effect.succeed({ kind: 'refused' });
    return this.port.log.transact((tx) =>
      this.admit(runId, item, options, tx.append),
    );
  }

  /** {@link send} for a producer with no fiber (a child's progress notice):
   *  enqueued on the publisher now, so it commits in call order ahead of
   *  the turn's result; a failure is logged. */
  sendDetached(runId: RunId, item: InboxItem): void {
    if (this.disposed) return;
    this.port.detach((append) =>
      this.admit(runId, item, {}, append).pipe(
        Effect.catch((error) =>
          Effect.logWarning(`Follow-up for run ${runId} was not queued`).pipe(
            Effect.annotateLogs({ data: error }),
            withLogChannel(CHANNEL),
          ),
        ),
      ),
    );
  }

  /** Open the run's reader for the generation running it (the caller's
   *  scope); the registry admits one at a time, so a second is a defect. */
  open(runId: RunId): Effect.Effect<RunInput, never, Scope.Scope> {
    return Effect.acquireRelease(
      Effect.suspend(() => {
        if (this.readers.has(runId))
          return Effect.die(new Error(`Run ${runId} already has a reader`));
        const input = new RunInput(
          this.read(runId).pipe(
            Effect.map(({ followUps }) => followUps),
            // The run's own rows, read while this process holds its claim:
            // a store that cannot read them cannot run it either.
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
  release(runId: RunId, input: RunInput, terminal: boolean): void {
    if (this.readers.get(runId) !== input) return;
    this.readers.delete(runId);
    input.end();
    if (!terminal) return;
    this.port.detach(() =>
      Effect.gen({ self: this }, function* () {
        if (this.readers.has(runId) || queued(yield* this.read(runId))) return;
        yield* afterCommit(
          Effect.sync(() => this.notify({ kind: 'run', runId })),
        );
      }),
    );
  }

  /** Close the run's input (`followup.closed`) under its claim, unless a
   *  message is queued, read in the same transaction; a failure is logged. */
  closeInput(runId: RunId): Effect.Effect<void> {
    if (this.disposed) return Effect.void;
    const run = qualifyAggregateId('run', runId);
    return this.port.log
      .transact((tx) =>
        Effect.gen({ self: this }, function* () {
          yield* this.port.log.hold(runId);
          const input = yield* this.read(runId);
          if (queued(input)) return;
          // A request the run never applied closes with its input.
          yield* tx.append([
            ...input.followUps.map(({ followUpId }) => ({
              type: 'followup.consumed' as const,
              aggregateId: run,
              followUpId,
            })),
            { type: 'followup.closed', aggregateId: run },
          ]);
          // Only a closed input that committed ends the reader.
          yield* afterCommit(
            Effect.sync(() => {
              this.endReader(runId);
              this.notify({ kind: 'run', runId });
            }),
          );
        }).pipe(Effect.scoped),
      )
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `Run ${runId}: its closed input was not recorded`,
          ).pipe(Effect.annotateLogs({ data: error }), withLogChannel(CHANNEL)),
        ),
      );
  }

  /** A deleted run: its reader ends; its `run.removed` row closes its input. */
  forget(runId: RunId): void {
    if (this.disposed) return;
    this.endReader(runId);
    this.notify({ kind: 'run', runId });
  }

  /** One resume of `runId` at a time: a second caller joins the first and
   *  hears its result (`joined`). */
  resumeOnce<R>(
    runId: RunId,
    resume: Effect.Effect<ResumeRunResult, Error, R>,
  ): Effect.Effect<Resumed, Error, R> {
    return Effect.suspend((): Effect.Effect<Resumed, Error, R> => {
      const running = this.resumes.get(runId);
      if (running !== undefined)
        return Effect.map(Deferred.await(running), (result) => ({
          result,
          joined: true,
        }));
      const done = Deferred.makeUnsafe<ResumeRunResult, Error>();
      this.resumes.set(runId, done);
      return resume.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            this.resumes.delete(runId);
            Deferred.doneUnsafe(done, exit);
          }),
        ),
        Effect.map((result) => ({ result, joined: false })),
      );
    });
  }

  /** Hear each run that takes no more input, and the inbox's own close. */
  onClosed(observer: (closed: InboxClosed) => void): () => void {
    if (this.disposed) return () => {};
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
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

  private admit(
    runId: RunId,
    item: InboxItem,
    options: SendOptions,
    append: Append,
  ): Effect.Effect<Sent, Error> {
    return Effect.gen({ self: this }, function* () {
      const { rows, sent } = yield* this.admission(runId, item, options);
      if (rows.length > 0) yield* append(rows);
      return sent;
    }).pipe(Effect.scoped);
  }

  /** One send decided in the caller's job under the run's claim: the row
   *  the job appends with its own, and how it landed (see {@link send}). */
  admission(
    runId: RunId,
    item: InboxItem,
    options: SendOptions,
  ): Effect.Effect<Admission, Error, Scope.Scope> {
    // No reader here: "closed" is read from rows, again once claimed.
    const closed = (input: InputRows) =>
      this.disposed || (!this.readers.has(runId) && input.closed);
    const only = (sent: Sent): Admission => ({ rows: [], sent });
    // The reader hears a committed row; a replay is news only as a wake.
    const landed = (replay: boolean) =>
      Effect.suspend(() => {
        const reader = this.readers.get(runId);
        const wake =
          options.wake === true &&
          options.hold !== 'instruction' &&
          reader === undefined &&
          !this.port.live(runId) &&
          !this.resumes.has(runId);
        const sent: Sent =
          replay && !wake
            ? { kind: 'duplicate' }
            : { kind: 'queued', read: reader !== undefined, wake };
        return Effect.as(
          afterCommit(Effect.sync(() => reader?.notify())),
          sent,
        );
      });
    return Effect.gen({ self: this }, function* () {
      if (closed(yield* this.read(runId))) return only({ kind: 'refused' });
      yield* this.port.log.hold(runId);
      const input = yield* this.read(runId);
      if (closed(input)) return only({ kind: 'refused' });
      // Stamped inside the job, from committed parentage.
      const row = queuedRow(item, options.hold, (sender) =>
        runRelation(sender, runId, this.port.parentOf),
      );
      if (!input.followUpIds.has(row.followUpId)) {
        const aggregate = qualifyAggregateId('run', runId);
        const queued = { type: 'followup.queued', ...row } as const;
        return {
          rows: [{ ...queued, aggregateId: aggregate }],
          sent: yield* landed(false),
        };
      }
      return input.followUps.some((f) => f.followUpId === row.followUpId)
        ? { rows: [], sent: yield* landed(true) }
        : only({ kind: 'duplicate' });
    }).pipe(
      Effect.catchIf(
        (error) => heldElsewhereBy(error) !== null,
        (error) =>
          Effect.logWarning(
            `Follow-up for run ${runId} was not queued: another process holds the run.`,
          ).pipe(
            Effect.annotateLogs({ data: error }),
            withLogChannel(CHANNEL),
            Effect.as(only({ kind: 'refused', reason: 'owned_elsewhere' })),
          ),
      ),
    );
  }

  /** The run's input as its committed rows say it (`InputRows`). */
  read(runId: RunId): Effect.Effect<InputRows, DatabaseReadFailed> {
    return Effect.suspend(() =>
      this.port.log.rows(qualifyAggregateId('run', runId), INPUT_TYPES),
    ).pipe(
      Effect.map((rows) => ({
        ...foldRunRows(rows.filter(isFollowUpRow)),
        closed: lifecycleOf(rows).closed,
      })),
    );
  }

  private endReader(runId: RunId): void {
    this.readers.get(runId)?.end();
    this.readers.delete(runId);
  }

  private notify(closed: InboxClosed): void {
    for (const observer of this.observers) {
      const ran = Result.try({
        try: () => observer(closed),
        catch: ensureError,
      });
      if (Result.isFailure(ran)) {
        this.port.detach(() =>
          Effect.logWarning('An inbox observer threw').pipe(
            Effect.annotateLogs({ data: ran.failure }),
            withLogChannel(CHANNEL),
          ),
        );
      }
    }
  }
}

/** Whether a message is queued: a request (`control`) resumes no run. */
const queued = (input: InputRows): boolean =>
  input.followUps.some((f) => f.control === undefined);
