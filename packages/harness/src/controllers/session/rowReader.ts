/**
 * One connection's reader of selected rows: each decoded by the row codec
 * (`./rowCodec`), and the runs it cannot open, each with why: a row that
 * does not decode (damaged), or one an earlier build wrote at a lower
 * version. Those are found as reads meet them, and the
 * earlier build's rows all at once on the first `damaged`, since the listing
 * never reads a run's history. The tool cards' read-time output
 * (`settleCards`) is settled over the decoded rows.
 */
import { zstdDecompressSync } from 'node:zlib';

import { Effect, Result, Schema, Struct } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import {
  DISPLAY_ROW_TYPES,
  RETIRED_PLUGIN_FACTS,
  RunIdSchema,
  type AggregateId,
  type JsonValue,
  type UnreadableRun,
  type RunId,
  type SessionRow,
} from '@shared/schemas';
import {
  DatabaseRowEarlier,
  type DatabaseRowCorrupt,
  type DatabaseStoreNewer,
  type StoredBlobs,
} from '@shared/session/database';
import type { FactKinds } from '@tools/plugins';
import { sha256Hex } from '@utils/core/idHash';

import {
  aggregateOf,
  decodeRow,
  EARLIER_RUNS,
  factKindOf,
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
  s.logical_id AS logicalId, e.seq AS seq, p.type AS type,
  NULL AS version, e.origin AS origin, e.at AS at, p.data AS data`;
/** A projected row joined to its source row's envelope. */
export const PROJECTED_FROM = `projected_row p
  JOIN event e ON e."commit" = p."commit"
  JOIN event_sequence s ON s.id = e.aggregate`;
/** The kinds a display read selects: the display rows, and the settlements
 *  their tool cards' output is projected from (`settleCards`). */
export const DISPLAY_READ_TYPES = JSON.stringify([
  ...DISPLAY_ROW_TYPES,
  'tool.result',
]);
/** The listing (each aggregate's `listing_entry` rows and each run's spend
 *  on its newest priced row's envelope, in commit order), driven from `listing_entry` (`CROSS JOIN` holds the order: a
 *  store is never `ANALYZE`d), each by its event's primary key. */
const LISTED = `listing_entry l CROSS JOIN event e ON e."commit" = l."commit"
  ${EVENT_JOINS}`;

/** The cold listing: the latest listing row per aggregate and type and the
 *  runs' priced usage, in commit order. */
export const READ_LISTING = `SELECT * FROM (
  SELECT ${EVENT_COLUMNS} FROM ${LISTED}
  UNION ALL
  SELECT u."commit" AS "commit", s.kind AS kind, s.logical_id AS logicalId,
    e.seq AS seq, 'usage' AS type, NULL AS version, e.origin AS origin,
    e.at AS at, u.usage AS data
  FROM run_usage u
    JOIN event e ON e."commit" = u."commit"
    JOIN event_sequence s ON s.id = u.aggregate
) ORDER BY "commit"`;

/** One open run's listing rows, its requests and follow-ups left out:
 *  none for a run never started or closed by its deletion marker. */
export const READ_RUN_RECORDS = `SELECT ${EVENT_COLUMNS} FROM ${LISTED}
  WHERE l.aggregate = (SELECT id FROM event_sequence WHERE kind = ?
      AND logical_id = ? AND closed_by IS NULL AND start_commit IS NOT NULL)
    AND e.type NOT IN ('request.opened', 'request.decided',
      'followup.queued', 'followup.consumed')
  ORDER BY e."commit"`;
/** The blobs of the digests bound as one `json_each` array. */
const READ_BLOBS = `SELECT digest, value FROM blob
  WHERE digest IN (SELECT value FROM json_each(?))`;
/** One stored blob, as `READ_BLOBS` selects it. */
const BlobRowSchema = Schema.Struct({
  digest: Schema.String,
  value: Schema.instanceOf(Uint8Array),
});
const decodeBlobText = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.String),
);
/** One blob's string, verified against its address. */
function inflateBlob(value: Uint8Array, digest: string): string {
  const text = zstdDecompressSync(value).toString('utf8');
  if (sha256Hex(text) !== digest) throw new Error(`Blob ${digest} is corrupt`);
  return decodeBlobText(text);
}
/** The blobs a batch of rows inflates, by the rows' commits: the strings
 *  the codec moved out of them (`event_blob.inline`). A media address is
 *  linked too, but its bytes are never fetched. */
const INLINE_BLOBS = `SELECT DISTINCT b.digest AS digest, b.value AS value
  FROM event_blob l JOIN blob b ON b.digest = l.digest
  WHERE l.inline = 1 AND l."commit" IN (SELECT value FROM json_each(?))`;
const decodeCommit = Schema.decodeUnknownSync(Schema.Int);

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
  const header = Schema.decodeUnknownResult(
    Schema.fromJsonString(PluginFactHeaderSchema),
  )(String(data));
  return Result.isSuccess(header) ? header.success : undefined;
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
   *  never costs the session. An absent plugin's fact reads unavailable,
   *  and a retired display row is skipped (warned once per kind).
   *  A strict read of a run an earlier build wrote fails as that build's,
   *  whichever of its rows it selected. */
  /** The strings stored under `digests`, inflated and verified; a digest
   *  the store lacks fails the read. */
  readonly blobs: (digests: readonly string[]) => Effect.Effect<StoredBlobs, E>;
  readonly read: (
    rows: readonly SqlRow[],
    whole: boolean,
  ) => Effect.Effect<
    readonly SessionRow[],
    E | DatabaseStoreNewer | DatabaseRowCorrupt | DatabaseRowEarlier
  >;
  /** Every run found unopenable so far, with why: shown read-only. */
  readonly damaged: Effect.Effect<readonly UnreadableRun[], E>;
}

/**
 * The reader of the store at `path`, over the process's plugin `factKinds`. Its
 * first strict read or `damaged` finds, through `exec`, every run holding an
 * earlier build's row, which the listing (it never reads a run's history)
 * would not meet: one finding, read by the listing, history and resume alike.
 */
export function rowReader<E>(
  path: string,
  factKinds: FactKinds,
  exec: Exec<E>,
): RowReader<E> {
  const warned = new Set<string>();
  const unopenable = new Map<RunId, UnreadableRun['reason']>();
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
  // Only a retired fact kind, or one past its first version, can hold an
  // earlier build's fact.
  const floored =
    RETIRED_PLUGIN_FACTS.size > 0 ||
    Object.values(factKinds).some((factKind) => factKind.version > 1);
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
      const factKind = header && factKindOf(header, commit, factKinds);
      if (
        factKind &&
        Result.isFailure(factKind) &&
        factKind.failure._tag === 'DatabaseRowEarlier'
      )
        markEarlier(
          Schema.decodeUnknownSync(RunIdSchema)(logicalId),
          factKind.failure,
        );
    }
    scanned = true;
  });
  /** The blobs `statement` selects by the keys it is given, inflated. */
  const inflated = (statement: string, keys: readonly unknown[]) =>
    keys.length === 0
      ? Effect.succeed(new Map<string, string>())
      : Effect.map(exec(statement, [JSON.stringify(keys)]), (rows) => {
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
    Effect.map(inflated(READ_BLOBS, digests), (texts) => {
      const missing = digests.filter((digest) => !texts.has(digest));
      if (missing.length > 0)
        throw new Error(`${path} holds no readable blob ${missing.join(', ')}`);
      return (digest: string) => {
        const text = texts.get(digest);
        if (text === undefined)
          throw new Error(`The blob ${digest} was not part of this read`);
        return text;
      };
    });
  const read = Effect.fnUntraced(function* (
    rows: readonly SqlRow[],
    whole: boolean,
  ) {
    if (whole) {
      yield* scan;
      const [refusal] = rows.flatMap((row) => {
        const { kind, logicalId } = Schema.decodeUnknownSync(RowSchema)(row);
        return kind === 'run'
          ? (earlier.get(Schema.decodeUnknownSync(RunIdSchema)(logicalId)) ??
              [])
          : [];
      });
      if (refusal !== undefined) return yield* refusal;
    }
    // The batch's blobs in one statement: a row carries addresses only. A
    // projected row (no version) holds none, and its commit is its source
    // row's, whose strings it would fetch for nothing.
    const texts: Blobs = yield* inflated(
      INLINE_BLOBS,
      rows.flatMap((row) =>
        row.version === null ? [] : [decodeCommit(row.commit)],
      ),
    );
    const events: SessionRow[] = [];
    for (const row of rows) {
      const decoded = decodeRow(row, factKinds, texts);
      if (Result.isSuccess(decoded)) {
        if (decoded.success !== undefined) events.push(decoded.success);
        else {
          const { type } = Schema.decodeUnknownSync(RowSchema)(row);
          yield* warnOnce(
            type,
            `${path}: rows of the retired kind ${type} fed only what a view showed; they are skipped, and their runs still resume.`,
          );
        }
        continue;
      }
      if (whole || decoded.failure._tag === 'DatabaseStoreNewer')
        return yield* decoded.failure;
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
function bareStart(input: SqlRow): SessionRow | null {
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
    takesFollowUps: false,
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
  events: readonly SessionRow[],
): readonly SessionRow[] {
  const settled = new Map<AggregateId, SessionRow & { type: 'tool.result' }>();
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
  { payload }: SessionRow & { type: 'tool.result' },
  files: Extract<SessionRow, { type: 'tool.end' }>['files'],
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
