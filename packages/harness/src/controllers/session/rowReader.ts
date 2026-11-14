/**
 * One connection's reader of selected rows: each decoded by the row codec
 * (`./rowCodec`), and the runs it cannot open, each with why: a row that
 * does not decode (damaged), or one an earlier build wrote at a lower
 * version. Those are found as reads meet them, and the
 * earlier build's rows all at once on the first `damaged`, since the listing
 * never reads a run's history. A display read shows a call's rows as its
 * tool card (`callCard`).
 */
import { zstdDecompressSync } from 'node:zlib';

import { Effect, Result, Schema, Struct } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import {
  DISPLAY_ROW_TYPES,
  RETIRED_PLUGIN_FACTS,
  RunIdSchema,
  toJsonValue,
  TOOL_CALL_STATUS,
  type DisplayRow,
  type FileListEntry,
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
/** A priced row's usage, where its stored JSON holds it: a model call's
 *  response or failure, a compaction summary, a model's title. */
const PRICED_USAGE = `CASE
  WHEN e.type = 'run.description' THEN e.data -> '$.usage'
  WHEN e.type = 'context.edit' THEN e.data -> '$.payload.usage'
  WHEN e.data ->> '$.payload.kind' IN ('response', 'failed')
    THEN e.data -> '$.payload.usage' END`;
/**
 * The `usage` display row a priced row shows, read off that row on its
 * envelope and at the current version: its counts, cost, route and plan,
 * without the call's surface and response time (`usageRows`, which a
 * committed batch's display rows come from, states the same rule). Nothing
 * stores it: the priced row is the one record of the spend.
 */
export const USAGE_ROWS = `SELECT e."commit" AS "commit", s.kind AS kind,
  s.logical_id AS logicalId, e.seq AS seq, 'usage' AS type,
  NULL AS version, e.at AS at,
  json_object('usage',
    json_remove(${PRICED_USAGE}, '$.provider', '$.responseTimeMs')) AS data
  FROM event e
  JOIN event_sequence s ON s.id = e.aggregate
  WHERE e.type IN ('model.message', 'context.edit', 'run.description')
    AND json_type(${PRICED_USAGE}) = 'object'`;
/** The kinds a display read selects, as the JSON list it binds: the display
 *  rows, and the call rows it shows as tool cards (`callCard`). */
export const DISPLAY_READ_TYPES = JSON.stringify([
  ...DISPLAY_ROW_TYPES,
  'tool.intent',
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
    e.seq AS seq, 'usage' AS type, NULL AS version, e.at AS at,
    u.usage AS data
  FROM run_usage u
    JOIN event e ON e."commit" = u."commit"
    JOIN event_sequence s ON s.id = u.aggregate
) ORDER BY "commit"`;

/** The listing key of a run's first row a projection catch-up could not
 *  read: a read of the run's listing or record selects the row, and so
 *  meets it. */
export const UNREAD_KEY = 'unread';
/** The rows one open run's record is read from, in commit order: the newest
 *  row of each record kind bound as a `json_each` array (each plugin fact,
 *  each title's author), as the listing indexes them, and the run's unread
 *  row. None for a run never started or closed by its deletion marker. */
export const READ_RUN_RECORD = `SELECT ${EVENT_COLUMNS}
  FROM listing_entry l CROSS JOIN event e ON e."commit" = l."commit"
  ${EVENT_JOINS}
  WHERE l.aggregate = (SELECT id FROM event_sequence
      WHERE kind = ? AND logical_id = ? AND closed_by IS NULL
        AND start_commit IS NOT NULL)
    AND (l.key = '${UNREAD_KEY}'
      OR e.type IN (SELECT value FROM json_each(?)))
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
  readonly blobs: (
    digests: readonly string[],
  ) => Effect.Effect<StoredBlobs, E | Error>;
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
  /** A blob a row names that the store no longer holds readable fails the
   *  read, typed. */
  const blobs = (digests: readonly string[]) =>
    Effect.flatMap(inflated(READ_BLOBS, digests), (texts) => {
      const missing = digests.filter((digest) => !texts.has(digest));
      if (missing.length > 0)
        return Effect.fail(
          new Error(`${path} holds no readable blob ${missing.join(', ')}`),
        );
      return Effect.succeed((digest: string) => {
        const text = texts.get(digest);
        if (text === undefined)
          throw new Error(`The blob ${digest} was not part of this read`);
        return text;
      });
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
    at: row.at,
    identity: { kind: 'agent', agent: 'unknown' },
    takesFollowUps: false,
    parent: null,
    provenance: null,
  };
}

/**
 * The tool card row a call row shows, on that row's envelope, or none: a
 * `tool.intent` opens its call's card (`tool.start`), and a `tool.result`
 * that names a card closes it (`tool.end`) with the call's output and the
 * files it edited. A display read returns it in the call row's place, so a
 * card is never stored beside the call it shows and each row shows at most
 * one.
 */
export function callCard(row: SessionRow): readonly DisplayRow[] {
  if (row.type !== 'tool.intent' && row.type !== 'tool.result') return [];
  const { aggregateId, seq, commit, at, stageId } = row;
  const envelope = {
    aggregateId,
    seq,
    commit,
    at,
    ...(stageId === undefined ? {} : { stageId }),
  };
  if (row.type === 'tool.intent') {
    const { logId, toolName, input, card, section, attempt } = row.payload;
    return [
      {
        ...envelope,
        type: 'tool.start',
        logId,
        toolName,
        input,
        ...(section === undefined ? {} : { section }),
        ...(attempt > 1 ? { attempt } : {}),
        ...(card === undefined ? {} : { card }),
      },
    ];
  }
  const { logId, result } = row.payload;
  if (logId === null) return [];
  const edited =
    result.status === 'executed'
      ? (result.edits ?? []).flatMap(({ path }) => (path ? [path] : []))
      : [];
  const files: FileListEntry[] = [...new Set(edited)].map((path) => ({
    path,
    ok: true,
    source: 'tool',
    sourceDisplay: 'Tool use',
  }));
  const { status: _status, ...rest } = result;
  const output = {
    ...rest,
    ...(files.length > 0 ? { editedFiles: files } : {}),
  };
  // A stored result's optional keys may read `undefined`: the card's result
  // is JSON, so they are dropped.
  const json = toJsonValue({
    ...(Object.keys(output).length > 0 ? { output } : {}),
    ...(files.length > 0 ? { files } : {}),
  });
  return [
    {
      ...envelope,
      type: 'tool.end',
      logId,
      status:
        result.status === 'error'
          ? TOOL_CALL_STATUS.FAILED
          : TOOL_CALL_STATUS.COMPLETED,
      result: json,
      ...(files.length > 0 ? { files } : {}),
    },
  ];
}
