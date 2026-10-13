/**
 * The session's follow-up inbox: a run's input is its `followup.queued` rows
 * less its `followup.consumed` ones, read inside the job acting on them, by
 * one reader per run (its generation here); the run's claim is the only
 * lock, and when a row may be read is data on it (`holdUntil`, `RunInput`).
 */
import { Deferred, Effect, Result, type Scope } from 'effect';

import type { ResumeAttempt } from '@agent/runtime/resumeRun';
import type { SessionLog } from '@agent/runtime/SessionHandle';
import { withLogChannel } from '@logger/effectLog';
import { qualifyAggregateId, type RunId } from '@shared/schemas';
import {
  heldElsewhereBy,
  type DatabaseReadFailed,
} from '@shared/session/database';
import { parentEdgeOf, runRelation } from '@shared/session/runRelation';
import type { RunInputDraft } from '@shared/session/runStateFold';
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
  readonly log: Pick<SessionLog, 'transact' | 'rows' | 'records' | 'hold'>;
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
  | { readonly kind: 'refused'; readonly reason?: Refusal };
/** Why a send wrote nothing beyond a closed input. */
type Refusal = 'owned_elsewhere' | 'not_parent';

/** What a send asks of the row and of the run. */
export interface SendOptions {
  /** When the row may be read: only beside an instruction (a pause notice,
   *  which never wakes a run). Absent: at once. */
  readonly hold?: QueuedFollowUp['holdUntil'];
  /** Owe the run a resume when no generation here will read the row. */
  readonly wake?: boolean;
  /** Only from the run's parent: its rows' edge, read in this job. */
  readonly fromParent?: boolean;
}

/** A resume's result, and whether this caller joined one in flight. */
type Resumed = { readonly result: ResumeAttempt; readonly joined: boolean };

/** A send decided inside a job: its rows, and how it landed. */
type Admission = { rows: readonly RunInputDraft[]; sent: Sent };

/** What observers hear: a run takes no more input, or the inbox closed. */
export type InboxClosed =
  | { readonly kind: 'run'; readonly runId: RunId }
  | { readonly kind: 'session' };

/** The session's follow-up inbox; see the module comment. */
export class Inbox {
  private readonly readers = new Map<RunId, RunInput>();
  private readonly resumes = new Map<
    RunId,
    { readonly done: Deferred.Deferred<ResumeAttempt, Error>; joiners: number }
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
   *  the turn's result; `to` is read in that job (none: nothing queued). A
   *  failure is logged. */
  sendDetached(to: Effect.Effect<RunId | null, Error>, item: InboxItem): void {
    if (this.disposed) return;
    this.port.detach((append) =>
      Effect.flatMap(to, (runId) =>
        runId === null ? Effect.void : this.admit(runId, item, {}, append),
      ).pipe(Effect.catch(warnWith('A follow-up was not queued'))),
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
          yield* afterCommit(Effect.sync(() => this.forget(runId)));
        }).pipe(Effect.scoped),
      )
      .pipe(Effect.catch(warnWith(`Run ${runId}: closing its input failed`)));
  }

  /** A run that takes no more input (deleted: its `run.removed` row closes
   *  its input; or closed): its reader ends and the observers hear it. */
  forget(runId: RunId): void {
    if (this.disposed) return;
    this.readers.get(runId)?.end();
    this.readers.delete(runId);
    this.notify({ kind: 'run', runId });
  }

  /** One resume of `runId` at a time; a joiner (`onJoined`) hears its result. */
  resumeOnce<R>(
    runId: RunId,
    resume: Effect.Effect<ResumeAttempt, Error, R>,
    onJoined?: () => void,
  ): Effect.Effect<Resumed, Error, R> {
    return Effect.suspend((): Effect.Effect<Resumed, Error, R> => {
      const running = this.resumes.get(runId);
      if (running !== undefined) {
        running.joiners += 1;
        onJoined?.();
        return Effect.map(Deferred.await(running.done), (result) => ({
          result,
          joined: true,
        })).pipe(Effect.ensuring(Effect.sync(() => (running.joiners -= 1))));
      }
      const done = Deferred.makeUnsafe<ResumeAttempt, Error>();
      this.resumes.set(runId, { done, joiners: 0 });
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

  /** Settles when `runId`'s resume in flight here ends; at once if none. */
  resumeSettled(runId: RunId): Effect.Effect<void> {
    const done = this.resumes.get(runId)?.done;
    return done
      ? Effect.asVoid(Effect.exit(Deferred.await(done)))
      : Effect.void;
  }

  /** Whether a caller is joined to `runId`'s resume in flight. */
  joined(runId: RunId): boolean {
    return (this.resumes.get(runId)?.joiners ?? 0) > 0;
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
      if (options.fromParent === true) {
        const edge = parentEdgeOf(yield* this.port.log.records(runId));
        if (edge?.id !== (item.from.kind === 'run' ? item.from.runId : null))
          return only({ kind: 'refused', reason: 'not_parent' });
      }
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
          warnWith(
            `Follow-up for run ${runId} was not queued: another process holds the run.`,
          )(error).pipe(
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

/** Whether a message is queued: a request (`control`) resumes no run. */
const queued = (input: InputRows): boolean =>
  input.followUps.some((f) => f.control === undefined);
