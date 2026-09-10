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
  type RunId,
  type OutputFileInfo,
  type ReadonlyRoundIndexed,
  type RunIdentity,
  type SessionEvent,
  type RunSnapshot,
  type StreamTabId,
  type TokenUsageStats,
  type UserFollowUpSupport,
  type WorkPlanSnapshot,
} from '@shared/schemas';
import type { Database } from '@shared/session/database';

export interface RunMetadata {
  readonly executionId?: RunId;
  readonly identity?: RunIdentity;
  readonly userFollowUpSupport?: UserFollowUpSupport;
  readonly config?: AgentConfig;
  readonly description?: string;
}

interface StreamRecord {
  seq: number;
  startCommit: number;
  removed: boolean;
  snapshot: RunSnapshot;
  metadata: RunMetadata;
}

function initialRecord(
  event: Extract<SessionEvent, { type: 'run.start' }>,
): StreamRecord {
  const streamId = aggregateTarget(event.aggregateId).id;
  return {
    seq: event.seq,
    startCommit: event.commit,
    removed: false,
    snapshot: {
      ...RunSnapshotSchema.parse({ streamId }),
      executionId: event.executionId,
      parentStreamId: event.parentStreamId ?? undefined,
    },
    metadata: {
      executionId: event.executionId,
      identity: event.identity ?? undefined,
      userFollowUpSupport: event.userFollowUpSupport ?? undefined,
    },
  };
}

/** Fold one committed row. Replayed prefixes cannot count usage twice. */
function apply(record: StreamRecord, event: SessionEvent): void {
  if (event.seq <= record.seq || record.removed) return;
  record.seq = event.seq;
  const snapshot = record.snapshot;
  switch (event.type) {
    case 'run.config':
      record.metadata = { ...record.metadata, config: event.config };
      break;
    case 'updateStreamDescription':
      record.metadata = { ...record.metadata, description: event.description };
      break;
    case 'usage':
      snapshot.runUsage[event.storageKey] = sumUsageStats([
        snapshot.runUsage[event.storageKey] ?? emptyUsageStats(),
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
    case 'setParentStream':
      snapshot.parentStreamId = event.parentStreamId ?? undefined;
      break;
    case 'stream.removed':
      record.removed = true;
      break;
  }
}

function fold(events: readonly SessionEvent[]): StreamRecord | undefined {
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
  private readonly records = new Map<StreamTabId, StreamRecord>();
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
          if (target.kind !== 'stream') return;
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

  private current(stream: StreamTabId): StreamRecord | undefined {
    const record = this.records.get(stream);
    return record?.removed ? undefined : record;
  }

  private readRecord(stream: StreamTabId) {
    return this.database
      .readAggregate(aggregateId('stream', stream), 0)
      .pipe(Effect.map(fold));
  }

  read(stream: StreamTabId) {
    return this.gate.withPermit(
      this.readRecord(stream).pipe(
        Effect.map((record) =>
          record && !record.removed
            ? structuredClone(record.snapshot)
            : RunSnapshotSchema.parse({ streamId: stream }),
        ),
      ),
    );
  }

  preload(streams: readonly StreamTabId[]) {
    return this.gate.withPermit(
      Effect.forEach(
        streams,
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

  load(streams: readonly StreamTabId[]) {
    return this.gate.withPermit(
      Effect.gen({ self: this }, function* () {
        const keep = new Set(streams);
        for (const stream of this.records.keys()) {
          if (!keep.has(stream)) this.records.delete(stream);
        }
        for (const stream of streams) {
          const record = yield* this.readRecord(stream);
          if (record) this.records.set(stream, record);
          else this.records.delete(stream);
        }
      }),
    );
  }

  requestEviction(stream: StreamTabId, shouldStillEvict?: () => boolean) {
    return this.gate.withPermit(
      Effect.sync(() => {
        if (shouldStillEvict?.() !== false) this.records.delete(stream);
      }),
    );
  }

  listPersistedStreams() {
    return this.database.readListing().pipe(
      Effect.map((events) => {
        const streams = new Set<StreamTabId>();
        for (const event of events) {
          const target = aggregateTarget(event.aggregateId);
          if (target.kind !== 'stream') continue;
          if (event.type === 'run.start') streams.add(target.id);
          else if (event.type === 'stream.removed') streams.delete(target.id);
        }
        return [...streams];
      }),
    );
  }

  getOutputFiles(stream: StreamTabId): ReadonlyRoundIndexed<OutputFileInfo> {
    return this.current(stream)?.snapshot.outputFilesByRound ?? {};
  }

  getMissingOutputs(stream: StreamTabId): ReadonlyRoundIndexed<string> {
    return this.current(stream)?.snapshot.missingOutputsByRound ?? {};
  }

  getCompileFailures(
    stream: StreamTabId,
  ): ReadonlyRoundIndexed<CompileFailure> {
    return this.current(stream)?.snapshot.compileFailuresByRound ?? {};
  }

  getRunUsage(stream: StreamTabId): ReadonlyMap<string, TokenUsageStats> {
    return new Map(
      Object.entries(this.current(stream)?.snapshot.runUsage ?? {}),
    );
  }

  getKnownFilePaths(
    stream: StreamTabId,
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

  getWorkPlan(stream: StreamTabId): WorkPlanSnapshot {
    const snapshot = this.current(stream)?.snapshot;
    return {
      todos: snapshot?.todos ?? [],
      plan: snapshot?.plan ?? null,
      planSummary: snapshot?.planSummary ?? null,
    };
  }

  getRunMetadata(stream: StreamTabId): RunMetadata {
    return this.current(stream)?.metadata ?? {};
  }

  hasProvenance(stream: StreamTabId): boolean {
    return this.current(stream) !== undefined;
  }

  getParentStreamId(stream: StreamTabId): StreamTabId | undefined {
    return this.current(stream)?.snapshot.parentStreamId;
  }

  getExecutionIdMap(): ReadonlyMap<StreamTabId, RunId> {
    return new Map(
      [...this.records].flatMap(([stream, record]) =>
        !record.removed && record.metadata.executionId
          ? [[stream, record.metadata.executionId]]
          : [],
      ),
    );
  }
}
