/**
 * The row codec: the one module that knows a stored shape. It turns a validated draft
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
 *   stored `$$b`), and the read inflates it, digest verified, from the
 *   batch's blobs the reader fetched (`rowReader.ts`). A `context.blob`
 *   row's value is stored as its canonical JSON text.
 * - **Media.** A media part and a tool attachment name their bytes by the
 *   same address; the draft brings the bytes beside the row (`WithBlobs`),
 *   stored under their address or linked when the store holds them. No
 *   read inflates them: the invocation resolves them before the call.
 * - **Aggregates.** An `AggregateId` is stored as two columns, `kind` and
 *   `logical_id`, and composed back from them here.
 */
import { constants, zstdCompressSync } from 'node:zlib';
import stableStringify from 'safe-stable-stringify';
import { Effect, Predicate, Result, Schema } from 'effect';
import {
  AggregateIdSchema,
  aggregateTarget,
  CURRENT_VALUE_VERSION,
  pluginFactFloor,
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
  DatabaseRowEarlier,
  DatabaseStoreNewer,
} from '@shared/session/database';
import type { DraftBlob, WithBlobs } from '@shared/session/historyTurns';
import type { PluginArms } from '@tools/plugins';
import { blobAddress, sha256Hex } from '@utils/core/idHash';

/** One selected store row, its columns by name, decoded where it is read. */
export type SqlRow = Readonly<Record<string, unknown>>;

// zstd: Node 22.15+ (the CLI needs 22.19; Electron and VS Code ship 24).
if (typeof zstdCompressSync !== 'function')
  throw new Error('The session store needs zstd: Node 22.19 or later.');

/** A payload key shaped `$b`, `$$b`, …: stored with one more `$`. */
const REF_SHAPED = /^\$+b$/;
const ZSTD_LEVEL_3 = { params: { [constants.ZSTD_c_compressionLevel]: 3 } };
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
  s.logical_id AS logicalId, e.seq AS seq, e.type AS type,
  e.version AS version, e.origin AS origin, e.at AS at, e.data AS data`;
/** An event `e`'s aggregate key, joined on. */
export const EVENT_JOINS = `JOIN event_sequence s ON s.id = e.aggregate`;
/** An event with its aggregate's key. */
export const EVENT_FROM = `event e ${EVENT_JOINS}`;

/** A draft as `Database` inserts it, with the blobs it references. */
export interface EncodedRow {
  readonly type: string;
  readonly version: number;
  readonly data: string;
  readonly blobs: readonly { digest: string; value: Uint8Array }[];
  /** Blobs the row names that the store already holds: linked to the row,
   *  so collection keeps them while it lives. */
  readonly references: readonly string[];
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
  return Schema.decodeUnknownSync(AggregateIdSchema)(
    JSON.stringify([kind, logicalId]),
  );
}

const hasKind = (type: string): type is SessionEventDraft['type'] =>
  Object.hasOwn(ROW_KINDS, type);

/** The lowest stored version of `type` this build reads: an older one has
 *  no upcaster here, so an earlier build wrote it. */
const readableFrom = (type: SessionEventDraft['type']): number =>
  ROW_KINDS[type].version - ROW_KINDS[type].upcast.length;
/** Whether `decodeRow` parses this row's data (a kind and version this
 *  build reads): another build's row is refused before its blobs are read. */
export function decodable(row: SqlRow): boolean {
  const { type, version } = Schema.decodeUnknownSync(RowSchema)(row);
  if (!hasKind(type)) return false;
  const stored = version ?? ROW_KINDS[type].version;
  return stored >= readableFrom(type) && stored <= ROW_KINDS[type].version;
}

/** The queries, with their parameters, for the runs holding a row an
 *  earlier build wrote below the version this build reads. */
export const EARLIER_RUNS: readonly (readonly [string, readonly unknown[]])[] =
  Object.keys(ROW_KINDS)
    .filter(hasKind)
    .flatMap((type) =>
      readableFrom(type) > 1
        ? [
            [
              `SELECT s.logical_id AS logicalId, min(e."commit") AS "commit",
                e.type AS type FROM ${EVENT_FROM}
                WHERE s.kind = 'run' AND e.type = ? AND e.version < ?
                GROUP BY s.logical_id`,
              [type, readableFrom(type)],
            ] as const,
          ]
        : [],
    );

/** Validate a draft and encode it at its kind's current version, with the
 *  blobs it brings. Throws on a draft that does not parse, is not JSON, or
 *  whose blob does not hash to its digest. */
export function prepareEventDraft(input: WithBlobs<SessionEventDraft>): {
  readonly draft: SessionEventDraft;
  readonly row: EncodedRow;
} {
  const { blobs = [], ...rest } = input;
  const draft = Schema.decodeUnknownSync(SessionEventDraftSchema)(rest);
  return { draft, row: encodeDraft(draft, blobs) };
}

export function encodeDraft(
  draft: SessionEventDraft,
  brought: readonly DraftBlob[] = [],
): EncodedRow {
  const { type, aggregateId: _key, ...payload } = draft;
  const { version } = ROW_KINDS[type];
  let stored: object = payload;
  if (draft.type === 'context.blob') {
    const { digest, value } = draft.payload;
    const canonical = stableStringify(value);
    if (sha256Hex(canonical) !== digest)
      throw new Error(`The context blob ${digest} does not hash to its digest`);
    stored = { ...payload, payload: { digest, value: canonical } };
  }
  const blobs = new Map<string, string>();
  const references = new Set<string>();
  for (const { digest, text } of brought) {
    if (text === undefined) references.add(digest);
    else if (blobAddress(text) !== digest)
      throw new Error(`The blob ${digest} does not hash to its address`);
    else blobs.set(digest, JSON.stringify(text));
  }
  // The replacer sees each value (after `toJSON`) before its children.
  const data = JSON.stringify(stored, (_key, value: unknown) => {
    if (typeof value === 'string' && value.length >= 4096) {
      const json = JSON.stringify(value);
      const digest = sha256Hex(json);
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
    references: [...references].filter((digest) => !blobs.has(digest)),
  };
}

/** Where a row failed, never its stored text (a JSON parse error quotes it). */
function causeOf(error: unknown): string {
  if (error instanceof SyntaxError) return 'not JSON';
  // The rendered issue names what was expected and where, never the value.
  if (error instanceof Schema.SchemaError)
    return error.message.replaceAll(/\s*\n\s*/g, ' ');
  return String(error);
}

/** A selected row's columns, as `EVENT_COLUMNS` names them. */
export const RowSchema = Schema.Struct({
  commit: Schema.Int,
  kind: Schema.String,
  logicalId: Schema.String,
  seq: Schema.Int,
  type: Schema.String,
  version: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  origin: Schema.String,
  at: Schema.Int,
  data: Schema.String,
});
/** A batch's blobs, inflated and verified by the reader, by digest. */
export type Blobs = ReadonlyMap<string, string>;

const jsonObject = Schema.decodeUnknownSync(Schema.JsonObject);

/** `data`, its references inflated from `blobs` (one missing throws) and
 *  its escaped keys restored. */
function parseData(data: string, blobs: Blobs): unknown {
  if (!/"\$+b":/.test(data)) return JSON.parse(data);
  return JSON.parse(data, (_key, value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      return value;
    if (!('$b' in value)) return renameRefShaped(value, (key) => key.slice(1));
    const digest = String(value.$b);
    const text = blobs.get(digest);
    if (text === undefined) throw new Error(`Blob ${digest} is missing`);
    return text;
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
export function decodeRow(
  input: SqlRow,
  arms: PluginArms,
  blobs: Blobs,
): Result.Result<
  SessionEvent | LeftOut,
  DatabaseStoreNewer | DatabaseRowCorrupt | DatabaseRowEarlier
> {
  const row = Schema.decodeUnknownSync(RowSchema)(input);
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
  if (version > ROW_KINDS[row.type].version)
    return Result.fail(new DatabaseStoreNewer({ type: row.type, version }));
  if (version < readableFrom(row.type))
    return Result.fail(
      new DatabaseRowEarlier({ commit: row.commit, type: row.type }),
    );
  let data: Record<string, JsonValue>;
  try {
    data = jsonObject(parseData(row.data, blobs));
    for (const step of ROW_KINDS[row.type].upcast.slice(
      version - readableFrom(row.type),
    ))
      data = { ...step(data) };
    if (row.type === 'context.blob') {
      const field = jsonObject(data.payload);
      // The value is stored canonical, so its text hashes to its address.
      const text = Schema.decodeUnknownSync(Schema.String)(field.value);
      if (sha256Hex(text) !== field.digest) throw new Error('digest mismatch');
      data = { ...data, payload: { ...field, value: JSON.parse(text) } };
    }
  } catch (error) {
    return corrupt(error);
  }
  const parsed = Schema.decodeUnknownResult(SessionEventSchema)({
    ...data,
    aggregateId: aggregateOf(row.kind, row.logicalId),
    seq: row.seq,
    commit: row.commit,
    origin: row.origin,
    at: row.at,
    type: row.type,
  });
  if (!Result.isSuccess(parsed)) return corrupt(parsed.failure);
  const event = parsed.success;
  if (event.type !== 'plugin.fact') return Result.succeed(event);
  const name = `${event.plugin}/${event.kind}`;
  const arm = pluginFactArm(event, row.commit, arms);
  if (Result.isFailure(arm)) return Result.fail(arm.failure);
  if (arm.success === undefined)
    return Result.succeed({ _tag: 'leftOut', kind: name });
  let value = event.value;
  for (const step of arm.success.upcasters.slice(
    event.version - pluginFactFloor(arm.success),
  ))
    value = step(value);
  const checked = Schema.decodeUnknownResult(arm.success.schema)(value);
  if (Result.isFailure(checked))
    return corrupt(checked.failure, `plugin.fact/${name}`);
  return Result.succeed({ ...event, version: arm.success.version, value });
}

/**
 * A stored plugin fact's header, its row's top-level `plugin`, `kind` and
 * `version`, against its arm: the arm, none when this build lacks the
 * plugin (the row is left out), or a newer or an earlier build's version.
 * `decodeRow` and the reader's earlier-run scan both ask it.
 */
export function pluginFactArm(
  fact: {
    readonly plugin: string;
    readonly kind: string;
    readonly version: number;
  },
  commit: number,
  arms: PluginArms,
): Result.Result<
  PluginArms[string] | undefined,
  DatabaseStoreNewer | DatabaseRowEarlier
> {
  const type = pluginKind(fact.plugin, fact.kind);
  const arm = arms[`${fact.plugin}/${fact.kind}`];
  if (arm === undefined) return Result.succeed(undefined);
  if (fact.version > arm.version)
    return Result.fail(new DatabaseStoreNewer({ type, version: fact.version }));
  if (fact.version < pluginFactFloor(arm))
    return Result.fail(new DatabaseRowEarlier({ commit, type }));
  return Result.succeed(arm);
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
export const storeGate = Effect.fn('rowCodec.storeGate')(function* <E>(
  exec: (statement: string) => Effect.Effect<readonly SqlRow[], E>,
  arms: PluginArms,
): Effect.fn.Return<void, E | DatabaseStoreNewer> {
  for (const input of yield* exec('SELECT type, version FROM stored_kind')) {
    const { type, version } = Schema.decodeUnknownSync(
      Schema.Struct({ type: Schema.String, version: Schema.Int }),
    )(input);
    if (version > readableVersion(type, arms))
      return yield* new DatabaseStoreNewer({ type, version });
  }
});
