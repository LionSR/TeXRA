/** Run display state, folded from the root's committed event table. */
import { Effect, Semaphore, type Context } from 'effect';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  aggregateId,
  aggregateTarget,
  emptyUsageStats,
  mergeRounds,
  planSummaryLine,
  RunSnapshotSchema,
  sumUsageStats,
  type CompileFailure,
  type OutputFileInfo,
  type ReadonlyRoundIndexed,
  type RunIdentity,
  type SessionEvent,
  type RunSnapshot,
  type RunId,
  type TokenUsageStats,
  type UserFollowUpSupport,
  type WorkPlanSnapshot,
} from '@shared/schemas';
import type { Database } from '@shared/session/database';

export interface RunMetadata {
  readonly identity?: RunIdentity;
  readonly userFollowUpSupport?: UserFollowUpSupport;
  readonly config?: AgentConfig;
  readonly description?: string;
}

interface RunSnapshotRecord {
  seq: number;
  startCommit: number;
  removed: boolean;
  snapshot: RunSnapshot;
  metadata: RunMetadata;
}

function initialRecord(
  event: Extract<SessionEvent, { type: 'run.start' }>,
): RunSnapshotRecord {
  const runId = aggregateTarget(event.aggregateId).id;
  return {
    seq: event.seq,
    startCommit: event.commit,
    removed: false,
    snapshot: {
      ...RunSnapshotSchema.parse({ runId }),
      parentRunId: event.parent === null ? undefined : event.parent.id,
    },
    metadata: {
      identity: event.identity ?? undefined,
      userFollowUpSupport: event.userFollowUpSupport ?? undefined,
    },
  };
}

/** Fold one committed row. Replayed prefixes cannot count usage twice. */
function apply(record: RunSnapshotRecord, event: SessionEvent): void {
  if (event.seq <= record.seq || record.removed) return;
  record.seq = event.seq;
  const snapshot = record.snapshot;
  switch (event.type) {
    case 'run.config':
      record.metadata = { ...record.metadata, config: event.config };
      break;
    case 'updateRunDescription':
      record.metadata = { ...record.metadata, description: event.description };
      break;
    case 'usage':
      snapshot.runUsage[event.runId] = sumUsageStats([
        snapshot.runUsage[event.runId] ?? emptyUsageStats(),
        event.usage,
      ]);
      break;
    case 'updateTodos':
      snapshot.todos = event.todos;
      break;
    case 'updatePlan':
      snapshot.plan = event.plan;
      snapshot.planSummary = event.plan
        ? planSummaryLine(event.plan.objective)
        : null;
      break;
    case 'addOutputFiles':
      snapshot.outputFilesByRound = mergeRounds(
        snapshot.outputFilesByRound,
        event.filesByRound,
        'drop',
      );
      break;
    case 'updateMissingOutputs':
      snapshot.missingOutputsByRound = mergeRounds(
        snapshot.missingOutputsByRound,
        event.filesByRound,
        'keep',
      );
      break;
    case 'updateCompileFailures':
      snapshot.compileFailuresByRound = mergeRounds(
        snapshot.compileFailuresByRound,
        event.filesByRound,
        'drop',
      );
      break;
    case 'run.detach':
      snapshot.parentRunId = undefined;
      break;
    case 'run.removed':
      record.removed = true;
      break;
  }
}

function fold(events: readonly SessionEvent[]): RunSnapshotRecord | undefined {
  const first = events[0];
  if (first === undefined) return undefined;
  if (first.type !== 'run.start' || first.seq !== 1) {
    throw new Error('A run-state read must begin with its creation row.');
  }
  const record = initialRecord(first);
  for (const event of events) apply(record, event);
  return record;
}

/**
 * The root supplies its one database. The permit owns cold hydration and
 * committed-tail application together, so a read cannot overwrite a newer
 * live fold. There are no files, write queues, overlays or staged directories.
 */
export class RunSnapshotStore {
  private readonly records = new Map<RunId, RunSnapshotRecord>();
  private readonly gate = Semaphore.makeUnsafe(1);

  constructor(
    private readonly database: Pick<
      Context.Service.Shape<typeof Database>,
      'readAggregate' | 'readListing'
    >,
  ) {}

  attachSessionEvents(): (event: SessionEvent) => Effect.Effect<void> {
    return (event) =>
      this.gate.withPermit(
        Effect.sync(() => {
          const target = aggregateTarget(event.aggregateId);
          if (target.kind !== 'run') return;
          const run = target.id;
          const current = this.records.get(run);
          if (event.type === 'run.start') {
            if (!current || event.commit > current.startCommit) {
              this.records.set(run, initialRecord(event));
            }
          } else if (current) {
            apply(current, event);
          }
          // An unopened historical run is read as a complete prefix on preload.
        }),
      );
  }

  private current(run: RunId): RunSnapshotRecord | undefined {
    const record = this.records.get(run);
    return record?.removed ? undefined : record;
  }

  private readRecord(run: RunId) {
    return this.database
      .readAggregate(aggregateId('run', run), 0)
      .pipe(Effect.map(fold));
  }

  read(run: RunId) {
    return this.gate.withPermit(
      this.readRecord(run).pipe(
        Effect.map((record) =>
          record && !record.removed
            ? structuredClone(record.snapshot)
            : RunSnapshotSchema.parse({ runId: run }),
        ),
      ),
    );
  }

  preload(runs: readonly RunId[]) {
    return this.gate.withPermit(
      Effect.forEach(
        runs,
        (run) =>
          this.readRecord(run).pipe(
            Effect.map((record) => {
              if (record) this.records.set(run, record);
              else this.records.delete(run);
            }),
          ),
        { discard: true },
      ),
    );
  }

  load(runs: readonly RunId[]) {
    return this.gate.withPermit(
      Effect.gen({ self: this }, function* () {
        const keep = new Set(runs);
        for (const run of this.records.keys()) {
          if (!keep.has(run)) this.records.delete(run);
        }
        for (const run of runs) {
          const record = yield* this.readRecord(run);
          if (record) this.records.set(run, record);
          else this.records.delete(run);
        }
      }),
    );
  }

  requestEviction(run: RunId, shouldStillEvict?: () => boolean) {
    return this.gate.withPermit(
      Effect.sync(() => {
        if (shouldStillEvict?.() !== false) this.records.delete(run);
      }),
    );
  }

  listPersistedRuns() {
    return this.database.readListing().pipe(
      Effect.map((events) => {
        const runs = new Set<RunId>();
        for (const event of events) {
          const target = aggregateTarget(event.aggregateId);
          if (target.kind !== 'run') continue;
          if (event.type === 'run.start') runs.add(target.id);
          else if (event.type === 'run.removed') runs.delete(target.id);
        }
        return [...runs];
      }),
    );
  }

  getOutputFiles(run: RunId): ReadonlyRoundIndexed<OutputFileInfo> {
    return this.current(run)?.snapshot.outputFilesByRound ?? {};
  }

  getMissingOutputs(run: RunId): ReadonlyRoundIndexed<string> {
    return this.current(run)?.snapshot.missingOutputsByRound ?? {};
  }

  getCompileFailures(run: RunId): ReadonlyRoundIndexed<CompileFailure> {
    return this.current(run)?.snapshot.compileFailuresByRound ?? {};
  }

  getRunUsage(run: RunId): ReadonlyMap<string, TokenUsageStats> {
    return new Map(Object.entries(this.current(run)?.snapshot.runUsage ?? {}));
  }

  getKnownFilePaths(
    run: RunId,
    options: { workspaceOnly?: boolean } = {},
  ): Set<string> {
    return new Set(
      Object.values(this.getOutputFiles(run)).flatMap((files) =>
        files
          .filter(
            (file) =>
              !options.workspaceOnly || file.location.kind === 'workspace',
          )
          .map((file) => file.location.absolutePath),
      ),
    );
  }

  getWorkPlan(run: RunId): WorkPlanSnapshot {
    const snapshot = this.current(run)?.snapshot;
    return {
      todos: snapshot?.todos ?? [],
      plan: snapshot?.plan ?? null,
      planSummary: snapshot?.planSummary ?? null,
    };
  }

  getRunMetadata(run: RunId): RunMetadata {
    return this.current(run)?.metadata ?? {};
  }

  hasProvenance(run: RunId): boolean {
    return this.current(run) !== undefined;
  }

  getParentRunId(run: RunId): RunId | undefined {
    return this.current(run)?.snapshot.parentRunId;
  }
}
