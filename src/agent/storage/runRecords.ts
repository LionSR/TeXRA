/**
 * Native access to a run's named records: the run-record tier of its
 * aggregate (`run.record`, `run.report`, `run.result`, ...), the terminal
 * fact, and the child loop's turn bookkeeping. Every read is a database read
 * of committed rows; nothing here reads a file, and the run loop itself
 * writes the run ledger.
 */

import { Cause, Effect } from 'effect';

import { z } from 'zod';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  isAgentRunRecord,
  RunRecordSchema,
  type RunRecord,
} from '@agent/core/definition/RunRecord';
import {
  ResultMetaSchema,
  aggregateId,
  type ResultMeta,
  type RunEnd,
  type SessionEvent,
  type SessionEventDraft,
  type RunId,
} from '@shared/schemas';
import { ensureError } from '@utils/errors/errorMessage';

/** A child launch projected from its canonical creation fact. */
export interface ChildRecord {
  readonly id: RunId;
  readonly agent: string;
  readonly timestamp: string;
}

/**
 * The structural identity of one child turn (#9531): the run is the
 * aggregate, `attemptId` the child-run attempt that accepted it, `turnIndex`
 * its position in that attempt. Minted by the child-run loop per accepted
 * turn, so the same logical delivery always carries the same identity and
 * distinct turns never share one.
 */
export interface ChildTurnKey {
  readonly attemptId: string;
  readonly turnIndex: number;
}

/**
 * Turn attribution for a child run's single latest-value report/result
 * slots: the turn currently running (or interrupted mid-flight before its
 * delivery ran) versus the latest turn whose delivery ran. Both null on a
 * run that never had turns (a run recorded before the run ledger, or one
 * whose loop never accepted a turn).
 */
export interface ChildTurnState {
  readonly active: ChildTurnKey | null;
  readonly lastCompleted: ChildTurnKey | null;
}

const sameTurn = (a: ChildTurnKey, b: ChildTurnKey): boolean =>
  a.attemptId === b.attemptId && a.turnIndex === b.turnIndex;

/**
 * Fold the run's `child.turn` rows: `accepted` opens the active turn,
 * `settled` closes it and becomes the last completed one. Reads the whole
 * aggregate, because the last completed turn can belong to an earlier
 * attempt than the active one.
 */
export function readChildTurnState(
  session: SessionHandle,
  runId: RunId,
): Effect.Effect<ChildTurnState, Error> {
  return session.readAggregate(aggregateId('run', runId)).pipe(
    Effect.map((rows) => {
      let active: ChildTurnKey | null = null;
      let lastCompleted: ChildTurnKey | null = null;
      for (const row of rows) {
        if (row.type !== 'child.turn') continue;
        const key = { attemptId: row.attemptId, turnIndex: row.turnIndex };
        if (row.phase === 'accepted') {
          active = key;
        } else {
          lastCompleted = key;
          if (active !== null && sameTurn(active, key)) active = null;
        }
      }
      return { active, lastCompleted };
    }),
    Effect.catchCause((cause) => Effect.fail(ensureError(Cause.squash(cause)))),
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

/** Native access to named run metadata, with no file-backed read arm. */
export function getRunRecords(session: SessionHandle, runId: RunId) {
  const id = aggregateId('run', runId);
  const read = <A>(
    select: (rows: readonly SessionEvent[]) => A,
  ): Effect.Effect<A, Error> =>
    session.readRunRecords(runId).pipe(
      Effect.map(select),
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause);
        return Effect.fail(
          error instanceof z.ZodError ? error : ensureError(error),
        );
      }),
    );
  const write = (draft: SessionEventDraft): Effect.Effect<void, Error> =>
    session.commit([draft]).pipe(
      Effect.asVoid,
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause);
        return Effect.fail(
          error instanceof z.ZodError ? error : ensureError(error),
        );
      }),
    );
  /** The latest `run.record` row; the database reads a closed run as absent. */
  const recordOf = (rows: readonly SessionEvent[]): RunRecord | null => {
    const event = rows.findLast(
      (row) => row.aggregateId === id && row.type === 'run.record',
    );
    return event?.type === 'run.record'
      ? RunRecordSchema.parse(event.record)
      : null;
  };
  return {
    /** The run has a `run.start` the database still lists: absent, or
     *  closed by its tombstone, reads false. */
    exists: (): Effect.Effect<boolean, Error> =>
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
    isRemoved: (): Effect.Effect<boolean, Error> =>
      session.readAggregate(id).pipe(
        Effect.map((rows) => rows.some((row) => row.type === 'run.removed')),
        Effect.catchCause((cause) =>
          Effect.fail(ensureError(Cause.squash(cause))),
        ),
      ),
    /**
     * How many times this run has been activated: once when registration
     * committed it, once more for every resume. It is the identity of a
     * lifecycle, which the terminal row alone cannot give — a resume that
     * ran to its own end usually ends `completed` too, so a caller holding a
     * result cannot separate the row that carried it from a later row of the
     * same outcome. Reads the aggregate, because the record read keeps only
     * the latest row of each type.
     */
    countActivations: (): Effect.Effect<number, Error> =>
      session.readAggregate(id).pipe(
        Effect.map(
          (rows) => rows.filter((row) => row.type === 'run.activate').length,
        ),
        Effect.catchCause((cause) =>
          Effect.fail(ensureError(Cause.squash(cause))),
        ),
      ),
    readRunRecord: (): Effect.Effect<RunRecord | null, Error> => read(recordOf),
    readConfig: (): Effect.Effect<AgentConfig | null, Error> =>
      read((rows) => {
        const record = recordOf(rows);
        return record && isAgentRunRecord(record) ? record : null;
      }),
    readReport: (): Effect.Effect<string | null, Error> =>
      read((rows) => {
        const event = rows.findLast(
          (row) => row.aggregateId === id && row.type === 'run.report',
        );
        return event?.type === 'run.report' ? event.report : null;
      }),
    readWorkspaceFiles: (): Effect.Effect<string[], Error> =>
      read((rows) => {
        const event = rows.findLast(
          (row) => row.aggregateId === id && row.type === 'run.workspaceFiles',
        );
        return event?.type === 'run.workspaceFiles' ? event.paths : [];
      }),
    readResultMeta: (): Effect.Effect<ResultMeta | null, Error> =>
      read((rows) => {
        const event = rows.findLast(
          (row) => row.aggregateId === id && row.type === 'run.result',
        );
        return event?.type === 'run.result' ? event.result : null;
      }),
    /** The run's terminal fact: outcome, error, usage and the flow's output. */
    readRunEnd: (): Effect.Effect<RunEnd | null, Error> =>
      read((rows) => {
        const end = runEndFromEvents(rows, runId);
        if (!end) return null;
        const { outcome, error, usage, output } = end;
        return {
          outcome,
          ...(error !== undefined ? { error } : {}),
          ...(usage !== undefined ? { usage } : {}),
          output,
        };
      }),
    writeRunRecord: (record: RunRecord) =>
      Effect.suspend(() =>
        write({
          type: 'run.record',
          aggregateId: id,
          record: RunRecordSchema.parse(record),
        }),
      ),
    clearReport: () =>
      write({ type: 'run.report', aggregateId: id, report: null }),
    writeReport: (report: string) =>
      write({ type: 'run.report', aggregateId: id, report }),
    writeWorkspaceFiles: (paths: readonly string[]) =>
      write({
        type: 'run.workspaceFiles',
        aggregateId: id,
        paths: [...paths],
      }),
    writeResultMeta: (result: ResultMeta) =>
      Effect.suspend(() =>
        write({
          type: 'run.result',
          aggregateId: id,
          result: ResultMetaSchema.parse(result),
        }),
      ),
  };
}
