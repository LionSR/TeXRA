/**
 * One connection's reader of selected rows: each decoded by the row codec
 * (`./rowCodec`), and the runs it cannot open, each with why: a row that
 * does not decode (damaged), or one an earlier build wrote at a version this
 * build has no upcaster for. Those are found as reads meet them, and the
 * earlier build's rows all at once on the first `damaged`, since the listing
 * never reads a run's history.
 */
import { Effect, Result } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import {
  RUN_DAMAGED_MESSAGE,
  RUN_EARLIER_BUILD_MESSAGE,
} from '@shared/runs/runStatusDisplay';
import {
  ROW_KINDS,
  RunIdSchema,
  type LocalRuntimeState,
  type RunId,
  type SessionEvent,
  type SessionEventDraft,
} from '@shared/schemas';
import type {
  DatabaseRowCorrupt,
  DatabaseStoreNewer,
} from '@shared/session/database';
import type { PluginArms } from '@tools/plugins';

import {
  aggregateOf,
  decodeRow,
  EVENT_FROM,
  readableFrom,
  RowSchema,
  type SqlRow,
} from './rowCodec';

/** The kinds an earlier build may have written at a version this one cannot
 *  read, each with the lowest version it reads. */
const EARLIER = (Object.keys(ROW_KINDS) as SessionEventDraft['type'][]) // cast: the record's keys are its kinds
  .flatMap((type) =>
    readableFrom(type) > 1 ? [[type, readableFrom(type)] as const] : [],
  );

/** The runs holding a row of a kind below the version this build reads. */
const EARLIER_RUNS = `SELECT DISTINCT s.logical_id AS logicalId FROM ${EVENT_FROM}
  WHERE s.kind = 'run' AND e.type = ? AND e.version < ?`;

/** A selected row's reader, and the runs it found it cannot open. */
export interface RowReader {
  /** The events of `rows`. A newer row fails the read; one that does not
   *  decode fails a strict read (`whole`: a run's history and its records),
   *  so no decision is made from part of a run's rows, and is left out of a
   *  wide read (tail, listing, projections) with one warning, so one bad row
   *  never costs the session. An absent plugin's kind is left out, warned. */
  readonly read: (
    rows: readonly SqlRow[],
    whole: boolean,
  ) => Effect.Effect<
    readonly SessionEvent[],
    DatabaseStoreNewer | DatabaseRowCorrupt
  >;
  /** Every run found unopenable so far, with why: shown read-only. The
   *  first call also finds, through `exec`, every run holding an earlier
   *  build's rows, which no wide read meets. */
  readonly damaged: <E>(
    exec: (
      statement: string,
      params: readonly unknown[],
    ) => Effect.Effect<readonly SqlRow[], E>,
  ) => Effect.Effect<LocalRuntimeState['unreadable'], E>;
}

/** The reader of the store at `path`, over the process's plugin `arms`. */
export function rowReader(path: string, arms: PluginArms): RowReader {
  const warned = new Set<string>();
  const unopenable = new Map<RunId, string>();
  let scanned = false;
  const mark = (runId: RunId, earlier: boolean) => {
    if (!unopenable.has(runId))
      unopenable.set(
        runId,
        earlier ? RUN_EARLIER_BUILD_MESSAGE : RUN_DAMAGED_MESSAGE,
      );
  };
  const warnOnce = (key: string, message: string) =>
    warned.has(key)
      ? Effect.void
      : Effect.sync(() => warned.add(key)).pipe(
          Effect.andThen(Effect.logWarning(message)),
          withLogChannel('sessionDatabase'),
        );
  const read = (rows: readonly SqlRow[], whole: boolean) =>
    Effect.gen(function* () {
      const events: SessionEvent[] = [];
      for (const row of rows) {
        const decoded = decodeRow(row, arms);
        if (Result.isSuccess(decoded)) {
          if (!('_tag' in decoded.success)) events.push(decoded.success);
          else
            yield* warnOnce(
              decoded.success.kind,
              `${path} holds rows of the plugin kind ${decoded.success.kind}, whose plugin this build lacks; they stay in the store and are left out of every read.`,
            );
          continue;
        }
        if (whole || decoded.failure._tag === 'DatabaseStoreNewer')
          return yield* Effect.fail(decoded.failure);
        yield* warnOnce(
          `${decoded.failure.commit}`,
          `${path}: ${decoded.failure.message} It is left out of the listing and the tail, and its run is shown as unreadable and cannot be opened.`,
        );
        const { kind, logicalId } = RowSchema.parse(row);
        if (kind === 'run')
          mark(RunIdSchema.parse(logicalId), decoded.failure.earlier === true);
        const start = bareStart(row);
        if (start !== null) events.push(start);
      }
      return events;
    });
  return {
    read,
    damaged: (exec) =>
      Effect.gen(function* () {
        for (const [type, floor] of scanned ? [] : EARLIER)
          for (const { logicalId } of yield* exec(EARLIER_RUNS, [type, floor]))
            mark(RunIdSchema.parse(logicalId), true);
        scanned = true;
        return [...unopenable].map(([runId, detail]) => ({ runId, detail }));
      }),
  };
}

/** A damaged `run.start` as a bare one, so its run still lists. */
function bareStart(input: SqlRow): SessionEvent | null {
  const row = RowSchema.parse(input);
  if (row.type !== 'run.start' || row.kind !== 'run') return null;
  return {
    type: 'run.start',
    aggregateId: aggregateOf(row.kind, row.logicalId),
    seq: row.seq,
    commit: row.commit,
    origin: row.origin,
    at: row.at,
    identity: { kind: 'agent', agent: 'unknown' },
    userFollowUpSupport: 'unsupported',
    parent: null,
    provenance: null,
  };
}
