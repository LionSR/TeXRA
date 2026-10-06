/**
 * The store's projections
 * (`.agents/docs/proposed/architecture/2026-09-28-storage-v1-design.md` §5):
 * the display and listing tables no row stores, each maintained by a pure
 * projector over decoded events. `Database` runs the projectors inside the
 * append transaction and executes the operations they return; a read first
 * rebuilds a projection whose stored version is not this build's and
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
import { z } from 'zod';
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
  EVENT_JOINS,
  PROJECTED_COLUMNS,
  PROJECTED_FROM,
} from './rowCodec';

/** One write a projector asks `Database` to make. */
export type ProjectionOp =
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
export interface ProjectionPrior {
  readonly usage?: TokenUsageStats;
  readonly model?: { readonly model: string; readonly commit: number | null };
}

interface Projector {
  readonly version: number;
  /** The kinds it reads: what a catch-up selects. */
  readonly inputs: readonly string[];
  /** The prior row it reads by primary key before projecting, if any. */
  readonly prior: 'run_usage' | 'run_model' | null;
  /** The projected display types its rebuild deletes. */
  readonly projects: readonly ('usage' | 'run.model')[];
  readonly project: (
    event: SessionEvent,
    prior: ProjectionPrior,
  ) => readonly ProjectionOp[];
}

const ALL_TYPES = SessionEventDraftSchema.options.map(
  (schema) => schema.shape.type.value,
);

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

export const PROJECTORS = {
  listing: {
    version: 1,
    inputs: ALL_TYPES.filter((type) => listingTypeOf({ type }) !== null),
    prior: null,
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

export type ProjectionName = keyof typeof PROJECTORS;
export const PROJECTION_NAMES = Object.keys(PROJECTORS) as ProjectionName[];
export const PROJECTION_INPUTS = new Map(
  PROJECTION_NAMES.map((name) => [name, new Set(PROJECTORS[name].inputs)]),
);
/** Each projection's table a rebuild empties, beside its projected rows. */
export const PROJECTION_TABLE: Readonly<Record<ProjectionName, string>> = {
  listing: 'listing_entry',
  usage: 'run_usage',
  model: 'run_model',
};
/**
 * One projection's checkpoint: the projector's version and the commit it has
 * read through. A name this build does not know is a later build's
 * projection and is left alone.
 */
const ProjectionStateSchema = z.object({
  name: z.string(),
  version: z.int(),
  through: z.int().nonnegative(),
});
type ProjectionState = z.infer<typeof ProjectionStateSchema>;

export function projectionStates(
  rows: readonly Readonly<Record<string, unknown>>[],
): ReadonlyMap<string, ProjectionState> {
  return new Map(
    rows.map((row) => {
      const state = ProjectionStateSchema.parse(row);
      return [state.name, state] as const;
    }),
  );
}

/** Whether `state` is this build's projection: its version. */
export const isOwn = (
  name: ProjectionName,
  state: ProjectionState | undefined,
): boolean => state?.version === PROJECTORS[name].version;

/** A projection this build owns and that has read every row through `top`;
 *  one with no state yet is current only on a store that never held a row,
 *  so a fresh store's first read writes nothing. */
export const isCurrent = (
  name: ProjectionName,
  state: ProjectionState | undefined,
  top: number,
): boolean =>
  state === undefined ? top === 0 : isOwn(name, state) && state.through >= top;

const RunUsageSchema = z.object({ usage: TokenUsageStatsSchema });
const RunModelSchema = z.object({
  model: z.string(),
  commit: z.int().nullable(),
});

/** A projector's prior row, as `Database` read it by primary key. */
export function priorOf(
  table: 'run_usage' | 'run_model',
  row: Readonly<Record<string, unknown>> | undefined,
): ProjectionPrior {
  if (row === undefined) return {};
  return table === 'run_usage'
    ? { usage: RunUsageSchema.parse(JSON.parse(String(row.usage))).usage }
    : { model: RunModelSchema.parse(row) };
}

/**
 * The listing: each aggregate's `listing_entry` rows, each run's spend
 * (`run_usage`, on its newest priced row's envelope) and its latest model
 * switch, in commit order. Primary-key joins only.
 */
/** The listed rows, driven from `listing_entry` (`CROSS JOIN` holds the
 *  order: a store is never `ANALYZE`d), each by its event's primary key. */
const LISTED = `listing_entry l CROSS JOIN event e ON e."commit" = l."commit"
  ${EVENT_JOINS}`;

export const READ_LISTING = `SELECT * FROM (
  SELECT ${EVENT_COLUMNS} FROM ${LISTED}
  UNION ALL
  SELECT u."commit" AS "commit", s.kind AS kind, s.logical_id AS logicalId,
    s.uid AS uid,
    e.seq AS seq, 'usage' AS type, NULL AS version, e.origin AS origin,
    e.at AS at, u.usage AS data, NULL AS blobs
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

/** Aggregates bound as two parallel `json_each(?)` arrays (`aggregateLists`),
 *  joined in this order: a free planner scans both arrays per aggregate. */
export const AGGREGATE_LIST = `WITH k(key, value) AS MATERIALIZED
  (SELECT key, value FROM json_each(?))
  SELECT s.id FROM json_each(?) l CROSS JOIN k ON k.key = l.key
  CROSS JOIN event_sequence s ON s.kind = k.value AND s.logical_id = l.value`;
/** Aggregates' claim state, the list bound as `AGGREGATE_LIST` binds. */
export const READ_STATE = `
SELECT s.kind, s.logical_id AS logicalId, s.uid, s.owner_id AS ownerId,
  s.closed_by IS NOT NULL AS closed, p.kind AS parentKind,
  p.logical_id AS parentLogicalId, s.start_commit AS startCommit
FROM event_sequence s LEFT JOIN event_sequence p ON p.id = s.parent_id
WHERE s.id IN (${AGGREGATE_LIST})
`;

/** Stored rows a display page reads before it runs on to its batch's end. */
export const DISPLAY_PAGE_ROWS = 2000;
/** Where a display page after a commit ends: 2,000 stored rows on, run to
 *  the end of the batch the last one is in, as a card's `tool.end` and the
 *  settlement it projects from share one batch (`settleCards`) and a batch's
 *  rows share one `at`. No row, or a NULL `through`: the page runs to the
 *  end. Counted in rows, so a stretch of collected commits bounds nothing. */
export const DISPLAY_PAGE_END = `WITH last AS (SELECT "commit", at FROM event
    WHERE "commit" > ? ORDER BY "commit" LIMIT 1 OFFSET ${DISPLAY_PAGE_ROWS - 1})
  SELECT (SELECT e."commit" - 1 FROM event e
    WHERE e."commit" > last."commit" AND e.at <> last.at
    ORDER BY e."commit" LIMIT 1) AS through FROM last`;

/**
 * The one display union: the `event` rows of the types bound first, every
 * projected row, and an optional further arm, narrowed by `where` over the
 * union's columns (`"commit"`, `kind`, `logicalId`, `seq`), which SQLite
 * pushes into each arm, so a range binds once.
 */
export const displayUnion = (where: string, order: string, arm?: string) =>
  `SELECT * FROM (
    SELECT ${EVENT_COLUMNS} FROM ${EVENT_FROM}
      WHERE e.type IN (SELECT value FROM json_each(?))
    UNION ALL SELECT ${PROJECTED_COLUMNS} FROM ${PROJECTED_FROM}
    ${arm === undefined ? '' : `UNION ALL ${arm}`}
  ) WHERE ${where} ORDER BY ${order}`;

/** The rows a projection's catch-up reads past its checkpoint, bounded. */
export const CATCH_UP = `SELECT ${EVENT_COLUMNS} FROM ${EVENT_FROM}
  WHERE e.type IN (SELECT value FROM json_each(?))
    AND e."commit" > ? AND e."commit" <= ?
  ORDER BY e."commit" LIMIT 1000`;
