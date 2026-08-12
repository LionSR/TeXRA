import type { AgentEvent } from '@agent/trace';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type {
  CompileFailure,
  ExecutionId,
  ExtendedTokenUsageStats,
  OutputFileInfo,
  Plan,
  RoundIndexed,
  RunIdentity,
  StorageKey,
  StreamLogEntry,
  StreamTabId,
  TodoItem,
} from '@shared/schemas';
import type { StreamSnapshotStore, StreamLogAppendInput } from '@transcript';
import type {
  StreamLogStore,
  TranscriptWriter,
} from '@transcript/StreamLogStore';

/**
 * Run `mutate` under a short-lived {@link TranscriptWriter} — the public
 * transcript mutation path (#9590 Stage 5: row mutation is writer-only).
 * Acquires and closes the writer around the callback so tests keep their
 * previous call-site shape without holding writer ownership across steps.
 */
export function withTranscriptWriter<T>(
  store: StreamLogStore,
  streamId: StreamTabId,
  mutate: (writer: TranscriptWriter) => T,
): T {
  const writer = store.acquireWriter(streamId, `test-writer:${streamId}`);
  try {
    return mutate(writer);
  } finally {
    writer.close();
  }
}

/** Append one transcript row through the writer path. */
export function appendTranscriptEntry(
  store: StreamLogStore,
  streamId: StreamTabId,
  entry: StreamLogAppendInput,
): StreamLogEntry {
  return withTranscriptWriter(store, streamId, (writer) =>
    writer.append(entry),
  );
}

/** Patch one transcript row through the writer path. */
export function updateTranscriptEntry(
  store: StreamLogStore,
  streamId: StreamTabId,
  id: string,
  patch: Parameters<TranscriptWriter['update']>[1],
): StreamLogEntry | undefined {
  return withTranscriptWriter(store, streamId, (writer) =>
    writer.update(id, patch),
  );
}

/** Append streaming text to one transcript row through the writer path. */
export function appendTranscriptText(
  store: StreamLogStore,
  streamId: StreamTabId,
  id: string,
  text: string,
): StreamLogEntry | undefined {
  return withTranscriptWriter(store, streamId, (writer) =>
    writer.appendText(id, text),
  );
}

/**
 * Snapshot-store test driver that mirrors the pre-Stage-5 projection mutator
 * signatures but delivers every mutation through the store's one public
 * mutation entry point: session/run facts emitted on an attached
 * {@link SessionEventHub}.
 */
export interface SnapshotProjection {
  setRunStart(run: {
    streamId: StreamTabId;
    executionId: ExecutionId;
    identity: RunIdentity;
  }): void;
  setRunConfig(
    stream: StreamTabId,
    config: AgentConfig,
    executionId: ExecutionId,
  ): void;
  setTodos(stream: StreamTabId, todos: TodoItem[]): void;
  setPlan(stream: StreamTabId, plan: Plan | null): void;
  addOutputFiles(
    stream: StreamTabId,
    filesByRound: RoundIndexed<OutputFileInfo>,
  ): void;
  updateMissingOutputs(
    stream: StreamTabId,
    filesByRound: RoundIndexed<string>,
  ): void;
  updateCompileFailures(
    stream: StreamTabId,
    filesByRound: RoundIndexed<CompileFailure>,
  ): void;
  addUsage(
    stream: StreamTabId,
    storageKey: StorageKey,
    usage: ExtendedTokenUsageStats,
  ): void;
  clearMissingOutputs(stream: StreamTabId): void;
  setDescription(stream: StreamTabId, description: string): void;
  setParentStream(child: StreamTabId, parent: StreamTabId | null): void;
}

/** Attach a fresh hub to `store` and return fact-emitting drivers for it. */
export function snapshotFacts(store: StreamSnapshotStore): SnapshotProjection {
  const events = new SessionEventHub();
  store.attachSessionEvents(events);
  const emitRun = (streamId: StreamTabId, event: AgentEvent): void => {
    events.emit({ scope: 'run', streamId, event });
  };
  return {
    setRunStart: ({ streamId, executionId, identity }) => {
      emitRun(streamId, { type: 'run.start', streamId, executionId, identity });
    },
    setRunConfig: (streamId, config, executionId) => {
      emitRun(streamId, { type: 'run.config', streamId, executionId, config });
    },
    setTodos: (streamId, todos) => {
      emitRun(streamId, { type: 'updateTodos', streamId, todos });
    },
    setPlan: (streamId, plan) => {
      emitRun(streamId, { type: 'updatePlan', streamId, plan });
    },
    addOutputFiles: (streamId, filesByRound) => {
      emitRun(streamId, { type: 'addOutputFiles', streamId, filesByRound });
    },
    updateMissingOutputs: (streamId, filesByRound) => {
      emitRun(streamId, {
        type: 'updateMissingOutputs',
        streamId,
        filesByRound,
      });
    },
    updateCompileFailures: (streamId, filesByRound) => {
      emitRun(streamId, {
        type: 'updateCompileFailures',
        streamId,
        filesByRound,
      });
    },
    addUsage: (streamId, storageKey, usage) => {
      emitRun(streamId, {
        type: 'usage',
        payload: { streamId, storageKey, usage },
      });
    },
    clearMissingOutputs: (streamId) => {
      events.emit({
        scope: 'session',
        event: { type: 'clearMissingOutputs', payload: { streamId } },
      });
    },
    setDescription: (streamId, description) => {
      events.emit({
        scope: 'session',
        event: {
          type: 'updateStreamDescription',
          payload: { streamId, description },
        },
      });
    },
    setParentStream: (child, parent) => {
      events.emit({
        scope: 'session',
        event: {
          type: 'setParentStream',
          payload: { childStreamId: child, parentStreamId: parent },
        },
      });
    },
  };
}
