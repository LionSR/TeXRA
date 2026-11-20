/**
 * The session's follow-up inbox: a run's input is its `followup.queued` rows
 * less its `followup.consumed` ones, read inside the job acting on them. The
 * publisher's one job at a time is the only lock; whether a send is queued
 * (`sendVerdict`) and when its row may be read (`holdUntil`) are decided
 * from those rows (`FollowUpReader`). The inbox keeps no record of who
 * reads: the run its session's registry holds reads its own rows.
 */
import { Context, Effect, Result, type Scope } from 'effect';

import { logFailure } from '@logger/effectLog';
import {
  type ChildRunDelivery,
  type FollowUpControl,
  type FollowUpSender,
  type RunId,
  type StoredMedia,
} from '@shared/schemas';
import type { DatabaseReadFailed } from '@shared/session/database';
import type { DraftBlob } from '@shared/session/historyTurns';
import type { RunInputDraft } from '@shared/session/runState';
import { consumedRow } from '@shared/session/runFacts';
import { isMessage, type QueuedFollowUp } from '@shared/session/runRows';
import type { RunRowsRead } from '@shared/session/runRowReads';
import type { SessionEventsShape } from '@shared/session/sessionEvents';
import type {
  LogWriteError,
  SessionLogShape,
} from '@shared/session/sessionLog';
import type { PerKeyLane } from '@utils/core/perKeyQueue';
import { ensureError } from '@utils/errors/errorMessage';
import {
  FollowUpReader,
  needsWake,
  sendVerdict,
  type SendVerdict,
} from './FollowUpReader';
import { queuedRow } from './followUpMessages';

const CHANNEL = 'Inbox';

/** The session doors the inbox works through (the session layer wires them). */
interface InboxPort {
  /** The session's log: a send is one transaction. */
  readonly log: Pick<
    SessionLogShape,
    'transact' | 'runRows' | 'drained' | 'tail' | 'now'
  >;
  /** Enqueue a job on the session's publisher and return. */
  readonly detach: SessionEventsShape['detach'];
}

/** One message a producer sends: a text, with what surfaces show instead
 *  (`displayText`) and a user's media (e.g. pasted images) with its blobs
 *  (`attachedMedia`); or a child's delivery to its parent, whose facts its
 *  row keeps typed. */
export type InboxItem = (
  | {
      readonly text: string;
      readonly displayText?: string;
      readonly media?: readonly StoredMedia[];
      readonly blobs?: readonly DraftBlob[];
    }
  | { readonly delivery: ChildRunDelivery }
  /** A request of the run's own (`/compact`, a model switch), not a message. */
  | { readonly control: FollowUpControl }
) & {
  readonly from: FollowUpSender;
  /** Identity of a delivery its producer may repeat (a child's result):
   *  the row's `followUpId`, so a replay writes nothing. */
  readonly deliveryId?: string;
};

/** What a send asks of the row and of the run. */
interface SendOptions {
  /** When the row may be read (`readableMessages`). Absent: at once, or at
   *  the turn's end for a host's notification (`queuedRow`). */
  readonly hold?: QueuedFollowUp['holdUntil'];
  /** The skills the user activated with the message, which its row
   *  records; only a user's request names them. */
  readonly skills?: readonly string[];
}

/** A send decided inside a job: the row it queues, if any, and the verdict
 *  that decided it. */
type Acceptance = { rows: readonly RunInputDraft[]; sent: SendVerdict };

/** What observers hear: a run takes no more input, or the inbox closed. */
type InboxClosed =
  | { readonly kind: 'run'; readonly runId: RunId }
  | { readonly kind: 'session' };

/** The session's follow-up inbox; see the module comment. */
export class SessionInbox {
  /** Each run's sends, accepted one at a time in call order. */
  readonly sendLanes = new Map<RunId, PerKeyLane>();
  private readonly observers = new Set<(closed: InboxClosed) => void>();

  private readonly port: InboxPort;

  constructor(port: InboxPort) {
    this.port = port;
  }

  /** Append one message to the run's input in one job, as its rows decide
   *  (`sendVerdict`): a refused send and a replay write nothing. A queued
   *  row is read by the run a fiber here drives, or by its next resume,
   *  which the sender starts when the row obliges one ({@link owesResume}). */
  send(
    runId: RunId,
    item: InboxItem,
    options: SendOptions = {},
  ): Effect.Effect<SendVerdict, LogWriteError | DatabaseReadFailed> {
    return this.port.log.transact((tx) =>
      Effect.gen({ self: this }, function* () {
        const { rows, sent } = yield* this.acceptance(runId, item, options);
        if (rows.length > 0) yield* tx.append(rows);
        return sent;
      }),
    );
  }

  /** The run's reader over the session's log, for the caller's scope:
   *  ended when the run takes no more input ({@link forget},
   *  {@link dispose}). */
  reader(runId: RunId): Effect.Effect<FollowUpReader, never, Scope.Scope> {
    return Effect.map(
      Effect.acquireRelease(
        Effect.sync(() => {
          const reader = new FollowUpReader(runId, this.port.log);
          const detach = this.onClosed((closed) => {
            if (closed.kind === 'session' || closed.runId === runId)
              reader.end();
          });
          return { reader, detach };
        }),
        ({ detach }) => Effect.sync(detach),
      ),
      ({ reader }) => reader,
    );
  }

  /** A run whose loop ended and takes no more input here: the observers
   *  hear it, on the publisher after the sends already accepted, and only
   *  if none left a message queued. */
  ended(runId: RunId): void {
    this.port.detach(
      Effect.fnUntraced({ self: this }, function* () {
        if (queued(yield* this.read(runId))) return;
        this.notify({ kind: 'run', runId });
      }),
    );
  }

  /** Whether the run's input obliges a resume (`needsWake`), read once the
   *  publisher finished; a run a fiber here drives reads its input itself,
   *  which the caller checks. Undefined only if the input could not be
   *  read. */
  owesResume(runId: RunId): Effect.Effect<boolean | undefined> {
    return Effect.gen({ self: this }, function* () {
      yield* this.port.log.drained;
      return needsWake(yield* this.read(runId));
    }).pipe(
      Effect.catch((error) =>
        Effect.as(
          logFailure(
            CHANNEL,
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
    const run = runId;
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
        // Only a closed input that committed is told.
        Effect.tap((closed) => Effect.sync(() => closed && this.forget(runId))),
        Effect.asVoid,
        Effect.catch(
          logFailure(CHANNEL, `Run ${runId}: closing its input failed`),
        ),
      );
  }

  /** A run that takes no more input (deleted: its `run.removed` row closes
   *  its input; or closed): the observers hear it, its reader among them. */
  forget(runId: RunId): void {
    this.notify({ kind: 'run', runId });
  }

  /** Hear each run that takes no more input, and the inbox's own close. */
  onClosed(observer: (closed: InboxClosed) => void): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  /** The session closes: the observers hear it once. */
  dispose(): void {
    this.notify({ kind: 'session' });
    this.observers.clear();
  }

  /** One send decided in the caller's job: the verdict of the run's input
   *  rows on it, and the row the job appends with its own when the verdict
   *  queues it (see {@link send}). */
  acceptance(
    runId: RunId,
    item: InboxItem,
    options: SendOptions,
  ): Effect.Effect<Acceptance, DatabaseReadFailed> {
    return Effect.map(this.read(runId), (input) => {
      const row = queuedRow(item, options.hold, options.skills);
      const sent = sendVerdict(input, row);
      if (sent.kind !== 'queue') return { rows: [], sent };
      const queued = { type: 'followup.queued', ...row } as const;
      return { rows: [{ ...queued, aggregateId: runId }], sent };
    });
  }

  /** The run's input, lifecycle and parent as its committed rows say them. */
  readonly read = (
    runId: RunId,
  ): Effect.Effect<RunRowsRead<'input'>, DatabaseReadFailed> =>
    Effect.suspend(() => this.port.log.runRows(runId, 'input'));

  private notify(closed: InboxClosed): void {
    for (const observer of this.observers) {
      const ran = Result.try({
        try: () => observer(closed),
        catch: ensureError,
      });
      if (Result.isFailure(ran))
        this.port.detach(() =>
          logFailure(CHANNEL, 'An inbox observer threw')(ran.failure),
        );
    }
  }
}

/** Whether the run has a pending message, not just one of its own requests. */
const queued = (input: RunRowsRead<'input'>): boolean =>
  input.followUps.some(isMessage);

/** The session's follow-up inbox ({@link SessionInbox}): every run's input,
 *  which every message to a run is accepted through. Built by the session
 *  layer and disposed with the session. */
export class Inbox extends Context.Service<Inbox, SessionInbox>()(
  '@texra-ai/harness/session/Inbox',
) {}
