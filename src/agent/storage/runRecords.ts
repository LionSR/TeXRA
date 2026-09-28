/**
 * Native access to a run's named records: the run-record tier of its
 * aggregate (`run.config`, `run.report`, `run.result`, ...), the terminal
 * fact, and the child loop's turn bookkeeping. Every read is a database read
 * of committed rows; nothing here reads a file, and the run loop itself
 * writes the run ledger.
 */

import { Effect, Result } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  isAgentRunRecord,
  type RunRecord,
} from '@agent/core/definition/RunRecord';
import type {
  DatabaseNotOwner,
  DatabaseReadFailed,
  DatabaseWriteFailed,
} from '@shared/session/database';
import { foldAttempts, type AttemptKey } from '@shared/session/attemptFold';
import { foldRunState } from '@shared/session/runStateFold';
import {
  ResultMetaSchema,
  storedResultMeta,
  WorkflowRunEndOutputSchema,
  aggregateId,
  roundOutputsToCompileFailureSummaries,
  roundOutputsToOutputSummaries,
  RunWorkspaceFilesSchema,
  type AggregateId,
  type DeliveredResult,
  type ResultMeta,
  type RunEnd,
  type SessionEvent,
  type SessionEventDraft,
  type RunId,
} from '@shared/schemas';

import { deliveredOutput, type RunResult } from './resultMeta';

/**
 * Turn attribution for a child run's single latest-value report/result
 * slots: the turn currently running (or interrupted mid-flight before its
 * delivery ran) versus the latest turn whose delivery ran. Both null on a
 * run that never had turns (a run recorded before the run ledger, or one
 * whose loop never accepted a turn). Its keys are the shared
 * {@link AttemptKey}: `key` is the child-run attempt that accepted the turn,
 * `index` the turn's position in that attempt.
 */
interface ChildTurnState {
  readonly active: AttemptKey | null;
  readonly lastCompleted: AttemptKey | null;
}

/**
 * Fold the run's `child.turn` rows through the shared attempt fold:
 * `accepted` opens the turn, `settled` closes it and becomes the last
 * completed one. Reads every `child.turn` row, because the last completed
 * turn can belong to an earlier attempt than the active one — which is also why
 * it reads the fold's open/settled pair rather than its high-water mark: a
 * child's series restarts with every attempt.
 */
export function readChildTurnState(
  session: SessionHandle,
  runId: RunId,
): Effect.Effect<ChildTurnState, DatabaseReadFailed> {
  return session.readAggregate(aggregateId('run', runId), ['child.turn']).pipe(
    Effect.map((rows) => {
      const turns = foldAttempts(rows, (row) =>
        row.type === 'child.turn'
          ? {
              attempt: { key: row.attemptId, index: row.turnIndex },
              settled: row.phase === 'settled',
            }
          : null,
      );
      return { active: turns.open, lastCompleted: turns.settled };
    }),
  );
}

/**
 * The run's terminal fact for the lifecycle it is in now, or null while this
 * lifecycle has not ended. "Ended" is a fact about the current lifecycle, not
 * about the aggregate: every activation publishes a `run.activate` row (the
 * launch and each resume), so a `run.activate` after the previous `run.end`
 * means the run started again and the earlier terminal fact belongs to the
 * lifecycle before it. Reading the aggregate's last `run.end` instead would
 * leave a resumed run carrying the outcome of a lifecycle it has already
 * left. Shared with `finalizeRun`, the row's one writer, so writer and
 * readers scope it identically.
 */
export function runEndFromEvents(
  rows: readonly SessionEvent[],
  runId: RunId,
): Extract<SessionEvent, { type: 'run.end' }> | null {
  const id = aggregateId('run', runId);
  const lifecycle = rows.findLast(
    (row): row is Extract<SessionEvent, { type: 'run.end' | 'run.activate' }> =>
      row.aggregateId === id &&
      (row.type === 'run.end' || row.type === 'run.activate'),
  );
  return lifecycle?.type === 'run.end' ? lifecycle : null;
}

/**
 * A run's persisted parent edge: the fold's (`run.start.parent`, severed by
 * a later `run.detach`, and dropped once the parent is no longer listed),
 * read cold from the two runs' records so a read racing the live fold's
 * first replay still sees it.
 *
 * The one rule every resume family shares, and the one site that derives it:
 * a resumed run takes its lineage from the log, never from its caller, who
 * has no parent to name for a run that already started once. `runAgent`
 * tracks a launch handle before this read (so a stop during it has a
 * target) and then installs the edge on that handle, so a stop of the
 * parent sees the child from that moment on; the tool-use resume arm reads
 * it for the handle its own lifecycle registers.
 */
export const persistedParentRunId = Effect.fn('persistedParentRunId')(
  function* (session: SessionHandle, runId: RunId) {
    const edge = (yield* session.readRunRecords(runId)).findLast(
      (row) => row.type === 'run.start' || row.type === 'run.detach',
    );
    if (edge?.type !== 'run.start' || edge.parent === null) return undefined;
    const parent = edge.parent.id;
    return (yield* getRunRecords(session, parent).exists())
      ? parent
      : undefined;
  },
);

/**
 * The run's latest row of one type, or null. The one latest-row reader every
 * named record goes through: the read already keeps only the newest row of
 * each type per aggregate, so "latest" is `findLast` over what it returned,
 * and the row's own fields need no parse of their own — `SessionEventSchema`
 * carries them, so the database's decode already refused a row that does not
 * match, as `DatabaseReadFailed`.
 */
function latestOfType<T extends SessionEvent['type']>(
  rows: readonly SessionEvent[],
  id: AggregateId,
  type: T,
): Extract<SessionEvent, { type: T }> | null {
  return (
    rows.findLast(
      (row): row is Extract<SessionEvent, { type: T }> =>
        row.aggregateId === id && row.type === type,
    ) ?? null
  );
}

/** Native access to named run metadata, with no file-backed read arm. */
export function getRunRecords(session: SessionHandle, runId: RunId) {
  const id = aggregateId('run', runId);
  /** A workflow run's files: its newest `output.produced` row's rounds. */
  const workflowOutputOf = (rows: readonly SessionEvent[]) => {
    const rounds = latestOfType(rows, id, 'output.produced')?.rounds ?? [];
    return WorkflowRunEndOutputSchema.parse({
      category: 'workflow',
      outputs: roundOutputsToOutputSummaries(rounds),
      compileFailures: roundOutputsToCompileFailureSummaries(rounds),
    });
  };
  /**
   * The run's terminal result: the `run.end` row's outcome, error and
   * tool-use reply, a workflow run's files ({@link workflowOutputOf}), and
   * the usage the run ledger folds from its priced response rows. Absent
   * usage is a run with no ledger (an agent-CLI child, a launch that failed
   * before its first batch); an unreadable ledger is logged and reads the
   * same, so it never also costs the run its terminal fact.
   */
  const runEndOf = (rows: readonly SessionEvent[]) =>
    Effect.gen(function* () {
      const end = runEndFromEvents(rows, runId);
      if (!end) return null;
      // The usage is folded from these same rows, so the terminal fact and
      // the totals come from one read and a resume can never pair them
      // across two.
      const folded = foldRunState(null, rows);
      if (Result.isFailure(folded)) {
        yield* Effect.logWarning(
          'Failed to fold the run usage from its ledger rows',
        ).pipe(Effect.annotateLogs({ runId, error: folded.failure.message }));
      }
      const usage = Result.isSuccess(folded)
        ? folded.success?.usage
        : undefined;
      const { outcome, error, output } = end;
      return {
        outcome,
        ...(error !== undefined ? { error } : {}),
        ...(usage !== undefined ? { usage } : {}),
        output:
          output.category === 'workflow' ? workflowOutputOf(rows) : output,
      } satisfies RunEnd;
    });
  /** Every row of the run, in one read; none for a closed (tombstoned) run,
   *  which the record reads report as absent too. */
  const runRows = session
    .readAggregate(id)
    .pipe(
      Effect.map((rows) => (rows.at(-1)?.type === 'run.removed' ? [] : rows)),
    );
  const read = <A>(
    select: (rows: readonly SessionEvent[]) => A,
  ): Effect.Effect<A, DatabaseReadFailed> =>
    session.readRunRecords(runId).pipe(Effect.map(select));
  const write = (
    draft: SessionEventDraft,
  ): Effect.Effect<void, DatabaseNotOwner | DatabaseWriteFailed> =>
    session.commit([draft]).pipe(Effect.asVoid);
  /** The latest `run.config` row; the database reads a closed run as absent. */
  const readRecord = (): Effect.Effect<RunRecord | null, DatabaseReadFailed> =>
    read((rows) => latestOfType(rows, id, 'run.config')?.config ?? null);
  return {
    /** The run has a `run.start` the database still lists: absent, or
     *  closed by its tombstone, reads false. */
    exists: (): Effect.Effect<boolean, DatabaseReadFailed> =>
      read((rows) =>
        rows.some((row) => row.aggregateId === id && row.type === 'run.start'),
      ),
    /**
     * The run is closed by its tombstone. This is the fact {@link exists}
     * cannot report: the listing drops a closed run entirely, so an id the
     * user deleted and one that never started read alike there. A
     * `run.removed` row is the aggregate's last row and is final, so the id
     * can never start again; deletion later collects the aggregate outright,
     * and an id with nothing behind it is free to start. Reads the aggregate,
     * because a closed run's records are no longer listed.
     */
    isRemoved: (): Effect.Effect<boolean, DatabaseReadFailed> =>
      session
        .readAggregate(id, ['run.removed'])
        .pipe(Effect.map((rows) => rows.length > 0)),
    /**
     * How many times this run has been activated: once when registration
     * committed it, once more for every resume. It is the identity of a
     * lifecycle, which the terminal row alone cannot give — a resume that
     * ran to its own end usually ends `completed` too, so a caller holding a
     * result cannot separate the row that carried it from a later row of the
     * same outcome. Reads every `run.activate` row, because the record read
     * keeps only the latest row of each type.
     */
    countActivations: (): Effect.Effect<number, DatabaseReadFailed> =>
      session
        .readAggregate(id, ['run.activate'])
        .pipe(Effect.map((rows) => rows.length)),
    readRunRecord: readRecord,
    readConfig: (): Effect.Effect<AgentConfig | null, DatabaseReadFailed> =>
      readRecord().pipe(
        Effect.map((record) =>
          record && isAgentRunRecord(record) ? record : null,
        ),
      ),
    readReport: (): Effect.Effect<string | null, DatabaseReadFailed> =>
      read((rows) => latestOfType(rows, id, 'run.report')?.report ?? null),
    /**
     * The workspace files the run edited: the edits its ledger folds into
     * the loop state's workspace snapshot (each `tool.result` sets it, each
     * turn-end snapshot restates it), the one record of them. A run with no
     * ledger edited nothing here; an unreadable ledger is logged and reads
     * as no files, as {@link runEndOf} reads its usage.
     */
    readWorkspaceFiles: (): Effect.Effect<string[], DatabaseReadFailed> =>
      runRows.pipe(
        Effect.flatMap((rows) =>
          Effect.gen(function* () {
            const folded = foldRunState(null, rows);
            if (Result.isFailure(folded)) {
              yield* Effect.logWarning(
                'Failed to fold the run edits from its ledger rows',
              ).pipe(
                Effect.annotateLogs({ runId, error: folded.failure.message }),
              );
              return [];
            }
            const edits =
              folded.success?.loop?.stateSlices?.workspaceSnapshot.interactions
                .edits ?? [];
            return RunWorkspaceFilesSchema.parse(edits.map((e) => e.path));
          }),
        ),
      ),
    readResultMeta: (): Effect.Effect<ResultMeta | null, DatabaseReadFailed> =>
      read((rows) => latestOfType(rows, id, 'run.result')?.result ?? null),
    /** The run's terminal result ({@link runEndOf}), or null while the
     *  lifecycle it is in has not ended. */
    readRunEnd: (): Effect.Effect<RunEnd | null, DatabaseReadFailed> =>
      runRows.pipe(Effect.flatMap(runEndOf)),
    /**
     * The run's result endpoint: its producer record joined to its terminal
     * result, carrying the output as the delivery reported it
     * ({@link deliveredOutput}), with the producer's own context dropped.
     * Null when no producer recorded one; the terminal fields are absent
     * while the run has not ended. A background command is its own result:
     * the `run.end` row of the run that launched it says nothing about the
     * command, so that record passes through whole.
     */
    readResult: (): Effect.Effect<RunResult | null, DatabaseReadFailed> =>
      Effect.gen(function* () {
        const rows = yield* runRows;
        const meta = latestOfType(rows, id, 'run.result')?.result ?? null;
        if (meta === null || meta.producer === 'backgroundBash') return meta;
        const end = yield* runEndOf(rows);
        return {
          ...(end ?? {}),
          output: deliveredOutput(meta, end?.output ?? workflowOutputOf(rows)),
        };
      }),
    clearReport: () =>
      write({ type: 'run.report', aggregateId: id, report: null }),
    writeResultMeta: (result: DeliveredResult) =>
      Effect.suspend(() =>
        write({
          type: 'run.result',
          aggregateId: id,
          result: ResultMetaSchema.parse(storedResultMeta(result)),
        }),
      ),
  };
}
