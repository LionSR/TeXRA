/** Run history derived from committed session events. */

import { Effect, Stream } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';

import { type AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  isAgentRunRecord,
  RunRecordSchema,
  type RunRecord,
} from '@agent/core/definition/RunRecord';
import { withLogChannel } from '@logger/effectLog';
import {
  AgentCategory,
  aggregateTarget,
  type SessionEvent,
  type RunId,
  type RunIdentity,
  RUN_SUBSTATE,
  type BlockedAggregate,
  type OutputFileInfo,
  type ReadonlyRoundIndexed,
  type RunLifecycleStatus,
} from '@shared/schemas';
import { filterNotNull, toNewestFirstByTimestamp } from '@utils/core';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

import { checkpointExists } from './resumability';
const CHANNEL = 'RunListing';
const RUN_STORAGE_CONCURRENCY = 32;

// ============================================================================
// Public types
// ============================================================================

interface RunListingBase {
  id: RunId;
  timestamp: string;
  parentRunId?: RunId;
  /** The run's folded status; a terminal outcome phase is its durable
   *  outcome. */
  status: RunLifecycleStatus;
  /** A stop rested the run (the fold's paused substate), a status of its own. */
  paused?: true;
  /** Why this build cannot read the run whole (`RunView.blocked`). */
  blocked?: BlockedAggregate['reason'];
  /** AI-generated summary of what the session aimed to accomplish. */
  description?: string;
  /** The model the run is on, as the view folds it: its latest snapshot's
   *  (`run.model`), else the one it was launched with. */
  model?: string;
  /**
   * Whether a `run.snapshot` row exists on the run aggregate — one indexed
   * read per row, never a fold. This is what a listing needs to advertise
   * "this run can be continued"; loadability is decided by `RunLedger.load`,
   * which folds the one run asked for and refuses loudly.
   */
  checkpointPresent: boolean;
}

/** A native or tool-backed agent run: its record is always an AgentConfig. */
export type AgentRunListingEntry = RunListingBase & {
  kind: 'run';
  /** What the run is — the durable authority, stamped at registration. */
  identity: Extract<RunIdentity, { kind: 'agent' }>;
  record: AgentConfig;
};

export type RunListingEntry =
  | AgentRunListingEntry
  | (RunListingBase & {
      kind: 'run';
      identity: Exclude<RunIdentity, { kind: 'agent' }>;
      record: RunRecord;
    })
  | BlockedRunListingEntry;

/** A run whose record a newer TeXRA wrote (or is corrupt): listed with its
 *  status `blocked`, never opened. */
export type BlockedRunListingEntry = RunListingBase & {
  kind: 'blocked';
  identity: RunIdentity;
};

/** Narrow to the agent arm; nested `identity.kind` cannot discriminate the
 *  entry union for TypeScript, so this is the one spelled-out guard. */
function isAgentRunEntry(
  entry: RunListingEntry,
): entry is AgentRunListingEntry {
  return entry.kind === 'run' && entry.identity.kind === 'agent';
}

/**
 * True for runs a user should see in a history list, meaning the runs a
 * user started themselves. Excludes non-agent runs (background processes,
 * background scripts — `identity.kind` decides) and runs an agent
 * spawned (delegated subagents, a script's children, team members),
 * which belong to their parent's transcript rather than to the history list.
 * A blocked run is kept, as `blocked`.
 *
 * Every host's history listing must apply this filter. Lookups by explicit id
 * (`texra history show <id>`, export, resume) must not: naming a child run is
 * an explicit request to see it, and `listRuns()` itself therefore stays
 * unfiltered.
 */
export function isUserVisibleRun(
  entry: RunListingEntry,
): entry is AgentRunListingEntry | BlockedRunListingEntry {
  return (
    (isAgentRunEntry(entry) || entry.kind === 'blocked') &&
    entry.parentRunId === undefined
  );
}

/** The latest `run.config` row of each run in one committed listing. */
function recordRows(
  rows: readonly SessionEvent[],
): Map<RunId, Extract<SessionEvent, { type: 'run.config' }>> {
  const records = new Map<
    RunId,
    Extract<SessionEvent, { type: 'run.config' }>
  >();
  for (const row of rows) {
    if (row.type !== 'run.config') continue;
    const target = aggregateTarget(row.aggregateId);
    if (target.kind === 'run') records.set(target.id, row);
  }
  return records;
}

/**
 * Every run the session's fold lists, with its private record: the view
 * folded cold from the log (one run model, R1) beside the same listing's
 * `run.config` rows, parsed into the runtime's record.
 */
export const listRuns = Effect.fn('listRuns')(function* (
  session: SessionHandle,
): Effect.fn.Return<RunListingEntry[], Error> {
  const [view, listing] = yield* Effect.all([
    session.readView([]),
    Stream.runCollect(session.events.listing()),
  ]);
  const records = recordRows(listing);
  const results = yield* Effect.forEach(
    view.runs.values(),
    (run) =>
      Effect.gen(function* (): Effect.fn.Return<RunListingEntry | null, Error> {
        const id = run.id;
        const record = yield* Effect.try({
          try: () => {
            const row = records.get(id);
            return row === undefined ? null : RunRecordSchema.parse(row.config);
          },
          catch: ensureError,
        });
        const checkpointPresent = yield* checkpointExists(id, session);

        const base: RunListingBase = {
          id,
          timestamp: new Date(run.launchedAt).toISOString(),
          ...(run.parentId === null ? {} : { parentRunId: run.parentId }),
          status: run.status,
          ...(run.substate === RUN_SUBSTATE.PAUSED && { paused: true }),
          ...(run.blocked === null ? {} : { blocked: run.blocked }),
          ...(run.description === null ? {} : { description: run.description }),
          ...(run.model === null ? {} : { model: run.model }),
          checkpointPresent,
        };
        const identity = run.identity;
        // Registration commits `run.config` in the `run.start` batch, so a
        // readable run without one, or an agent run without an AgentConfig,
        // is corrupt: skipped loudly below.
        if (!record) {
          if (run.blocked !== null)
            return { ...base, kind: 'blocked', identity };
          return yield* Effect.fail(new Error('no run.config row'));
        }
        if (identity.kind === 'agent') {
          if (!isAgentRunRecord(record))
            return yield* Effect.fail(
              new Error('agent run without an AgentConfig'),
            );
          return { ...base, kind: 'run', identity, record };
        }
        return { ...base, kind: 'run', identity, record };
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `Skipping corrupt run ${run.id}: ${toErrorMessage(error)}`,
          ).pipe(withLogChannel(CHANNEL), Effect.as(null)),
        ),
      ),
    { concurrency: RUN_STORAGE_CONCURRENCY },
  );

  return toNewestFirstByTimestamp(
    results.filter(filterNotNull),
    (item) => item.timestamp,
  );
});

/**
 * One run's recorded output files by round, from the session's fold: a
 * workflow run's documents, or a tool-use run's outputs. Hosts hand it to
 * latexdiff orchestration, whose run-discovery port it satisfies.
 */
export function runOutputReader(session: SessionHandle): {
  readonly readRunOutputs: (
    runId: RunId,
  ) => Effect.Effect<ReadonlyRoundIndexed<OutputFileInfo>, Error>;
} {
  return {
    readRunOutputs: (runId) =>
      session.readView([runId]).pipe(
        Effect.map((view) => {
          const run = view.runs.get(runId);
          if (run === undefined) return {};
          return run.category === AgentCategory.Workflow
            ? run.files
            : run.outputs;
        }),
      ),
  };
}
