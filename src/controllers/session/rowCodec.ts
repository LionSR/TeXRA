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
 * - **Blobs.** A `context.blob` row's value is stored once per store, in the
 *   `blob` table under the sha256 of its canonical JSON; the row keeps the
 *   digest and the read joins the value back.
 * - **Aggregates.** An `AggregateId` is stored as two columns, `kind` and
 *   `logical_id`, and composed back from them here.
 */
import { createHash } from 'node:crypto';
import stableStringify from 'safe-stable-stringify';
import { Effect } from 'effect';
import { z } from 'zod';
import { withLogChannel } from '@logger/effectLog';
import {
  AggregateIdSchema,
  aggregateTarget,
  ROW_KINDS,
  SessionEventDraftSchema,
  SessionEventSchema,
  type AggregateId,
  type BlockedAggregate,
  type JsonValue,
  type SessionEvent,
  type SessionEventDraft,
} from '@shared/schemas';
import { PLUGIN_ARMS } from '@tools/pluginArms';

const CHANNEL = 'sessionDatabase';

/** The column tuple every event read selects over {@link EVENT_FROM}. */
export const EVENT_COLUMNS = `e."commit" AS "commit", s.kind AS kind,
  s.logical_id AS logicalId, e.seq AS seq, e.type AS type,
  e.version AS version, e.origin AS origin, e.at AS at, e.data AS data,
  b.value AS blobValue`;
/** An event `e`'s aggregate key and blob value, joined on. */
export const EVENT_JOINS = `JOIN event_sequence s ON s.id = e.aggregate
  LEFT JOIN blob b ON b.digest = e.blob`;
/** An event with its aggregate's key and its blob's value. */
export const EVENT_FROM = `event e ${EVENT_JOINS}`;
/** The same tuple for a projected row, on its source row's envelope: this
 *  build's projector wrote it, so it is at the current version. */
export const PROJECTED_COLUMNS = `p."commit" AS "commit", s.kind AS kind,
  s.logical_id AS logicalId, e.seq AS seq, p.type AS type,
  NULL AS version, e.origin AS origin, e.at AS at, p.data AS data,
  NULL AS blobValue`;
export const PROJECTED_FROM = `projected_row p
  JOIN event e ON e."commit" = p."commit"
  JOIN event_sequence s ON s.id = e.aggregate`;

/** Every kind this store holds, at the highest version it was written at. */
export const STORED_KINDS = 'SELECT type, version FROM stored_kind';
/** The aggregates holding rows of one kind above one version. */
export const AGGREGATES_ABOVE = `SELECT s.kind AS kind,
  s.logical_id AS logicalId, MAX(e.version) AS version
  FROM event e INDEXED BY event_type_commit
  JOIN event_sequence s ON s.id = e.aggregate
  WHERE e.type = ? AND e.version > ?
  GROUP BY e.aggregate`;

/** A draft as `Database` inserts it. */
export interface EncodedRow {
  readonly type: string;
  readonly version: number;
  readonly data: string;
  readonly blob: { readonly digest: string; readonly value: string } | null;
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
  const kind = ROW_KINDS[type];
  if (kind.blob === undefined || draft.type !== 'context.blob') {
    return {
      type,
      version: kind.version,
      data: JSON.stringify(payload),
      blob: null,
    };
  }
  const { digest, value } = draft.payload;
  const canonical = stableStringify(value);
  if (
    canonical === undefined ||
    createHash('sha256').update(canonical).digest('hex') !== digest
  ) {
    throw new Error(`The context blob ${digest} does not hash to its digest`);
  }
  return {
    type,
    version: kind.version,
    data: JSON.stringify({ ...payload, payload: { digest } }),
    blob: { digest, value: canonical },
  };
}

/**
 * A selected row: its event; a plugin row this build does not read (its
 * plugin absent, or its value newer than the arm), kept as written; or the
 * verdict that blocks its aggregate.
 */
export type RowVerdict =
  | { readonly _tag: 'event'; readonly event: SessionEvent }
  | { readonly _tag: 'leftOut'; readonly kind: string }
  | BlockedAggregate;

const RowSchema = z.object({
  commit: z.int(),
  kind: z.string(),
  logicalId: z.string(),
  seq: z.int(),
  type: z.string(),
  version: z.int().positive().nullable(),
  origin: z.string(),
  at: z.int(),
  data: z.string(),
  blobValue: z.string().nullable(),
});

const JsonObjectSchema = z.record(z.string(), z.json());

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
    reason,
    type: row.type,
    version,
  });
  if (!hasKind(row.type)) return blocked('unknown');
  const kind = ROW_KINDS[row.type];
  const stored = row.version ?? kind.version;
  if (stored > kind.version) return blocked('newer');
  let data: Record<string, JsonValue>;
  try {
    data = JsonObjectSchema.parse(JSON.parse(row.data));
    for (const step of kind.upcast.slice(stored - 1)) data = { ...step(data) };
    if (kind.blob !== undefined) {
      if (row.blobValue === null) return blocked('corrupt');
      const field = JsonObjectSchema.parse(data[kind.blob]);
      data = {
        ...data,
        [kind.blob]: { ...field, value: JSON.parse(row.blobValue) },
      };
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
    return { _tag: 'leftOut', kind: name };
  let value = event.value;
  for (const step of arm.upcasters.slice(event.version - 1))
    value = step(value);
  if (!arm.schema.safeParse(value).success) return blocked('corrupt');
  return {
    _tag: 'event',
    event: { ...event, version: arm.version, value },
  };
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
 * plugin kinds left out (warned once per kind). `decode` answers a read's
 * events and records the rest.
 */
export function verdictBook(path: string) {
  const leftOut = new Set<string>();
  const blocked = new Map<AggregateId, BlockedAggregate>();
  const block = (verdict: BlockedAggregate) =>
    blocked.has(verdict.aggregateId)
      ? Effect.void
      : Effect.sync(() => blocked.set(verdict.aggregateId, verdict)).pipe(
          Effect.andThen(
            Effect.logWarning(
              `${path} holds a ${verdict.reason} ${verdict.type} row (version ${verdict.version}) of ${verdict.aggregateId}; it stays in the store, and the aggregate is shown blocked and refused to every ledger read and claim.`,
            ),
          ),
          withLogChannel(CHANNEL),
        );
  const decode = (rows: readonly Readonly<Record<string, unknown>>[]) =>
    Effect.gen(function* () {
      const fresh: string[] = [];
      const events: SessionEvent[] = [];
      for (const row of rows) {
        const verdict = decodeRow(row);
        if (verdict._tag === 'event') events.push(verdict.event);
        else if (verdict._tag === 'blocked') yield* block(verdict);
        else if (!leftOut.has(verdict.kind)) {
          leftOut.add(verdict.kind);
          fresh.push(verdict.kind);
        }
      }
      if (fresh.length > 0)
        yield* Effect.logWarning(
          `${path} holds rows of plugin kinds this build does not read (${fresh.join(', ')}); they stay in the store and are left out of every read.`,
        ).pipe(withLogChannel(CHANNEL));
      return events;
    });
  return { blocked, block, decode };
}
