/**
 * The store's projections:
 * the display and listing tables no row stores, each maintained by a pure
 * projector over decoded events. Their upkeep runs the projectors in
 * `Database`'s append transaction, making the writes they return; when the
 * store opens it rebuilds a projection whose stored version is not this
 * build's and catches up one that is behind (`projection_state`), so every
 * read finds them current. Projections are never migrated: a new version
 * rebuilds from the rows.
 *
 * - `listing`: per aggregate and listing key (`listingKeyOf`), the row a cold
 *   listing delivers; an open request and a queued follow-up are keys of
 *   their own (`pendingKeyOf`), deleted when their pair closes them.
 * - `usage`: a `usage` display row per priced `model.message` response,
 *   `context.edit` summary and model `run.description` label (a run with a
 *   run history stores its spend there, never as a `usage` row), and each
 *   run's spend summed by `sumUsageStats`.
 * - `run_record`: per run, the commits of the rows its `RunRows` reads and
 *   the two facts no single row states (`RunRecordSchema`); `runRowsOf`
 *   reads it back over those rows.
 *
 * This module reads decoded events only, never `event.data`.
 */
import { Effect, Schema } from 'effect';
import { withLogChannel } from '@logger/effectLog';
import { NO_APPROVAL_GRANTS } from '@shared/approvalBypassKind';
import {
  aggregateTarget,
  factName,
  FactNameSchema,
  listingKeyOf,
  listingTypeOf,
  pendingKeyOf,
  SessionRowDraftSchema,
  SessionRowSchema,
  sumUsageStats,
  TokenUsageStatsSchema,
  type AggregateId,
  type SessionRow,
  type TokenUsageStats,
} from '@shared/schemas';
import type { RowOf, RunRows } from '@shared/session/runRowsShape';
import {
  EVENT_COLUMNS,
  EVENT_FROM,
  aggregateColumns,
  aggregateOf,
  type SqlRow,
} from './rowCodec';
import { AGGREGATE } from './rowReader';
import type { RowReader } from './rowReader';

/** One write a projector asks its upkeep to make. */
type ProjectionOp =
  | {
      readonly table: 'listing_entry';
      readonly aggregate: AggregateId;
      readonly key: string;
      /** Null deletes the key. */
      readonly commit: number | null;
    }
  | {
      readonly table: 'projected_row';
      readonly commit: number;
      readonly type: 'usage';
      readonly data: string;
    }
  | {
      readonly table: 'run_usage';
      readonly aggregate: AggregateId;
      readonly commit: number;
      /** The listing's `usage` row data: the run's spend so far. */
      readonly data: string;
    }
  | {
      readonly table: 'run_record';
      readonly aggregate: AggregateId;
      readonly data: string;
    };

/** The tables a projector reads its aggregate's prior row from, each by its
 *  one stored column. */
const PRIOR_COLUMN = { run_usage: 'usage', run_record: 'record' } as const;

interface Projector {
  readonly version: number;
  /** The kinds it reads: what a catch-up selects. */
  readonly inputs: readonly string[];
  /** The prior row it reads by primary key before projecting, if any. */
  readonly prior: keyof typeof PRIOR_COLUMN | null;
  /** The table its rebuild empties, and the projected types it deletes. */
  readonly table: 'listing_entry' | 'run_usage' | 'run_record';
  readonly projects: readonly 'usage'[];
  /** `prior` is the stored column of the aggregate's prior row. */
  readonly project: (
    event: SessionRow,
    prior: string | undefined,
  ) => readonly ProjectionOp[];
  /** What an input row a catch-up could not decode (at `commit`, of
   *  `aggregate`) writes; absent, the row is left out, as the wide read that
   *  marks its run damaged leaves it out. */
  readonly unread?: (
    aggregate: AggregateId,
    commit: number,
    prior: string | undefined,
  ) => readonly ProjectionOp[];
}

/**
 * What a run's record holds: the commit of each row its `RunRows` reads
 * (null until one is written), the facts no one row states included by the
 * row that set them: `detach`, the `run.detach` that severed the start's
 * parent edge, and `closedBy`, the `followup.closed` or `run.removed` that
 * closed its input since its latest `run.activate`. `unread` holds the commits of its input rows that
 * did not decode when the record was built from stored rows: its read
 * selects them too, so it fails on them as a read of the run's rows does.
 */
const RunRecordSchema = Schema.Struct({
  start: Schema.NullOr(Schema.Int),
  policy: Schema.NullOr(Schema.Int),
  activation: Schema.NullOr(Schema.Int),
  end: Schema.NullOr(Schema.Int),
  stop: Schema.NullOr(Schema.Int),
  report: Schema.NullOr(Schema.Int),
  exit: Schema.NullOr(Schema.Int),
  config: Schema.NullOr(Schema.Int),
  position: Schema.NullOr(Schema.Int),
  userTitle: Schema.NullOr(Schema.Int),
  label: Schema.NullOr(Schema.Int),
  facts: Schema.Record(FactNameSchema, Schema.Int),
  detach: Schema.NullOr(Schema.Int),
  closedBy: Schema.NullOr(Schema.Int),
  unread: Schema.Array(Schema.Int),
});
type RunRecord = typeof RunRecordSchema.Type;
const RunRecordJson = Schema.fromJsonString(RunRecordSchema);
const decodeRunRecord = Schema.decodeUnknownSync(RunRecordJson);
const encodeRunRecord = Schema.encodeSync(RunRecordJson);

const EMPTY_RUN_RECORD: RunRecord = {
  start: null,
  policy: null,
  activation: null,
  end: null,
  stop: null,
  report: null,
  exit: null,
  config: null,
  position: null,
  userTitle: null,
  label: null,
  facts: {},
  detach: null,
  closedBy: null,
  unread: [],
};

/** What one row of kind `T` changes on its run's record. */
type RecordStep<T extends SessionRow['type']> = (
  record: RunRecord,
  row: RowOf<T>,
) => RunRecord;

/** What each kind a run's record reads changes on it; every other kind
 *  changes nothing. Its keys are the projector's inputs. */
const RECORD_STEPS: { readonly [T in SessionRow['type']]?: RecordStep<T> } = {
  'run.start': (record, row) => ({ ...record, start: row.commit }),
  'approval.policy': (record, row) => ({ ...record, policy: row.commit }),
  'run.detach': (record, row) => ({ ...record, detach: row.commit }),
  // A resumed run never carries the previous lifecycle's end or stop.
  'run.activate': (record, row) => ({
    ...record,
    activation: row.commit,
    end: null,
    stop: null,
    closedBy: null,
  }),
  'run.stop': (record, row) => ({ ...record, stop: row.commit }),
  'run.end': (record, row) => ({ ...record, end: row.commit }),
  'followup.closed': (record, row) => ({ ...record, closedBy: row.commit }),
  'run.removed': (record, row) => ({ ...record, closedBy: row.commit }),
  'run.report': (record, row) => ({ ...record, report: row.commit }),
  'process.exit': (record, row) => ({ ...record, exit: row.commit }),
  'run.config': (record, row) => ({ ...record, config: row.commit }),
  'run.position': (record, row) => ({ ...record, position: row.commit }),
  'plugin.fact': (record, row) => ({
    ...record,
    facts: { ...record.facts, [factName(row)]: row.commit },
  }),
  'run.description': (record, row) =>
    row.by === 'user'
      ? { ...record, userTitle: row.commit }
      : { ...record, label: row.commit },
};

/** What one row of a run changes on its record. */
function recordAfter(record: RunRecord, row: SessionRow): RunRecord {
  // cast: the step under `row.type` takes rows of that type; TypeScript
  // cannot tie a union-keyed lookup to its own key's row.
  const step = RECORD_STEPS[row.type] as
    | RecordStep<SessionRow['type']>
    | undefined;
  return step === undefined ? record : step(record, row);
}

/** The commits a stored run record names: the rows `runRowsOf` reads. */
export const runRecordCommits = (stored: string): number[] => {
  const { facts, unread, ...rows } = decodeRunRecord(stored);
  return [...Object.values(rows), ...Object.values(facts), ...unread].flatMap(
    (commit) => (commit === null ? [] : [commit]),
  );
};

/**
 * A run's `RunRows` from its stored record and the rows it names
 * (`runRecordCommits`). Its title is its latest user title, else its latest
 * model label: a user's title stands until the user renames again. Its
 * grants are its latest `approval.policy`'s, else its start's.
 */
export function runRowsOf(
  stored: string,
  rows: readonly SessionRow[],
): RunRows {
  const record = decodeRunRecord(stored);
  const byCommit = new Map(rows.map((row) => [row.commit, row]));
  const row = <T extends SessionRow['type']>(
    type: T,
    commit: number | null,
  ): RowOf<T> | null => {
    if (commit === null) return null;
    const found = byCommit.get(commit);
    if (found?.type !== type)
      throw new Error(`The run record names no ${type} at commit ${commit}`);
    // cast: the row's type was just checked to be `T`.
    return found as RowOf<T>;
  };
  const start = row('run.start', record.start);
  const closer =
    record.closedBy !== null &&
    byCommit.get(record.closedBy)?.type === 'run.removed'
      ? row('run.removed', record.closedBy)
      : row('followup.closed', record.closedBy);
  const userTitle = row('run.description', record.userTitle);
  const label = row('run.description', record.label);
  const facts: Record<string, RowOf<'plugin.fact'>> = {};
  for (const [name, commit] of Object.entries(record.facts)) {
    const fact = row('plugin.fact', commit);
    if (fact !== null) facts[name] = fact;
  }
  return {
    start,
    parent:
      row('run.detach', record.detach) === null
        ? (start?.parent ?? null)
        : null,
    activation: row('run.activate', record.activation),
    end: row('run.end', record.end),
    stop: row('run.stop', record.stop),
    inputClosed: closer !== null,
    report: row('run.report', record.report)?.report ?? null,
    exit: row('process.exit', record.exit),
    config: row('run.config', record.config)?.config ?? null,
    position: row('run.position', record.position),
    title: userTitle ?? label,
    label,
    grants:
      row('approval.policy', record.policy)?.snapshot ??
      (start === null ? null : (start.approvalPolicy ?? NO_APPROVAL_GRANTS)),
    facts,
  };
}

/** A priced row's spend as the `usage` display row carries it: its counts,
 *  cost, route and plan, without the call's surface and response time. */
function pricedUsage(event: SessionRow): TokenUsageStats | null {
  let priced = null;
  if (event.type === 'context.edit') priced = event.payload.usage;
  if (
    event.type === 'model.message' &&
    (event.payload.kind === 'response' || event.payload.kind === 'failed')
  )
    priced = event.payload.usage ?? null;
  if (event.type === 'run.description') priced = event.usage;
  if (priced == null) return null;
  const { provider, responseTimeMs, ...usage } = priced;
  return usage;
}

/** The `usage` display row a priced row projects, as a display read of the
 *  store returns it, or none. */
export function usageRows(event: SessionRow): readonly SessionRow[] {
  if (event.type === 'usage') return [];
  const usage = pricedUsage(event);
  if (usage === null) return [];
  const { aggregateId, seq, commit, origin, at } = event;
  return [
    decodeUsageRow({
      type: 'usage',
      usage,
      aggregateId,
      seq,
      commit,
      origin,
      at,
    }),
  ];
}
const decodeUsageRow = Schema.decodeUnknownSync(SessionRowSchema);

/** The projections this build maintains; {@link PROJECTORS} has one each. */
const PROJECTION_NAMES = ['listing', 'usage', 'run_record'] as const;
type ProjectionName = (typeof PROJECTION_NAMES)[number];

const PROJECTORS = {
  listing: {
    version: 1,
    inputs: SessionRowDraftSchema.members
      .map((schema) => schema.fields.type.literal)
      .filter((type) => listingTypeOf({ type }) !== null),
    prior: null,
    table: 'listing_entry',
    projects: [],
    // Every input has a listing type (`inputs`); a pending key replaces it.
    project: (event) => {
      const pending = pendingKeyOf(event);
      const key = pending?.key ?? listingKeyOf(event);
      if (key === null) return [];
      const commit = pending?.open === false ? null : event.commit;
      return [
        { table: 'listing_entry', aggregate: event.aggregateId, key, commit },
      ];
    },
  },
  usage: {
    // v2: the rows carry `TurnUsage`'s count names and no `elapsedTime`.
    // v3: a model label's `run.description` is priced too.
    version: 3,
    inputs: ['model.message', 'context.edit', 'run.description', 'usage'],
    prior: 'run_usage',
    table: 'run_usage',
    projects: ['usage'],
    project: (event, prior) => {
      const stored = event.type === 'usage' ? event.usage : null;
      const priced = stored ?? pricedUsage(event);
      if (priced === null) return [];
      const total = sumUsageStats(
        prior === undefined
          ? [priced]
          : [decodeStoredUsage(prior).usage, priced],
      );
      return [
        ...(stored === null
          ? [
              {
                table: 'projected_row' as const,
                commit: event.commit,
                type: 'usage' as const,
                data: JSON.stringify({ usage: priced }),
              },
            ]
          : []),
        {
          table: 'run_usage',
          aggregate: event.aggregateId,
          commit: event.commit,
          data: JSON.stringify({ usage: total }),
        },
      ];
    },
  },
  run_record: {
    version: 1,
    inputs: Object.keys(RECORD_STEPS),
    prior: 'run_record',
    table: 'run_record',
    projects: [],
    unread: (aggregate, commit, prior) => {
      if (aggregateTarget(aggregate).kind !== 'run') return [];
      const record =
        prior === undefined ? EMPTY_RUN_RECORD : decodeRunRecord(prior);
      return [
        {
          table: 'run_record',
          aggregate,
          data: encodeRunRecord({
            ...record,
            unread: [...record.unread, commit],
          }),
        },
      ];
    },
    // A plugin's own aggregate keeps no run record.
    project: (event, prior) =>
      aggregateTarget(event.aggregateId).kind === 'run'
        ? [
            {
              table: 'run_record',
              aggregate: event.aggregateId,
              data: encodeRunRecord(
                recordAfter(
                  prior === undefined
                    ? EMPTY_RUN_RECORD
                    : decodeRunRecord(prior),
                  event,
                ),
              ),
            },
          ]
        : [],
  },
} as const satisfies Record<ProjectionName, Projector>;

const PROJECTION_INPUTS = new Map(
  PROJECTION_NAMES.map((name) => [name, new Set(PROJECTORS[name].inputs)]),
);
/** The listing's input kinds and the `usage` kind: what a view reads of
 *  every aggregate, beside its subscribed aggregates' rows. */
export const LISTED_KINDS: ReadonlySet<string> = new Set([
  ...PROJECTORS.listing.inputs,
  'usage',
]);
/** {@link LISTED_KINDS} as the JSON list a read binds. */
export const LISTED_TYPES = JSON.stringify([...LISTED_KINDS]);
/** One projection's checkpoint: its projector's version and the commit it
 *  read through. A name this build does not know (a later build's, or one
 *  an earlier build kept) is ignored. */
const ProjectionStateSchema = Schema.Struct({
  name: Schema.String,
  version: Schema.Int,
  through: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

/** A projection this build owns (its version) and that has read every row
 *  through `top`; one with no state yet is current only on a store that
 *  never held a row, so a fresh store's first read writes nothing. */
const isCurrent = (
  name: ProjectionName,
  state: typeof ProjectionStateSchema.Type | undefined,
  top: number,
): boolean =>
  state === undefined
    ? top === 0
    : state.version === PROJECTORS[name].version && state.through >= top;

const RunUsageSchema = Schema.Struct({ usage: TokenUsageStatsSchema });
const decodeStoredUsage = Schema.decodeUnknownSync(
  Schema.fromJsonString(RunUsageSchema),
);

/** The statement and parameters that make one projector's write. */
function opStatement(op: ProjectionOp): [string, unknown[]] {
  switch (op.table) {
    case 'listing_entry':
      return op.commit === null
        ? [
            `DELETE FROM listing_entry WHERE aggregate = ${AGGREGATE} AND key = ?`,
            [...aggregateColumns(op.aggregate), op.key],
          ]
        : [
            `INSERT INTO listing_entry (aggregate, key, "commit")
             VALUES (${AGGREGATE}, ?, ?) ON CONFLICT(aggregate, key)
             DO UPDATE SET "commit" = excluded."commit"`,
            [...aggregateColumns(op.aggregate), op.key, op.commit],
          ];
    case 'projected_row':
      return [
        `INSERT INTO projected_row ("commit", type, data) VALUES (?, ?, ?)
         ON CONFLICT("commit", type) DO UPDATE SET data = excluded.data`,
        [op.commit, op.type, op.data],
      ];
    case 'run_record':
      return [
        `INSERT INTO run_record (aggregate, record) VALUES (${AGGREGATE}, ?)
         ON CONFLICT(aggregate) DO UPDATE SET record = excluded.record`,
        [...aggregateColumns(op.aggregate), op.data],
      ];
    case 'run_usage':
      return [
        `INSERT INTO run_usage (aggregate, "commit", usage)
         VALUES (${AGGREGATE}, ?, ?) ON CONFLICT(aggregate) DO UPDATE
         SET "commit" = excluded."commit", usage = excluded.usage`,
        [...aggregateColumns(op.aggregate), op.commit, op.data],
      ];
  }
}

/** The upkeep of the store at `path`'s projections, in the caller's
 *  transaction: `exec` runs a statement, `read` decodes selected rows. */
export function projectionUpkeep<E>(
  exec: (
    statement: string,
    params?: readonly unknown[],
  ) => Effect.Effect<readonly SqlRow[], E>,
  read: RowReader<E>['read'],
  path: string,
) {
  const states = Effect.map(
    exec(
      'SELECT name, version, through_commit AS through FROM projection_state',
    ),
    (rows) =>
      new Map(
        Schema.decodeUnknownSync(Schema.Array(ProjectionStateSchema))(rows).map(
          (s) => [s.name, s],
        ),
      ),
  );
  const setState = (name: ProjectionName, through: number) =>
    exec(
      `INSERT INTO projection_state (name, version, through_commit)
       VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET
       version = excluded.version, through_commit = excluded.through_commit`,
      [name, PROJECTORS[name].version, through],
    );
  /** A projector's prior row of `aggregate`: its stored column, if any. */
  const priorOf = Effect.fnUntraced(function* (
    projector: Projector,
    aggregate: AggregateId,
  ) {
    if (projector.prior === null) return undefined;
    const row = (yield* exec(
      `SELECT ${PRIOR_COLUMN[projector.prior]} AS prior FROM ${projector.prior} WHERE aggregate = ${AGGREGATE}`,
      aggregateColumns(aggregate),
    ))[0];
    return row === undefined ? undefined : String(row.prior);
  });
  /** Run the named projectors over decoded events: a projector with a
   *  prior row reads it back first. */
  const project = (
    events: readonly SessionRow[],
    names: readonly ProjectionName[],
  ) =>
    Effect.forEach(events, (event) =>
      Effect.forEach(
        names,
        Effect.fnUntraced(function* (name) {
          if (!PROJECTION_INPUTS.get(name)?.has(event.type)) return;
          const projector: Projector = PROJECTORS[name];
          const prior = yield* priorOf(projector, event.aggregateId);
          for (const op of projector.project(event, prior))
            yield* exec(...opStatement(op));
        }),
      ),
    );
  return {
    /** One catch-up step: a projection another build versioned is emptied
     *  and rebuilt; one behind `top` reads up to 1,000 rows on. Whether
     *  every projection reached `top`. */
    catchUp: Effect.fn('projections.catchUp')(function* (top: number) {
      const current = yield* states;
      let all = true;
      for (const name of PROJECTION_NAMES) {
        const state = current.get(name);
        if (isCurrent(name, state, top)) continue;
        const own = state?.version === PROJECTORS[name].version;
        if (state !== undefined && !own)
          yield* Effect.logInfo(
            `Rebuilding the ${name} projection of ${path} (stored version ${state.version}, this build's ${PROJECTORS[name].version}).`,
          ).pipe(withLogChannel('sessionDatabase'));
        if (!own) {
          yield* exec(`DELETE FROM ${PROJECTORS[name].table}`);
          yield* exec(
            'DELETE FROM projected_row WHERE type IN (SELECT value FROM json_each(?))',
            [JSON.stringify(PROJECTORS[name].projects)],
          );
        }
        const through = own ? state.through : 0;
        const rows =
          through >= top
            ? []
            : yield* exec(
                `SELECT ${EVENT_COLUMNS} FROM ${EVENT_FROM}
                   WHERE e.type IN (SELECT value FROM json_each(?))
                     AND e."commit" > ? AND e."commit" <= ?
                   ORDER BY e."commit" LIMIT 1000`,
                [JSON.stringify(PROJECTORS[name].inputs), through, top],
              );
        const events = yield* read(rows, false);
        yield* project(events, [name]);
        // The rows the wide read left out, for a projector that records them.
        const projector: Projector = PROJECTORS[name];
        const decoded = new Set(events.map((event) => event.commit));
        for (const row of projector.unread === undefined ? [] : rows) {
          const commit = Schema.decodeUnknownSync(Schema.Int)(row.commit);
          if (decoded.has(commit)) continue;
          const aggregate = aggregateOf(row.kind, row.logicalId);
          const prior = yield* priorOf(projector, aggregate);
          for (const op of projector.unread?.(aggregate, commit, prior) ?? [])
            yield* exec(...opStatement(op));
        }
        const reached =
          rows.length < 1000
            ? top
            : Schema.decodeUnknownSync(Schema.Int)(rows.at(-1)?.commit);
        yield* setState(name, reached);
        all &&= reached >= top;
      }
      return all;
    }),
    /** A batch just appended: every projection, caught up at open, follows
     *  it. */
    follow: Effect.fn('projections.follow')(function* (
      events: readonly SessionRow[],
    ) {
      const through = events.at(-1)?.commit;
      if (through === undefined) return;
      yield* project(events, PROJECTION_NAMES);
      for (const name of PROJECTION_NAMES) yield* setState(name, through);
    }),
  };
}
