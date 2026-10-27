/**
 * The store's projections:
 * the display and listing tables no row stores, each maintained by a pure
 * projector over decoded events. Their upkeep runs the projectors in
 * `Database`'s append transaction, making the writes they return; before a
 * read it rebuilds a projection whose stored version is not this build's and
 * catches up one that is behind (`projection_state`). Projections are never
 * migrated: a new version rebuilds from the rows.
 *
 * - `listing`: per aggregate and listing key (`listingKeyOf`), the row a cold
 *   listing delivers; an open request and a queued follow-up are keys of
 *   their own (`pendingKeyOf`), deleted when their pair closes them.
 * - `usage`: a `usage` display row per priced `model.message` response and
 *   `context.edit` summary (a run with a run history stores its spend there,
 *   never as a `usage` row), and each run's spend summed by `sumUsageStats`.
 * - `model`: a `run.model` display row at each `run.config` whose model
 *   differs from the one before it, and each run's latest switch.
 *
 * This module reads decoded events only, never `event.data`.
 */
import { Effect, Schema } from 'effect';
import { withLogChannel } from '@logger/effectLog';
import {
  listingKeyOf,
  listingTypeOf,
  pendingKeyOf,
  SessionEventDraftSchema,
  sumUsageStats,
  TokenUsageStatsSchema,
  type AggregateId,
  type ExtendedTokenUsageStats,
  type SessionEvent,
  type TokenUsageStats,
} from '@shared/schemas';
import {
  EVENT_COLUMNS,
  EVENT_FROM,
  aggregateColumns,
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
      readonly type: 'usage' | 'run.model';
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
      readonly table: 'run_model';
      readonly aggregate: AggregateId;
      readonly model: string;
      readonly commit: number | null;
    };

/** A run's prior row in the table a projector reads back. */
interface ProjectionPrior {
  readonly usage?: TokenUsageStats;
  readonly model?: { readonly model: string; readonly commit: number | null };
}

interface Projector {
  readonly version: number;
  /** The kinds it reads: what a catch-up selects. */
  readonly inputs: readonly string[];
  /** The prior row it reads by primary key before projecting, if any. */
  readonly prior: 'run_usage' | 'run_model' | null;
  /** The table its rebuild empties, and the projected types it deletes. */
  readonly table: 'listing_entry' | 'run_usage' | 'run_model';
  readonly projects: readonly ('usage' | 'run.model')[];
  readonly project: (
    event: SessionEvent,
    prior: ProjectionPrior,
  ) => readonly ProjectionOp[];
}

/** A priced row's spend as the `usage` display row carries it; an absent
 *  field stays absent, as `JSON.stringify` and `sumUsageStats` read it. */
function pricedUsage(event: SessionEvent): ExtendedTokenUsageStats | null {
  let priced = null;
  if (event.type === 'context.edit') priced = event.payload.usage;
  if (event.type === 'model.message' && event.payload.kind === 'response')
    priced = event.payload.usage;
  if (priced == null) return null;
  return {
    inputTokens: priced.inputTokens,
    outputTokens: priced.outputTokens,
    cost: priced.cost,
    cacheReadInputTokens: priced.cachedInputTokens,
    cacheMissInputTokens: priced.cacheMissInputTokens,
    cacheCreationInputTokens: priced.cacheCreationTokens,
    reasoningTokens: priced.reasoningTokens,
    toolUseTokens: priced.toolUsePromptTokens,
    elapsedTime: priced.responseTimeMs / 1000,
    usageRoute: priced.usageRoute,
    usagePlan: priced.usagePlan,
  };
}

const PROJECTORS = {
  listing: {
    version: 1,
    inputs: SessionEventDraftSchema.members
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
    version: 1,
    inputs: ['model.message', 'context.edit', 'usage'],
    prior: 'run_usage',
    table: 'run_usage',
    projects: ['usage'],
    project: (event, prior) => {
      const stored = event.type === 'usage' ? event.usage : null;
      const priced = stored ?? pricedUsage(event);
      if (priced === null) return [];
      const total = sumUsageStats(
        prior.usage === undefined ? [priced] : [prior.usage, priced],
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
  model: {
    version: 1,
    inputs: ['run.config'],
    prior: 'run_model',
    table: 'run_model',
    projects: ['run.model'],
    project: (event, prior) => {
      if (event.type !== 'run.config') return [];
      const model = event.config.model;
      if (model === undefined) return [];
      const switched = prior.model !== undefined && prior.model.model !== model;
      return [
        ...(switched
          ? [
              {
                table: 'projected_row' as const,
                commit: event.commit,
                type: 'run.model' as const,
                data: JSON.stringify({ model }),
              },
            ]
          : []),
        {
          table: 'run_model',
          aggregate: event.aggregateId,
          model,
          commit: switched ? event.commit : (prior.model?.commit ?? null),
        },
      ];
    },
  },
} as const satisfies Record<string, Projector>;

type ProjectionName = keyof typeof PROJECTORS;
const PROJECTION_NAMES = Object.keys(PROJECTORS) as ProjectionName[];
const PROJECTION_INPUTS = new Map(
  PROJECTION_NAMES.map((name) => [name, new Set(PROJECTORS[name].inputs)]),
);
/** The listing's input kinds and the stored `usage` kind, as a JSON list. */
export const LISTED_TYPES = JSON.stringify([
  ...PROJECTORS.listing.inputs,
  'usage',
]);
/** One projection's checkpoint: its projector's version and the commit it
 *  read through. A name this build does not know is a later build's. */
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
const RunModelSchema = Schema.Struct({
  model: Schema.String,
  commit: Schema.NullOr(Schema.Int),
});

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
    case 'run_usage':
      return [
        `INSERT INTO run_usage (aggregate, "commit", usage)
         VALUES (${AGGREGATE}, ?, ?) ON CONFLICT(aggregate) DO UPDATE
         SET "commit" = excluded."commit", usage = excluded.usage`,
        [...aggregateColumns(op.aggregate), op.commit, op.data],
      ];
    case 'run_model':
      return [
        `INSERT INTO run_model (aggregate, model, "commit")
         VALUES (${AGGREGATE}, ?, ?) ON CONFLICT(aggregate) DO UPDATE
         SET model = excluded.model, "commit" = excluded."commit"`,
        [...aggregateColumns(op.aggregate), op.model, op.commit],
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
  /** Run the named projectors over decoded events: a projector with a
   *  prior row reads it back first. */
  const project = (
    events: readonly SessionEvent[],
    names: readonly ProjectionName[],
  ) =>
    Effect.forEach(events, (event) =>
      Effect.forEach(names, (name) =>
        Effect.gen(function* () {
          if (!PROJECTION_INPUTS.get(name)?.has(event.type)) return;
          const projector = PROJECTORS[name];
          const row =
            projector.prior === null
              ? undefined
              : (yield* exec(
                  `SELECT * FROM ${projector.prior} WHERE aggregate = ${AGGREGATE}`,
                  aggregateColumns(event.aggregateId),
                ))[0];
          let prior: ProjectionPrior = {};
          if (row !== undefined && projector.prior === 'run_usage')
            prior = Schema.decodeUnknownSync(RunUsageSchema)(
              JSON.parse(String(row.usage)),
            );
          if (row !== undefined && projector.prior === 'run_model')
            prior = { model: Schema.decodeUnknownSync(RunModelSchema)(row) };
          for (const op of projector.project(event, prior))
            yield* exec(...opStatement(op));
        }),
      ),
    );
  return {
    /** Whether every projection is current through `top`. */
    current: (top: number) =>
      Effect.map(states, (current) =>
        PROJECTION_NAMES.every((name) =>
          isCurrent(name, current.get(name), top),
        ),
      ),
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
        const through = own ? (state?.through ?? 0) : 0;
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
        yield* project(yield* read(rows, false), [name]);
        const reached =
          rows.length < 1000
            ? top
            : Schema.decodeUnknownSync(Schema.Int)(rows.at(-1)?.commit);
        yield* setState(name, reached);
        all &&= reached >= top;
      }
      return all;
    }),
    /** A batch committed after `before`: a projection current through
     *  `before` follows it; any other catches up on its owner's next read. */
    follow: Effect.fn('projections.follow')(function* (
      events: readonly SessionEvent[],
      before: number,
    ) {
      const through = events.at(-1)?.commit ?? before;
      const current = yield* states;
      const following = PROJECTION_NAMES.filter((name) =>
        isCurrent(name, current.get(name), before),
      );
      yield* project(events, following);
      for (const name of following) yield* setState(name, through);
    }),
  };
}
