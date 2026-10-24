/**
 * One connection's reader of selected rows: each decoded by the row codec
 * (`./rowCodec`), and the runs it cannot open, each with why: a row that
 * does not decode (damaged), or one an earlier build wrote at a version this
 * build has no upcaster for. Those are found as reads meet them, and the
 * earlier build's rows all at once on the first `damaged`, since the listing
 * never reads a run's history. The tool cards' read-time output
 * (`settleCards`) is settled over the decoded rows.
 */
import { zstdDecompressSync } from 'node:zlib';

import { Effect, Result, Schema, Struct } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import {
  DISPLAY_EVENT_TYPES,
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
import { sha256Hex } from '@utils/core/idHash';

import {
  aggregateOf,
  decodable,
  decodeRow,
  EARLIER_RUNS,
  pluginFactArm,
  EVENT_COLUMNS,
  EVENT_FROM,
  EVENT_JOINS,
  RowSchema,
  type Blobs,
  type SqlRow,
} from './rowCodec';

/** One aggregate's surrogate, from its two columns. */
export const AGGREGATE =
  '(SELECT id FROM event_sequence WHERE kind = ? AND logical_id = ?)';
/** The event column tuple for a projected row, on its source row's
 *  envelope: this build's projector wrote it, so it is at the current
 *  version. */
export const PROJECTED_COLUMNS = `p."commit" AS "commit", s.kind AS kind,
  s.logical_id AS logicalId, s.uid AS uid, e.seq AS seq, p.type AS type,
  NULL AS version, e.origin AS origin, e.at AS at, p.data AS data`;
/** A projected row joined to its source row's envelope. */
export const PROJECTED_FROM = `projected_row p
  JOIN event e ON e."commit" = p."commit"
  JOIN event_sequence s ON s.id = e.aggregate`;
/** The kinds a display read selects: the display rows, and the settlements
 *  their tool cards' output is projected from (`settleCards`). */
export const DISPLAY_READ_TYPES = JSON.stringify([
  ...DISPLAY_EVENT_TYPES,
  'tool.result',
]);
/** The listing (each aggregate's `listing_entry` rows, each run's spend on
 *  its newest priced row's envelope and its latest model switch, in commit
 *  order), driven from `listing_entry` (`CROSS JOIN` holds the order: a
 *  store is never `ANALYZE`d), each by its event's primary key. */
const LISTED = `listing_entry l CROSS JOIN event e ON e."commit" = l."commit"
  ${EVENT_JOINS}`;

/** The cold listing: the latest listing row per aggregate and type, the
 *  runs' priced usage and model switches, in commit order. */
export const READ_LISTING = `SELECT * FROM (
  SELECT ${EVENT_COLUMNS} FROM ${LISTED}
  UNION ALL
  SELECT u."commit" AS "commit", s.kind AS kind, s.logical_id AS logicalId,
    s.uid AS uid,
    e.seq AS seq, 'usage' AS type, NULL AS version, e.origin AS origin,
    e.at AS at, u.usage AS data
  FROM run_usage u
    JOIN event e ON e."commit" = u."commit"
    JOIN event_sequence s ON s.id = u.aggregate
  UNION ALL
  SELECT ${PROJECTED_COLUMNS} FROM ${PROJECTED_FROM}
    JOIN run_model m ON m."commit" = p."commit" AND p.type = 'run.model'
) ORDER BY "commit"`;

/** One open run's listing rows, its pending sets left out. */
export const READ_RUN_RECORDS = `SELECT ${EVENT_COLUMNS} FROM ${LISTED}
  WHERE l.aggregate = (SELECT id FROM event_sequence
      WHERE kind = ? AND logical_id = ? AND closed_by IS NULL)
    AND e.type NOT IN ('request.opened', 'followup.queued')
  ORDER BY e."commit"`;
/** The blobs of the digests bound as one `json_each` array. */
const READ_BLOBS = `SELECT digest, value FROM blob
  WHERE digest IN (SELECT value FROM json_each(?))`;
/** One stored blob, as `READ_BLOBS` selects it. */
const BlobRowSchema = Schema.Struct({
  digest: Schema.String,
  value: Schema.instanceOf(Uint8Array),
});
/** One blob's string, verified against its address. */
function inflateBlob(value: Uint8Array, digest: string): string {
  const text = zstdDecompressSync(value).toString('utf8');
  if (sha256Hex(text) !== digest) throw new Error(`Blob ${digest} is corrupt`);
  return Schema.decodeUnknownSync(Schema.String)(JSON.parse(text));
}
/** The blobs a batch of selected rows inflates: each `{"$b": digest}` in
 *  the data of the rows this build decodes. A payload's own `$b` key is
 *  stored `$$b`, so it never matches; a media part's address is not a
 *  reference, so its bytes are never fetched. */
function blobDigests(rows: readonly SqlRow[]): string[] {
  const digests = new Set<string>();
  for (const row of rows) {
    if (typeof row.data !== 'string' || !decodable(row)) continue;
    for (const match of row.data.matchAll(/"\$b":"([0-9a-f]{64})"/g))
      digests.add(match[1] ?? '');
  }
  return [...digests];
}

/** An earlier-build run row, as `EARLIER_RUNS` selects it. */
const EarlierRowSchema = Schema.Struct({
  logicalId: Schema.String,
  commit: Schema.Int,
  type: Schema.String,
});

/** Every run's plugin fact, its envelope and raw payload: a fact's version
 *  is in its payload, read in TypeScript. Large strings are blob refs, so
 *  the payload's header is small; no blob is joined or inflated. */
const RUN_PLUGIN_FACTS = `SELECT s.logical_id AS logicalId, e."commit" AS "commit",
  e.data AS data FROM ${EVENT_FROM}
  WHERE s.kind = 'run' AND e.type = 'plugin.fact'`;

/** A plugin fact row's header: the top-level fields `decodeRow` reads. A
 *  row this cannot read is left to `decodeRow`, which reads it as damaged. */
const PluginFactHeaderSchema = Schema.Struct({
  plugin: Schema.String,
  kind: Schema.String,
  version: Schema.Int,
});
const factHeader = (data: unknown) => {
  try {
    return Schema.decodeUnknownResult(PluginFactHeaderSchema)(
      JSON.parse(String(data)),
    ).data;
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
  /** The strings stored under `digests`, inflated and verified; a digest
   *  the store lacks fails the read. */
  readonly blobs: (
    digests: readonly string[],
  ) => Effect.Effect<ReadonlyMap<string, string>, E>;
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
        const { logicalId, commit, type } =
          Schema.decodeUnknownSync(EarlierRowSchema)(row);
        markEarlier(
          Schema.decodeUnknownSync(RunIdSchema)(logicalId),
          new DatabaseRowEarlier({ commit, type }),
        );
      }
    for (const row of floored ? yield* exec(RUN_PLUGIN_FACTS, []) : []) {
      const { logicalId, commit } = Schema.decodeUnknownSync(
        EarlierRowSchema.mapFields(Struct.omit(['type'])),
      )(row);
      const header = factHeader(row.data);
      const arm = header && pluginFactArm(header, commit, arms);
      if (
        arm &&
        Result.isFailure(arm) &&
        arm.failure._tag === 'DatabaseRowEarlier'
      )
        markEarlier(
          Schema.decodeUnknownSync(RunIdSchema)(logicalId),
          arm.failure,
        );
    }
    scanned = true;
  });
  const stored = (digests: readonly string[]) =>
    digests.length === 0
      ? Effect.succeed(new Map<string, string>())
      : Effect.map(exec(READ_BLOBS, [JSON.stringify(digests)]), (rows) => {
          // A damaged blob is left out: the row naming it reads as damaged,
          // a strict read of it fails by name.
          const texts = new Map<string, string>();
          for (const row of rows) {
            const { digest, value } =
              Schema.decodeUnknownSync(BlobRowSchema)(row);
            try {
              texts.set(digest, inflateBlob(value, digest));
            } catch {
              continue;
            }
          }
          return texts;
        });
  const blobs = (digests: readonly string[]) =>
    Effect.map(stored(digests), (texts) => {
      const missing = digests.filter((digest) => !texts.has(digest));
      if (missing.length > 0)
        throw new Error(`${path} holds no readable blob ${missing.join(', ')}`);
      return texts;
    });
  const read = (rows: readonly SqlRow[], whole: boolean) =>
    Effect.gen(function* () {
      if (whole) {
        yield* scan;
        const [refusal] = rows.flatMap((row) => {
          const { kind, logicalId } = Schema.decodeUnknownSync(RowSchema)(row);
          return kind === 'run'
            ? (earlier.get(Schema.decodeUnknownSync(RunIdSchema)(logicalId)) ??
                [])
            : [];
        });
        if (refusal !== undefined) return yield* Effect.fail(refusal);
      }
      // The batch's blobs in one statement: a row carries addresses only.
      const texts: Blobs = yield* stored(blobDigests(rows));
      const events: SessionEvent[] = [];
      for (const row of rows) {
        const decoded = decodeRow(row, arms, texts);
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
        const { kind, logicalId } = Schema.decodeUnknownSync(RowSchema)(row);
        if (kind === 'run')
          mark(
            Schema.decodeUnknownSync(RunIdSchema)(logicalId),
            decoded.failure._tag === 'DatabaseRowEarlier',
          );
        const start = bareStart(row);
        if (start !== null) events.push(start);
      }
      return events;
    });
  return {
    read,
    blobs,
    damaged: Effect.map(scan, () =>
      [...unopenable].map(([runId, reason]) => ({ runId, reason })),
    ),
  };
}

/** A damaged `run.start` as a bare one, so its run still lists. */
function bareStart(input: SqlRow): SessionEvent | null {
  const row = Schema.decodeUnknownSync(RowSchema)(input);
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
 * The read-time projection of a tool card's output: a `tool.end` on a
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
