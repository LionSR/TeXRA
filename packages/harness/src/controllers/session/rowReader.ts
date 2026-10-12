/**
 * One connection's reader of selected rows: each decoded by the row codec
 * (`./rowCodec`), and the runs it cannot open, each with why: a row that
 * does not decode (damaged), or one an earlier build wrote at a version this
 * build has no upcaster for. Those are found as reads meet them, and the
 * earlier build's rows all at once on the first `damaged`, since the listing
 * never reads a run's history.
 */
import { Effect, Result } from 'effect';
import { z } from 'zod';

import { withLogChannel } from '@logger/effectLog';
import {
  RUN_DAMAGED_MESSAGE,
  RUN_EARLIER_BUILD_MESSAGE,
} from '@shared/runs/runStatusDisplay';
import {
  RunIdSchema,
  type LocalRuntimeState,
  type RunId,
  type SessionEvent,
} from '@shared/schemas';
import {
  DatabaseRowEarlier,
  type DatabaseRowCorrupt,
  type DatabaseStoreNewer,
} from '@shared/session/database';
import type { PluginArms } from '@tools/plugins';

import {
  aggregateOf,
  decodeRow,
  EARLIER_RUNS,
  RowSchema,
  type SqlRow,
} from './rowCodec';

/** An earlier-build run row, as `EARLIER_RUNS` selects it. */
const EarlierRowSchema = z.object({
  logicalId: z.string(),
  commit: z.int(),
  type: z.string(),
});

/** A statement runner over the reader's connection. */
type Exec<E> = (
  statement: string,
  params: readonly unknown[],
) => Effect.Effect<readonly SqlRow[], E>;

/** A selected row's reader, and the runs it found it cannot open. */
export interface RowReader<E> {
  /** The events of `rows`. A newer row fails the read; one that does not
   *  decode fails a strict read (`whole`: a run's history and its records),
   *  so no decision is made from part of a run's rows, and is left out of a
   *  wide read (tail, listing, projections) with one warning, so one bad row
   *  never costs the session. An absent plugin's kind is left out, warned.
   *  A strict read of a run an earlier build wrote fails as that build's,
   *  whichever of its rows it selected. */
  readonly read: (
    rows: readonly SqlRow[],
    whole: boolean,
  ) => Effect.Effect<
    readonly SessionEvent[],
    E | DatabaseStoreNewer | DatabaseRowCorrupt | DatabaseRowEarlier
  >;
  /** Every run found unopenable so far, with why: shown read-only. */
  readonly damaged: Effect.Effect<LocalRuntimeState['unreadable'], E>;
}

/**
 * The reader of the store at `path`, over the process's plugin `arms`. Its
 * first strict read or `damaged` finds, through `exec`, every run holding an
 * earlier build's row, which the listing (it never reads a run's history)
 * would not meet: one finding, read by the listing, history and resume alike.
 */
export function rowReader<E>(
  path: string,
  arms: PluginArms,
  exec: Exec<E>,
): RowReader<E> {
  const warned = new Set<string>();
  const unopenable = new Map<RunId, string>();
  // The runs an earlier build wrote, each with the first such row.
  const earlier = new Map<RunId, DatabaseRowEarlier>();
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
  /** Find, once, every run holding an earlier build's row. */
  const scan = Effect.gen(function* () {
    for (const [statement, params] of scanned ? [] : EARLIER_RUNS)
      for (const row of yield* exec(statement, params)) {
        const { logicalId, commit, type } = EarlierRowSchema.parse(row);
        const runId = RunIdSchema.parse(logicalId);
        mark(runId, true);
        if (!earlier.has(runId))
          earlier.set(runId, new DatabaseRowEarlier({ commit, type }));
      }
    scanned = true;
  });
  const read = (rows: readonly SqlRow[], whole: boolean) =>
    Effect.gen(function* () {
      if (whole) {
        yield* scan;
        const [refusal] = rows.flatMap((row) => {
          const { kind, logicalId } = RowSchema.parse(row);
          return kind === 'run'
            ? (earlier.get(RunIdSchema.parse(logicalId)) ?? [])
            : [];
        });
        if (refusal !== undefined) return yield* Effect.fail(refusal);
      }
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
          mark(
            RunIdSchema.parse(logicalId),
            decoded.failure._tag === 'DatabaseRowEarlier',
          );
        const start = bareStart(row);
        if (start !== null) events.push(start);
      }
      return events;
    });
  return {
    read,
    damaged: Effect.map(scan, () =>
      [...unopenable].map(([runId, detail]) => ({ runId, detail })),
    ),
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
