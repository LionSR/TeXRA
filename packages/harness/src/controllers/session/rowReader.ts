/**
 * One connection's reader of selected rows: each decoded by the row codec
 * (`./rowCodec`), and the runs it cannot open, each with why: a row that
 * does not decode (damaged), or one an earlier build wrote at a version this
 * build has no upcaster for. Those are found as reads meet them, and the
 * earlier build's rows all at once on the first `damaged`, since the listing
 * never reads a run's history. The tool cards' read-time output
 * (`settleCards`) is settled over the decoded rows.
 */
import { Effect, Result } from 'effect';
import { z } from 'zod';

import { withLogChannel } from '@logger/effectLog';
import {
  pluginFactFloor,
  RunIdSchema,
  type AggregateId,
  type JsonValue,
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
  pluginFactArm,
  EVENT_FROM,
  RowSchema,
  type SqlRow,
} from './rowCodec';

/** An earlier-build run row, as `EARLIER_RUNS` selects it. */
const EarlierRowSchema = z.object({
  logicalId: z.string(),
  commit: z.int(),
  type: z.string(),
});

/** Every run's plugin fact, its envelope and raw payload: a fact's version
 *  is in its payload, read in TypeScript. Large strings are blob refs, so
 *  the payload's header is small; no blob is joined or inflated. */
const RUN_PLUGIN_FACTS = `SELECT s.logical_id AS logicalId, e."commit" AS "commit",
  e.data AS data FROM ${EVENT_FROM}
  WHERE s.kind = 'run' AND e.type = 'plugin.fact'`;

/** A plugin fact row's header: the top-level fields `decodeRow` reads. A
 *  row this cannot read is left to `decodeRow`, which reads it as damaged. */
const PluginFactHeaderSchema = z.object({
  plugin: z.string(),
  kind: z.string(),
  version: z.int(),
});
const factHeader = (data: unknown) => {
  try {
    return PluginFactHeaderSchema.safeParse(JSON.parse(String(data))).data;
  } catch {
    return undefined;
  }
};

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
  const unopenable = new Map<
    RunId,
    LocalRuntimeState['unreadable'][number]['reason']
  >();
  // The runs an earlier build wrote, each with the first such row.
  const earlier = new Map<RunId, DatabaseRowEarlier>();
  let scanned = false;
  const mark = (runId: RunId, earlier: boolean) => {
    if (!unopenable.has(runId))
      unopenable.set(runId, earlier ? 'earlierBuild' : 'damaged');
  };
  const warnOnce = (key: string, message: string) =>
    warned.has(key)
      ? Effect.void
      : Effect.sync(() => warned.add(key)).pipe(
          Effect.andThen(Effect.logWarning(message)),
          withLogChannel('sessionDatabase'),
        );
  const markEarlier = (runId: RunId, row: DatabaseRowEarlier) => {
    mark(runId, true);
    if (!earlier.has(runId)) earlier.set(runId, row);
  };
  // Only an arm with a floor can hold an earlier build's fact.
  const floored = Object.values(arms).some((arm) => pluginFactFloor(arm) > 1);
  /** Find, once, every run holding an earlier build's row. */
  const scan = Effect.gen(function* () {
    if (scanned) return;
    for (const [statement, params] of EARLIER_RUNS)
      for (const row of yield* exec(statement, params)) {
        const { logicalId, commit, type } = EarlierRowSchema.parse(row);
        markEarlier(
          RunIdSchema.parse(logicalId),
          new DatabaseRowEarlier({ commit, type }),
        );
      }
    for (const row of floored ? yield* exec(RUN_PLUGIN_FACTS, []) : []) {
      const { logicalId, commit } = EarlierRowSchema.omit({
        type: true,
      }).parse(row);
      const header = factHeader(row.data);
      const arm = header && pluginFactArm(header, commit, arms);
      if (
        arm &&
        Result.isFailure(arm) &&
        arm.failure._tag === 'DatabaseRowEarlier'
      )
        markEarlier(RunIdSchema.parse(logicalId), arm.failure);
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
      [...unopenable].map(([runId, reason]) => ({ runId, reason })),
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

/**
 * The read-time projection of a tool card's output (§10): a `tool.end` on a
 * run history stores no `result`; its output is the `tool.result` committed
 * just before it in the same batch (bar the card's `tool.start`). The card
 * keeps its `files`; the fold keeps the name and input it opened with.
 */
export function settleCards(
  events: readonly SessionEvent[],
): readonly SessionEvent[] {
  const settled = new Map<
    AggregateId,
    SessionEvent & { type: 'tool.result' }
  >();
  return events.map((event) => {
    if (event.type === 'tool.result') settled.set(event.aggregateId, event);
    else if (event.type !== 'tool.start') {
      const settlement = settled.get(event.aggregateId);
      settled.delete(event.aggregateId);
      if (event.type === 'tool.end' && event.result === undefined && settlement)
        return { ...event, result: cardResult(settlement, event.files) };
    }
    return event;
  });
}

function cardResult(
  { payload }: SessionEvent & { type: 'tool.result' },
  files: Extract<SessionEvent, { type: 'tool.end' }>['files'],
): JsonValue {
  const { status: _status, ...rest } = payload.result;
  const output = { ...rest, ...(files?.length ? { editedFiles: files } : {}) };
  return JSON.parse(
    JSON.stringify({
      ...(Object.keys(output).length > 0 ? { output } : {}),
      ...(files?.length ? { files } : {}),
    }),
  );
}
