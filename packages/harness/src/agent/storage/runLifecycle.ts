/** A run's registration, a resume's activation, a stop and a run's end:
 *  the lifecycle rows, each built by the transaction that commits it
 *  (record accessors: `runRecords.ts`). */

import { Context, Effect, Result, Schema } from 'effect';
import stableStringify from 'safe-stable-stringify';

import { Inbox } from '@agent/followUp/Inbox';
import { formatDelivery } from '@agent/runtime/deliveryEnvelope';
import { consumedRows } from '@agent/runtime/loop/rows';
import { SessionRoots } from '@platform/rootedFs';
import { NO_APPROVAL_GRANTS } from '@shared/approvalBypassKind';
import {
  emptyRunEndOutput,
  runEndErrorMessage,
  RUN_OUTCOME,
  RunRecordFieldsSchema,
  type ChildRunDelivery,
  type SessionRowDraft,
  type RunEnd,
  type RunEndOutput,
  type RunId,
  type RunOutcome,
  type RunStopReason,
  type RunRecord,
} from '@shared/schemas';
import {
  Approvals,
  RunHistory,
  runReadRefusal,
  SessionLog,
} from '@shared/session/runHistory';
import {
  descriptionRow,
  type RegisterRunOptions,
} from '@shared/session/runFacts';
import { reportRecipients } from '@shared/session/runRowReads';
import type { RunRows } from '@shared/session/runRowsShape';
import {
  cancelRequestRows,
  type RunInputDraft,
} from '@shared/session/runState';
import type { UnfoldedDraft } from '@shared/session/sessionEvents';
import type { SessionTransaction } from '@shared/session/sessionLog';
import { getRunRecords } from './runOwnership';

function pinRunWorkingDirectory(record: RunRecord, root?: string): RunRecord {
  // First non-blank wins, untrimmed: a trimmed path was once mangled.
  const workingDirectory = [record.workingDirectory, root].find((dir) =>
    dir?.trim(),
  );
  return workingDirectory ? { ...record, workingDirectory } : record;
}

/** A child that cannot register under its parent: the parent is gone, or
 *  was stopped. */
class ParentRunClosed extends Schema.TaggedError<ParentRunClosed>()(
  'ParentRunClosed',
  { message: Schema.String },
) {}

type RunConfigRow = Extract<SessionRowDraft, { readonly type: 'run.config' }>;

/** The rows that register a run, and the `run.start` among them of a run
 *  they give birth to (null: the run exists, and they re-register it). */
export interface Registration {
  readonly rows: readonly SessionRowDraft[];
  readonly start: Extract<SessionRowDraft, { type: 'run.start' }> | null;
  /** Its configuration as a `run.config`, apart from `rows`, so the batch
   *  that commits them records one: a run whose loop is not this
   *  process's records this one (`registerRun`), as does a fork of a run
   *  that never bound (`forkRun`); a launch that binds a model records its
   *  own, with the binding (`openToolUse`). */
  readonly config: RunConfigRow;
}

/** What opening a run's rows reads of its session. */
type OpenServices = SessionLog | SessionRoots | Approvals;

/** A resume's activation: its `run.activate`, the grants it ends, and a
 *  `run.config` if its configuration changed (its model kept: only a
 *  switch moves it). Read in the activation's transaction. */
export const activationRows = Effect.fn('activationRows')(function* (
  runId: RunId,
  config: RunRecord,
): Effect.fn.Return<readonly SessionRowDraft[], Error, OpenServices> {
  const stored = yield* getRunRecords(runId).readRunRecord();
  const next = yield* Schema.decodeUnknownEffect(RunRecordFieldsSchema)(
    pinRunWorkingDirectory(
      stored?.model === undefined ? config : { ...config, model: stored.model },
      (yield* SessionRoots).workspace,
    ),
  );
  const changed =
    stored === null || stableStringify(stored) !== stableStringify(next);
  return [
    { type: 'run.activate', aggregateId: runId },
    ...(yield* (yield* Approvals).activationRows(runId)),
    ...(changed
      ? [{ type: 'run.config' as const, aggregateId: runId, config: next }]
      : []),
  ];
});

/** Register a run whose loop is not this process's (an agent CLI, bash)
 *  alone, its configuration with it; a run this process's loop drives
 *  registers with its opening. */
export const registerRun = Effect.fn('registerRun')(function* (
  runId: RunId,
  record: RunRecord,
  options: RegisterRunOptions,
): Effect.fn.Return<void, Error, OpenServices | RunHistory> {
  const opens = yield* registrationRows(runId, record, options);
  const rows = Effect.succeed([...opens.rows, opens.config]);
  const born = opens.start !== null;
  const cell = yield* (yield* RunHistory).open(
    runId,
    born ? { registration: rows } : { activation: () => rows },
  );
  if (born) yield* cell.append([]);
});

/** The rows that register a run, uncommitted, in commit order: a new run's
 *  `run.start`, its `run.activate` (a re-registration's with the grants it
 *  ends) and the description it is born with; and its configuration, for
 *  its first batch to record ({@link Registration}). A caller commits them
 *  with the run's first history in one batch, so no crash leaves it
 *  registered without that history. A child is refused under a parent that
 *  was stopped. */
export const registrationRows = Effect.fn('registrationRows')(function* (
  runId: RunId,
  record: RunRecord,
  options: RegisterRunOptions,
): Effect.fn.Return<Registration, Error, OpenServices> {
  const prior = yield* getRunRecords(runId).exists();
  const parentId = options.parent?.id;
  if (parentId !== undefined) {
    // The database refuses a closed or unborn parent; this only words
    // the refusal.
    const log = yield* SessionLog;
    const parent = yield* log.facts(parentId);
    if (parent === null)
      return yield* new ParentRunClosed({
        message: `Parent run ${parentId} is unavailable.`,
      });
    if (parent.stop !== null || parent.end !== null)
      return yield* new ParentRunClosed({
        message: `Cannot launch child run ${runId} under run ${parentId}: that run was stopped.`,
      });
  }
  const config = yield* Schema.decodeUnknownEffect(RunRecordFieldsSchema)(
    pinRunWorkingDirectory(record, (yield* SessionRoots).workspace),
  );
  const worktree = config.workingDirectory?.trim();
  const start = prior
    ? null
    : ({
        type: 'run.start',
        aggregateId: runId,
        identity: options.identity,
        takesFollowUps: options.takesFollowUps ?? false,
        worktree: worktree ? { workingDirectory: worktree } : null,
        parent: options.parent ?? null,
        provenance: options.provenance ?? null,
        grants: options.grants ?? NO_APPROVAL_GRANTS,
      } satisfies Registration['start']);
  const rows: SessionRowDraft[] = [
    ...(start === null ? [] : [start]),
    { type: 'run.activate', aggregateId: runId },
    ...(prior ? yield* (yield* Approvals).activationRows(runId) : []),
  ];
  if (options.description !== undefined)
    rows.push(descriptionRow(runId, options.description, 'model'));
  return {
    rows,
    start,
    config: { type: 'run.config', aggregateId: runId, config },
  } satisfies Registration;
});

/** What ends a run: its outcome and the facts its `run.end` carries. */
export interface RunEnding {
  readonly runId: RunId;
  readonly outcome: RunOutcome;
  /** The classified error behind a FAILED outcome, when the run has one. */
  readonly error?: RunEnd['error'];
  /** What the run produced; absent (empty) for a stop's end or a child. */
  readonly output?: RunEndOutput;
  /** The run's report: its delivery, kept rendered as the run's
   *  `run.report` (the envelope a recipient's model reads) and queued typed
   *  on the input of each run it worked for, unless that run's call awaits
   *  it (it reads the report itself). Null, or absent: nothing to report
   *  (a stop). */
  readonly report?: ChildRunDelivery | null;
  /** Rows committed ahead of the end (a process run's exit). */
  readonly leading?: readonly UnfoldedDraft[];
}

/** The `run.end` the store holds once the transaction committed, and
 *  whether this call wrote it (an earlier end of the lifecycle stands). */
interface EndedRun {
  readonly end: Omit<RunEnd, 'usage'> | null;
  readonly wrote: boolean;
}

/** What a run's end reads of its session. */
type EndServices = SessionLog | Inbox | RunHistory;

/** The caller's {@link EndServices}, for the end's transaction job. Picked
 *  when asked: the inbox's module and this one import each other. */
const endServices = Effect.suspend(() =>
  Effect.map(
    Effect.context<EndServices>(),
    Context.pick(SessionLog, Inbox, RunHistory),
  ),
);

const endOf = (end: Omit<RunEnd, 'usage'>): Omit<RunEnd, 'usage'> => ({
  outcome: end.outcome,
  ...(end.error !== undefined && { error: end.error }),
  output: end.output,
});

/**
 * The id a run's report is queued under on each recipient's input, one per
 * lifecycle (`${runId}:${activation}`): a replay of the delivery writes
 * nothing, and a second delivery of one lifecycle is a duplicate. A
 * lifecycle delivers once, by its end's report or, for one a dead process
 * cut short, by the notice that it was interrupted.
 */
export const deliveryId = (runId: RunId, facts: RunRows): string =>
  `${runId}:${facts.activation?.commit ?? 0}`;

/**
 * A run's report queued on the input of each run it works for, decided in
 * the job committing its end, under the lifecycle's {@link deliveryId}:
 * the runs {@link reportRecipients} names. A closed, deleted or unreadable recipient
 * refuses it, with a warning once the job commits; the run's own rows
 * still commit.
 */
const replyDelivery = Effect.fn('replyDelivery')(function* (
  runId: RunId,
  facts: RunRows,
  delivery: ChildRunDelivery,
): Effect.fn.Return<readonly RunInputDraft[], never, Inbox> {
  const inbox = yield* Inbox;
  const undelivered = (why: string, error?: Error) =>
    Effect.as(
      Effect.logWarning(
        `Run ${runId}: its report was not delivered; ${why}. The report stays on the run.`,
      ).pipe(Effect.annotateLogs({ data: error })),
      [],
    );
  const input = yield* Effect.result(inbox.read(runId));
  if (Result.isFailure(input))
    return yield* undelivered('its own input cannot be read', input.failure);
  const recipients = reportRecipients(
    input.success.asked,
    facts.start?.parent ?? null,
  );
  const item = {
    delivery,
    from: { kind: 'run', runId } as const,
    deliveryId: deliveryId(runId, facts),
  };
  const rows: RunInputDraft[] = [];
  for (const recipient of recipients) {
    const accepted = yield* Effect.result(
      inbox.acceptance(recipient, item, {}),
    );
    if (Result.isFailure(accepted))
      yield* undelivered(
        `run ${recipient} is closed or cannot be read`,
        accepted.failure,
      );
    else if (accepted.success.sent.kind === 'refused')
      yield* undelivered(`the input of run ${recipient} is closed`);
    else rows.push(...accepted.success.rows);
  }
  return rows;
});

/**
 * The runs `runId`'s last end reported to: whose input holds that report,
 * and who is woken for it once the run's fiber is gone. None before its
 * first end.
 */
export const lastReportRecipients = Effect.fn('lastReportRecipients')(
  function* (runId: RunId) {
    const { atEnd } = (yield* (yield* Inbox).read(runId)).asked;
    if (atEnd === null) return [];
    const facts = yield* (yield* SessionLog).facts(runId);
    return reportRecipients(atEnd, facts?.start?.parent ?? null);
  },
);

/**
 * A run's end in `tx`'s job, decided from what it reads under the lock:
 * the requests it leaves open cancelled, a root's pending controls dropped
 * (its queued messages stay for its resume, and so does all of a child's
 * input), its closure, its `run.end`, its report with the delivery to the run it
 * works for ({@link replyDelivery}), and `leading` rows ahead of them (a stop's
 * `run.stop`, a process run's exit). A run never created has nothing to
 * end; one that ended in its current lifecycle keeps that end. A run whose
 * rows this build cannot load ends unloaded, with a warning, requests
 * uncancelled.
 */
const endIn = Effect.fn('endIn')(function* (
  tx: Pick<SessionTransaction, 'append'>,
  input: RunEnding,
  leading: readonly UnfoldedDraft[] = [],
): Effect.fn.Return<EndedRun, Error, EndServices> {
  const { append } = tx;
  const { runId, outcome, error } = input;
  const log = yield* SessionLog;
  const facts = yield* log.facts(runId);
  if (facts === null) return { end: null, wrote: false };
  const ahead = [...leading, ...(input.leading ?? [])];
  if (facts.end !== null) {
    if (error !== undefined)
      yield* Effect.logWarning(
        `Run ${runId} had ended: ${runEndErrorMessage(error)}`,
      );
    if (ahead.length > 0) yield* append(ahead);
    return { end: endOf(facts.end), wrote: false };
  }
  // Why a cancelled run stopped is its `run.stop` row, not its end's.
  const end = {
    type: 'run.end' as const,
    aggregateId: runId,
    outcome,
    ...(error && { error }),
    output: input.output ?? emptyRunEndOutput(),
  };
  const unapplied =
    facts.start?.parent == null
      ? (yield* (yield* Inbox).read(runId)).followUps
      : [];
  const target = runId;
  const report =
    input.report == null
      ? []
      : [
          {
            type: 'run.report' as const,
            aggregateId: target,
            report: formatDelivery(input.report),
          },
          ...(yield* replyDelivery(runId, facts, input.report)),
        ];
  const beside = [
    ...ahead,
    ...consumedRows(runId)(unapplied, { kind: 'dropped', reason: 'ended' }),
    ...log.closure(runId),
    end,
    ...report,
  ];
  const cell = yield* Effect.result(
    (yield* RunHistory).open(runId, { within: append }),
  );
  if (Result.isSuccess(cell)) {
    const cancels = cancelRequestRows(
      runId,
      yield* cell.success.current,
      'The run ended.',
    );
    yield* cell.success.append(cancels, Effect.succeed(beside));
  } else {
    if (runReadRefusal(cell.failure) === undefined) return yield* cell.failure;
    yield* Effect.logWarning(
      `Run ${runId} ends unloaded: ${cell.failure.message}`,
    );
    yield* append(beside);
  }
  return { end: endOf(end), wrote: true };
});

/**
 * The one transaction of a run's end ({@link endIn}), run by the fiber
 * that drove the run as it exits, or by a stop for a run no fiber drives.
 * A failed transaction fails the caller: the run then reads as interrupted
 * at its next open, which is the truth, since the process could not write
 * its end.
 */
export const endRunRows = Effect.fn('endRunRows')(function* (
  input: RunEnding,
): Effect.fn.Return<EndedRun, Error, EndServices> {
  const log = yield* SessionLog;
  const services = yield* endServices;
  return yield* log.transact((tx) =>
    endIn(tx, input).pipe(Effect.provide(services)),
  );
});

/**
 * The rows a stop commits for `runId`: its `run.stop` row, and, for a run
 * no fiber here drives (`end`), its CANCELLED end in the same batch. A run
 * whose lifecycle ended gets none: there is nothing to stop. The first stop
 * of a lifecycle stands, and a second ask adds no row. Answers whether the run has rows at all:
 * one that has none yet is a launch that has not registered.
 */
export const stopRun = Effect.fn('stopRun')(function* (
  runId: RunId,
  reason: RunStopReason,
  end: boolean,
): Effect.fn.Return<boolean, Error, EndServices> {
  const log = yield* SessionLog;
  const services = yield* endServices;
  return yield* log.transact((tx) =>
    Effect.gen(function* () {
      const facts = yield* log.facts(runId);
      if (facts === null) return false;
      if (facts.end !== null) return true;
      const stop =
        facts.stop === null
          ? [
              {
                type: 'run.stop',
                aggregateId: runId,
                reason,
              } as const,
            ]
          : [];
      if (!end) {
        if (stop.length > 0) yield* tx.append(stop);
        return true;
      }
      yield* endIn(tx, { runId, outcome: RUN_OUTCOME.CANCELLED }, stop);
      return true;
    }).pipe(Effect.provide(services)),
  );
});
