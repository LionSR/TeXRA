/**
 * The row codec
 * (`.agents/docs/proposed/architecture/2026-09-28-storage-v1-design.md` §1,
 * §3): the one module that knows a stored shape. It turns a validated draft
 * into the column tuple `Database` inserts, and a selected column tuple back
 * into a typed event or a verdict, so nothing above it sees a `version`, a
 * `data` text, an integer aggregate id or the `blob` table, and nothing
 * below it reads a payload field.
 *
 * - **Versions.** A row is written at its kind's current version
 *   (`ROW_KINDS`). A lower stored version is upcast step by step and parsed
 *   with the current arm; a higher one, or a kind this build lacks, is
 *   `Blocked`; a known version that fails its schema is `Corrupt`. A
 *   plugin value carries its arm's version and is upcast through the arm.
 * - **Blobs.** A payload string of 4096+ characters is stored once per store,
 *   zstd of its JSON encoding (lone surrogates survive) under that text's
 *   sha256; the row keeps `{"$b": digest}` (a payload's own `$b` key is
 *   stored `$$b`), and the read inflates it, digest verified. A
 *   `context.blob` row's value is stored as its canonical JSON text.
 * - **Aggregates.** An `AggregateId` is stored as two columns, `kind` and
 *   `logical_id`, and composed back from them here.
 */
import { hash } from 'node:crypto';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import stableStringify from 'safe-stable-stringify';
import { Effect } from 'effect';
import { z } from 'zod';
import { withLogChannel } from '@logger/effectLog';
import {
  AggregateIdSchema,
  aggregateTarget,
  DISPLAY_EVENT_TYPES,
  ROW_KINDS,
  SessionEventDraftSchema,
  SessionEventSchema,
  type AggregateId,
  type BlockedAggregate,
  type JsonValue,
  type SessionEvent,
  type SessionEventDraft,
} from '@shared/schemas';
import { DatabaseAggregateBlocked } from '@shared/session/database';
import { PLUGIN_ARMS } from '@tools/pluginArms';
import { isObject } from '@utils/core';
import type { SqlError } from 'effect/sql/SqlError';

const CHANNEL = 'sessionDatabase';

// zstd: Node 22.15+ (the CLI needs 22.19; Electron and VS Code ship 24).
if (typeof zstdCompressSync !== 'function')
  throw new Error('The session store needs zstd: Node 22.19 or later.');

/** A payload key shaped `$b`, `$$b`, …: stored with one more `$`. */
const REF_SHAPED = /^\$+b$/;
const ZSTD_LEVEL_3 = { params: { [constants.ZSTD_c_compressionLevel]: 3 } };
const sha256 = (text: string) => hash('sha256', text, 'hex');
/** An object with its keys of the reference's shape renamed, or itself. */
const renameRefShaped = (value: object, rename: (key: string) => string) =>
  Object.keys(value).some((key) => REF_SHAPED.test(key))
    ? Object.fromEntries(
        Object.entries(value).map(([key, field]) => [
          REF_SHAPED.test(key) ? rename(key) : key,
          field,
        ]),
      )
    : value;

/** The column tuple every event read selects over {@link EVENT_FROM}. */
export const EVENT_COLUMNS = `e."commit" AS "commit", s.kind AS kind,
  s.logical_id AS logicalId, s.uid AS uid, e.seq AS seq, e.type AS type,
  e.version AS version, e.origin AS origin, e.at AS at, e.data AS data,
  (SELECT group_concat(r.digest || hex(b.value)) FROM event_blob r
    JOIN blob b ON b.digest = r.digest WHERE r."commit" = e."commit") AS blobs`;
/** An event `e`'s aggregate key, joined on. */
export const EVENT_JOINS = `JOIN event_sequence s ON s.id = e.aggregate`;
/** An event with its aggregate's key and its blobs, each its digest then
 *  its value in hex. */
export const EVENT_FROM = `event e ${EVENT_JOINS}`;
/** The same tuple for a projected row, on its source row's envelope: this
 *  build's projector wrote it, so it is at the current version. */
export const PROJECTED_COLUMNS = `p."commit" AS "commit", s.kind AS kind,
  s.logical_id AS logicalId, s.uid AS uid, e.seq AS seq, p.type AS type,
  NULL AS version, e.origin AS origin, e.at AS at, p.data AS data,
  NULL AS blobs`;
export const PROJECTED_FROM = `projected_row p
  JOIN event e ON e."commit" = p."commit"
  JOIN event_sequence s ON s.id = e.aggregate`;

/** The kinds a display read selects: the display rows, and the settlements
 *  their tool cards' output is projected from ({@link settleCards}). */
export const DISPLAY_READ_TYPES = JSON.stringify([
  ...DISPLAY_EVENT_TYPES,
  'tool.result',
]);

/** Every kind this store holds, at the highest version it was written at. */
export const STORED_KINDS = 'SELECT type, version FROM stored_kind';
/** The aggregates holding rows of one kind above one version, with the
 *  envelope of each one's first row. */
const AGGREGATES_ABOVE = `SELECT s.kind AS kind,
  s.logical_id AS logicalId, s.uid AS uid, MAX(e.version) AS version,
  s.start_commit AS "commit",
  (SELECT f.at FROM event f WHERE f."commit" = s.start_commit) AS at
  FROM event e INDEXED BY event_type_commit
  JOIN event_sequence s ON s.id = e.aggregate
  WHERE e.type = ? AND e.version > ?
  GROUP BY e.aggregate`;

/** A draft as `Database` inserts it, with the blobs it references. */
export interface EncodedRow {
  readonly type: string;
  readonly version: number;
  readonly data: string;
  readonly blobs: readonly { digest: string; value: Uint8Array }[];
}

/** An aggregate as its two columns. */
export function aggregateColumns(
  id: AggregateId,
): readonly [kind: string, logicalId: string] {
  const target = aggregateTarget(id);
  return [target.kind, target.id];
}

/** Aggregates as the two parallel JSON arrays a statement binds with
 *  `json_each(?)`, joined on the array index. */
export function aggregateLists(
  ids: readonly AggregateId[],
): readonly [kinds: string, logicalIds: string] {
  const columns = ids.map(aggregateColumns);
  return [
    JSON.stringify(columns.map(([kind]) => kind)),
    JSON.stringify(columns.map(([, logicalId]) => logicalId)),
  ];
}

/** The `AggregateId` two columns name. */
export function aggregateOf(kind: unknown, logicalId: unknown): AggregateId {
  return AggregateIdSchema.parse(
    JSON.stringify([z.string().parse(kind), z.string().parse(logicalId)]),
  );
}

const hasKind = (type: string): type is SessionEventDraft['type'] =>
  Object.hasOwn(ROW_KINDS, type);

/** Validate a draft and encode it at its kind's current version. Throws on
 *  a draft that does not parse, is not JSON, or whose blob does not hash to
 *  its digest. */
export function prepareEventDraft(input: SessionEventDraft): {
  readonly draft: SessionEventDraft;
  readonly row: EncodedRow;
} {
  const draft = SessionEventDraftSchema.parse(input);
  return { draft, row: encodeDraft(draft) };
}

export function encodeDraft(draft: SessionEventDraft): EncodedRow {
  const { type, aggregateId: _key, ...payload } = draft;
  const { version } = ROW_KINDS[type];
  let stored: object = payload;
  if (draft.type === 'context.blob') {
    const { digest, value } = draft.payload;
    const canonical = stableStringify(value);
    if (canonical === undefined || sha256(canonical) !== digest)
      throw new Error(`The context blob ${digest} does not hash to its digest`);
    stored = { ...payload, payload: { digest, value: canonical } };
  }
  const blobs = new Map<string, string>();
  // The replacer sees each value (after `toJSON`) before its children.
  const data = JSON.stringify(stored, (_key, value: unknown) => {
    if (typeof value === 'string' && value.length >= 4096) {
      const json = JSON.stringify(value);
      const digest = sha256(json);
      blobs.set(digest, json);
      return { $b: digest };
    }
    return isObject(value) ? renameRefShaped(value, (key) => `$${key}`) : value;
  });
  return {
    type,
    version,
    data,
    blobs: Array.from(blobs, ([digest, text]) => ({
      digest,
      value: zstdCompressSync(text, ZSTD_LEVEL_3),
    })),
  };
}

/**
 * A selected row: its event; a plugin row this build does not read (its
 * plugin absent, or its value newer than the arm), kept as written; or the
 * verdict that blocks its aggregate.
 */
export type RowVerdict =
  | { readonly _tag: 'event'; readonly event: SessionEvent }
  | {
      readonly _tag: 'leftOut';
      readonly kind: string;
      /** Its plugin is installed but a later build wrote this value: the
       *  plugin must not write the kind over it. */
      readonly newer: BlockedAggregate | null;
    }
  | BlockedAggregate;

const RowSchema = z.object({
  commit: z.int(),
  kind: z.string(),
  logicalId: z.string(),
  uid: z.string(),
  seq: z.int(),
  type: z.string(),
  version: z.int().positive().nullable(),
  origin: z.string(),
  at: z.int(),
  data: z.string(),
  blobs: z.string().nullable(),
});

const JsonObjectSchema = z.record(z.string(), z.json());

/** `data`, its references inflated from `blobs` (one missing or not hashing
 *  to its digest throws) and its escaped keys restored. */
function parseData({ data, blobs }: z.infer<typeof RowSchema>): unknown {
  if (!/"\$+b":/.test(data)) return JSON.parse(data);
  const hex = new Map(
    blobs?.split(',').map((b) => [b.slice(0, 64), b.slice(64)]),
  );
  return JSON.parse(data, (_key, value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      return value;
    if (!('$b' in value)) return renameRefShaped(value, (key) => key.slice(1));
    const digest = String(value.$b);
    const zst = Buffer.from(hex.get(digest) ?? '', 'hex');
    const text = zstdDecompressSync(zst).toString('utf8');
    if (sha256(text) !== digest) throw new Error(`Blob ${digest} is corrupt`);
    return z.string().parse(JSON.parse(text));
  });
}

export function decodeRow(
  input: Readonly<Record<string, unknown>>,
): RowVerdict {
  const row = RowSchema.parse(input);
  const aggregateId = aggregateOf(row.kind, row.logicalId);
  const blocked = (
    reason: BlockedAggregate['reason'],
    version = row.version ?? 0,
  ): BlockedAggregate => ({
    _tag: 'blocked',
    aggregateId,
    uid: row.uid,
    reason,
    type: row.type,
    version,
    commit: row.commit,
    at: row.at,
  });
  if (!hasKind(row.type)) return blocked('unknown');
  const kind = ROW_KINDS[row.type];
  const stored = row.version ?? kind.version;
  if (stored > kind.version) return blocked('newer');
  let data: Record<string, JsonValue>;
  try {
    data = JsonObjectSchema.parse(parseData(row));
    for (const step of kind.upcast.slice(stored - 1)) data = { ...step(data) };
    if (row.type === 'context.blob') {
      const field = JsonObjectSchema.parse(data.payload);
      // The value is stored canonical, so its text hashes to its address.
      const text = z.string().parse(field.value);
      if (sha256(text) !== field.digest) return blocked('corrupt');
      data = { ...data, payload: { ...field, value: JSON.parse(text) } };
    }
  } catch {
    return blocked('corrupt');
  }
  const parsed = SessionEventSchema.safeParse({
    ...data,
    aggregateId,
    seq: row.seq,
    commit: row.commit,
    origin: row.origin,
    at: row.at,
    type: row.type,
  });
  if (!parsed.success) return blocked('corrupt');
  const event = parsed.data;
  if (event.type !== 'plugin.fact') return { _tag: 'event', event };
  const name = `${event.plugin}/${event.kind}`;
  const arm = PLUGIN_ARMS.get(name);
  if (arm === undefined || event.version > arm.version)
    return {
      _tag: 'leftOut',
      kind: name,
      newer:
        arm === undefined
          ? null
          : { ...blocked('newer', event.version), type: `plugin.fact/${name}` },
    };
  let value = event.value;
  for (const step of arm.upcasters.slice(event.version - 1))
    value = step(value);
  if (!arm.schema.safeParse(value).success) return blocked('corrupt');
  return {
    _tag: 'event',
    event: { ...event, version: arm.version, value },
  };
}

/**
 * The read-time projection of a tool card's output (§10): on a run with a
 * run history a `tool.end` stores no `result`, and its output is the `tool.result`
 * committed in the same batch, the row just before it on its aggregate (bar
 * the card's own `tool.start`). The card keeps its `files`; the transcript
 * fold keeps the name and input its `tool.start` opened the card with.
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

/** The stored kinds whose rows this build cannot read: an unknown type (all
 *  of its rows) or a newer version (those above this build's). */
interface UnreadableKind {
  readonly type: string;
  readonly above: number;
  readonly reason: 'newer' | 'unknown';
}

export function unreadableKinds(
  stored: readonly Readonly<Record<string, unknown>>[],
): readonly UnreadableKind[] {
  return stored.flatMap((input): UnreadableKind[] => {
    const { type, version } = z
      .object({ type: z.string(), version: z.int() })
      .parse(input);
    if (!hasKind(type)) return [{ type, above: 0, reason: 'unknown' }];
    const current = ROW_KINDS[type].version;
    return version > current ? [{ type, above: current, reason: 'newer' }] : [];
  });
}

/**
 * One connection's record of what its reads could not decode: the
 * aggregates blocked by the first verdict found (warned once each), and the
 * plugin kinds left out (warned once per kind). `decodeAll` answers a
 * read's events and records the rest; `refresh` adds the aggregates
 * `stored_kind` names; `retain` drops the verdicts of collected ones.
 */
export function verdictBook(
  path: string,
  exec: (
    statement: string,
    params?: readonly unknown[],
  ) => Effect.Effect<readonly Readonly<Record<string, unknown>>[], SqlError>,
) {
  const leftOut = new Set<string>();
  const blocked = new Map<AggregateId, BlockedAggregate>();
  /** Keep only the verdicts whose incarnation (`uid`) still exists: a
   *  collected aggregate's verdict must not block a later one of its id. */
  const retain = Effect.gen(function* () {
    if (blocked.size === 0) return;
    const live = yield* exec(
      'SELECT uid FROM event_sequence WHERE uid IN (SELECT value FROM json_each(?))',
      [JSON.stringify([...blocked.values()].map((verdict) => verdict.uid))],
    );
    const uids = new Set(live.map((row) => row.uid));
    for (const [id, verdict] of blocked)
      if (!uids.has(verdict.uid)) blocked.delete(id);
  });
  const block = (verdict: BlockedAggregate) =>
    blocked.has(verdict.aggregateId)
      ? Effect.void
      : Effect.sync(() => blocked.set(verdict.aggregateId, verdict)).pipe(
          Effect.andThen(
            Effect.logWarning(
              `${path} holds a ${verdict.reason} ${verdict.type} row (version ${verdict.version}) of ${verdict.aggregateId}; it stays in the store, and the aggregate is shown blocked and refused to every run history read and claim.`,
            ),
          ),
          withLogChannel(CHANNEL),
        );
  /** A read's events, and whether it skipped a row of a newer or unknown
   *  kind (a later build can read it; a corrupt row no build can). */
  const decodeAll = (rows: readonly Readonly<Record<string, unknown>>[]) =>
    Effect.gen(function* () {
      const fresh: string[] = [];
      const events: SessionEvent[] = [];
      let skipped = false;
      for (const row of rows) {
        const verdict = decodeRow(row);
        if (verdict._tag === 'event') events.push(verdict.event);
        else if (verdict._tag === 'blocked') {
          skipped ||= verdict.reason !== 'corrupt';
          yield* block(verdict);
        } else if (!leftOut.has(verdict.kind)) {
          leftOut.add(verdict.kind);
          fresh.push(verdict.kind);
        }
      }
      if (fresh.length > 0)
        yield* Effect.logWarning(
          `${path} holds rows of plugin kinds this build does not read (${fresh.join(', ')}); they stay in the store and are left out of every read.`,
        ).pipe(withLogChannel(CHANNEL));
      return { events, skipped };
    });
  /** The aggregates (every one, or `only`) holding a row of a kind this
   *  build lacks or of a newer version, read in the caller's transaction:
   *  `stored_kind` says whether any exist, so the normal store checks no
   *  row. Each is recorded, and answered. */
  const scan = (only?: AggregateId) =>
    Effect.gen(function* () {
      const found: BlockedAggregate[] = [];
      for (const kind of unreadableKinds(yield* exec(STORED_KINDS))) {
        const rows = yield* only === undefined
          ? exec(AGGREGATES_ABOVE, [kind.type, kind.above])
          : exec(`${AGGREGATES_ABOVE} HAVING s.kind = ? AND s.logical_id = ?`, [
              kind.type,
              kind.above,
              ...aggregateColumns(only),
            ]);
        for (const row of rows) {
          const verdict: BlockedAggregate = {
            _tag: 'blocked',
            aggregateId: aggregateOf(row.kind, row.logicalId),
            uid: z.string().parse(row.uid),
            reason: kind.reason,
            type: kind.type,
            version: z.int().parse(row.version),
            commit: z.int().parse(row.commit),
            at: z.int().parse(row.at),
          };
          found.push(verdict);
          yield* block(verdict);
        }
      }
      return found;
    });
  const refresh = Effect.andThen(retain, scan());
  /** A run history read or claim of a blocked aggregate is refused whole. */
  const refuse = <E>(
    id: AggregateId,
    failed: (cause: DatabaseAggregateBlocked) => E,
  ) => {
    const verdict = blocked.get(id);
    return verdict === undefined
      ? Effect.void
      : Effect.fail(failed(new DatabaseAggregateBlocked(verdict)));
  };
  /** In the caller's transaction: the newer value of plugin kind `name` an
   *  aggregate (its surrogate) holds, which this build's plugin must not
   *  write over. */
  const newerPlugin = (aggregate: number, name: string) =>
    exec(
      `SELECT ${EVENT_COLUMNS} FROM ${EVENT_FROM}
       WHERE e.aggregate = ? AND e.type = 'plugin.fact'`,
      [aggregate],
    ).pipe(
      Effect.map(
        (rows) =>
          rows
            .map(decodeRow)
            .flatMap((v) =>
              v._tag === 'leftOut' && v.kind === name ? [v] : [],
            )
            .find((v) => v.newer !== null)?.newer,
      ),
    );
  return { blocked, decodeAll, newerPlugin, refresh, refuse, retain, scan };
}
