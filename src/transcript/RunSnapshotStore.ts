/** Stream display state, folded from the root's committed event table. */
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
    throw new Error('A stream-state read must begin with its creation row.');
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
          const stream = target.id;
          const current = this.records.get(stream);
          if (event.type === 'run.start') {
            if (!current || event.commit > current.startCommit) {
              this.records.set(stream, initialRecord(event));
            }
          } else if (current) {
            apply(current, event);
          }
          // An unopened historical stream is read as a complete prefix on preload.
        }),
      );
  }

  private current(stream: RunId): RunSnapshotRecord | undefined {
    const record = this.records.get(stream);
    return record?.removed ? undefined : record;
  }

  private readRecord(stream: RunId) {
    return this.database
      .readAggregate(aggregateId('run', stream), 0)
      .pipe(Effect.map(fold));
  }

  read(stream: RunId) {
    return this.gate.withPermit(
      this.readRecord(stream).pipe(
        Effect.map((record) =>
          record && !record.removed
            ? structuredClone(record.snapshot)
            : RunSnapshotSchema.parse({ runId: stream }),
        ),
      ),
    );
  }

  preload(runs: readonly RunId[]) {
    return this.gate.withPermit(
      Effect.forEach(
        runs,
        (stream) =>
          this.readRecord(stream).pipe(
            Effect.map((record) => {
              if (record) this.records.set(stream, record);
              else this.records.delete(stream);
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
        for (const stream of this.records.keys()) {
          if (!keep.has(stream)) this.records.delete(stream);
        }
        for (const stream of runs) {
          const record = yield* this.readRecord(stream);
          if (record) this.records.set(stream, record);
          else this.records.delete(stream);
        }
      }),
    );
  }

  requestEviction(stream: RunId, shouldStillEvict?: () => boolean) {
    return this.gate.withPermit(
      Effect.sync(() => {
        if (shouldStillEvict?.() !== false) this.records.delete(stream);
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

  getOutputFiles(stream: RunId): ReadonlyRoundIndexed<OutputFileInfo> {
    return this.current(stream)?.snapshot.outputFilesByRound ?? {};
  }

  getMissingOutputs(stream: RunId): ReadonlyRoundIndexed<string> {
    return this.current(stream)?.snapshot.missingOutputsByRound ?? {};
  }

  getCompileFailures(
    stream: RunId,
  ): ReadonlyRoundIndexed<CompileFailure> {
    return this.current(stream)?.snapshot.compileFailuresByRound ?? {};
  }

  getRunUsage(stream: RunId): ReadonlyMap<string, TokenUsageStats> {
    return new Map(
      Object.entries(this.current(stream)?.snapshot.runUsage ?? {}),
    );
  }

  getKnownFilePaths(
    stream: RunId,
    options: { workspaceOnly?: boolean } = {},
  ): Set<string> {
    return new Set(
      Object.values(this.getOutputFiles(stream)).flatMap((files) =>
        files
          .filter(
            (file) =>
              !options.workspaceOnly || file.location.kind === 'workspace',
          )
          .map((file) => file.location.absolutePath),
      ),
    );
  }

  getWorkPlan(stream: RunId): WorkPlanSnapshot {
    const snapshot = this.current(stream)?.snapshot;
    return {
      todos: snapshot?.todos ?? [],
      plan: snapshot?.plan ?? null,
      planSummary: snapshot?.planSummary ?? null,
    };
  }

  getRunMetadata(stream: RunId): RunMetadata {
    return this.current(stream)?.metadata ?? {};
  }

  hasProvenance(stream: RunId): boolean {
    return this.current(stream) !== undefined;
  }

  getParentRunId(stream: RunId): RunId | undefined {
    return this.current(stream)?.snapshot.parentRunId;
  }
}
