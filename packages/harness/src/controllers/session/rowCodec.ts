/**
 * The row codec
 * (`.agents/docs/proposed/architecture/2026-09-28-storage-v1-design.md` §1,
 * §3): the one module that knows a stored shape. It turns a validated draft
 * into the column tuple `Database` inserts, and a selected column tuple back
 * into a typed event or a typed refusal, so nothing above it sees a `version`, a
 * `data` text, an integer aggregate id or the `blob` table, and nothing
 * below it reads a payload field.
 *
 * - **Versions.** A row is written at its kind's version (`ROW_KINDS`), and
 *   `stored_kind` records the highest version each kind (a plugin's kind and
 *   the current values among them) was written at. That table is the store
 *   gate (`storeGate`): a store holding a kind or version this build does
 *   not read is refused whole, never read in part. A row that does not
 *   decode fails its read, naming itself.
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
import { Effect, Predicate, Result } from 'effect';
import { z } from 'zod';
import { withLogChannel } from '@logger/effectLog';
import {
  RUN_DAMAGED_MESSAGE,
  RUN_EARLIER_BUILD_MESSAGE,
} from '@shared/runs/runStatusDisplay';
import {
  AggregateIdSchema,
  aggregateTarget,
  CURRENT_VALUE_VERSION,
  DISPLAY_EVENT_TYPES,
  RETIRED_ROW_KINDS,
  ROW_KINDS,
  SessionEventDraftSchema,
  SessionEventSchema,
  type AggregateId,
  type JsonValue,
  type SessionEvent,
  type SessionEventDraft,
} from '@shared/schemas';
import {
  DatabaseRowCorrupt,
  DatabaseStoreNewer,
} from '@shared/session/database';
import type { PluginArms } from '@tools/plugins';

/** One selected store row, its columns by name, decoded where it is read. */
export type SqlRow = Readonly<Record<string, unknown>>;

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
 *  their tool cards' output is projected from (`settleCards`). */
export const DISPLAY_READ_TYPES = JSON.stringify([
  ...DISPLAY_EVENT_TYPES,
  'tool.result',
]);

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
    if (!Predicate.isObject(value)) return value;
    return renameRefShaped(value, (key) => `$${key}`);
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

/** Where a row failed, never its stored text (a JSON parse error quotes it). */
function causeOf(error: unknown): string {
  if (error instanceof SyntaxError) return 'not JSON';
  const issue = error instanceof z.ZodError ? error.issues[0] : undefined;
  return issue ? `${issue.code} at "${issue.path.join('.')}"` : String(error);
}

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

/** A plugin row whose plugin this build lacks: kept as written and left
 *  out of every read, named by its `plugin/kind`. */
interface LeftOut {
  readonly _tag: 'leftOut';
  readonly kind: string;
}

/**
 * A selected row as its event, or {@link LeftOut}: a newer kind or version
 * fails `DatabaseStoreNewer` (written after this build's store gate), and an
 * undecodable row or unknown kind `DatabaseRowCorrupt`, naming it. */
function decodeRow(
  input: SqlRow,
  arms: PluginArms,
): Result.Result<
  SessionEvent | LeftOut,
  DatabaseStoreNewer | DatabaseRowCorrupt
> {
  const row = RowSchema.parse(input);
  const corrupt = (error: unknown, type = row.type) =>
    Result.fail(
      new DatabaseRowCorrupt({
        commit: row.commit,
        type,
        detail: causeOf(error),
      }),
    );
  // A kind this build retired, or one a newer build wrote since the gate
  // passed (the next write refuses the store): its run's reads fail.
  if (!hasKind(row.type)) return corrupt('a kind this build does not read');
  // A projected row has no version: this build's projector wrote it.
  const version = row.version ?? ROW_KINDS[row.type].version;
  const { version: current, upcast } = ROW_KINDS[row.type];
  if (version > current)
    return Result.fail(new DatabaseStoreNewer({ type: row.type, version }));
  // An older version with no upcaster to this one: an earlier build's row.
  if (upcast.slice(version - 1).length < current - version)
    return Result.fail(
      new DatabaseRowCorrupt({
        commit: row.commit,
        type: row.type,
        detail: `version ${version}`,
        earlier: true,
      }),
    );
  let data: Record<string, JsonValue>;
  try {
    data = JsonObjectSchema.parse(parseData(row));
    for (const step of ROW_KINDS[row.type].upcast.slice(version - 1))
      data = { ...step(data) };
    if (row.type === 'context.blob') {
      const field = JsonObjectSchema.parse(data.payload);
      // The value is stored canonical, so its text hashes to its address.
      const text = z.string().parse(field.value);
      if (sha256(text) !== field.digest) throw new Error('digest mismatch');
      data = { ...data, payload: { ...field, value: JSON.parse(text) } };
    }
  } catch (error) {
    return corrupt(error);
  }
  const parsed = SessionEventSchema.safeParse({
    ...data,
    aggregateId: aggregateOf(row.kind, row.logicalId),
    seq: row.seq,
    commit: row.commit,
    origin: row.origin,
    at: row.at,
    type: row.type,
  });
  if (!parsed.success) return corrupt(parsed.error);
  const event = parsed.data;
  if (event.type !== 'plugin.fact') return Result.succeed(event);
  const name = `${event.plugin}/${event.kind}`;
  const arm = arms[name];
  if (arm === undefined) return Result.succeed({ _tag: 'leftOut', kind: name });
  if (event.version > arm.version)
    return Result.fail(
      new DatabaseStoreNewer({
        type: `plugin.fact/${name}`,
        version: event.version,
      }),
    );
  let value = event.value;
  for (const step of arm.upcasters.slice(event.version - 1))
    value = step(value);
  const { error } = arm.schema.safeParse(value);
  if (error) return corrupt(error, `plugin.fact/${name}`);
  return Result.succeed({ ...event, version: arm.version, value });
}

/**
 * One connection's reader of selected rows (`read`), answering their
 * events. A newer row fails the read. A row that does not decode fails a
 * strict read (`whole`: a run's history and its records), so no decision is
 * made from part of a run's rows; a wide read (tail, listing, projections)
 * leaves it out with one warning, so one damaged row never costs the
 * session. Any undecodable row of a run marks that run in `damaged`, shown
 * read-only and never opened. An absent plugin's kind is left out, warned.
 */
export function rowReader(
  path: string,
  arms: PluginArms,
): {
  readonly read: (
    rows: readonly SqlRow[],
    whole: boolean,
  ) => Effect.Effect<
    readonly SessionEvent[],
    DatabaseStoreNewer | DatabaseRowCorrupt
  >;
  readonly damaged: () => readonly {
    readonly id: AggregateId;
    readonly detail: string;
  }[];
} {
  const warned = new Set<string>();
  const damaged = new Map<AggregateId, string>();
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
          `${path}: ${decoded.failure.message} It is left out of the listing and the tail, and its run is shown as damaged and cannot be opened.`,
        );
        const { kind, logicalId } = RowSchema.parse(row);
        const id = aggregateOf(kind, logicalId);
        if (kind === 'run' && !damaged.has(id))
          damaged.set(
            id,
            decoded.failure.earlier
              ? RUN_EARLIER_BUILD_MESSAGE
              : RUN_DAMAGED_MESSAGE,
          );
        const start = bareStart(row);
        if (start !== null) events.push(start);
      }
      return events;
    });
  return {
    read,
    damaged: () => [...damaged].map(([id, detail]) => ({ id, detail })),
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

/** The `stored_kind` entry a plugin value is recorded under: each arm
 *  versions its kind on its own. */
export const pluginKind = (plugin: string, kind: string): string =>
  `plugin.fact/${plugin}/${kind}`;

/** The `stored_kind` entry every current value is recorded under. */
export const CURRENT_VALUE_KIND = 'current_value';

/** The highest version of a `stored_kind` entry this build reads: `Infinity`
 *  for a plugin kind it lacks (left out), 0 for a core kind it lacks. */
function readableVersion(type: string, arms: PluginArms): number {
  if (type === CURRENT_VALUE_KIND) return CURRENT_VALUE_VERSION;
  if (type.startsWith('plugin.fact/'))
    return arms[type.slice('plugin.fact/'.length)]?.version ?? Infinity;
  if (RETIRED_ROW_KINDS.has(type)) return Infinity;
  return hasKind(type) ? ROW_KINDS[type].version : 0;
}

/**
 * The store gate: fails on the first kind `stored_kind` names at a version
 * this build does not read. Run at open and inside every write transaction,
 * so no build reads part of a store or writes beside rows it cannot read.
 */
export const storeGate = <E>(
  exec: (statement: string) => Effect.Effect<readonly SqlRow[], E>,
  arms: PluginArms,
): Effect.Effect<void, E | DatabaseStoreNewer> =>
  Effect.gen(function* () {
    for (const input of yield* exec('SELECT type, version FROM stored_kind')) {
      const { type, version } = z
        .object({ type: z.string(), version: z.int() })
        .parse(input);
      if (version > readableVersion(type, arms))
        return yield* Effect.fail(new DatabaseStoreNewer({ type, version }));
    }
  });
