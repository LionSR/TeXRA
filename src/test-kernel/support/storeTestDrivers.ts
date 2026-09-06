import type { AgentEvent } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  aggregateId as qualifyAggregateId,
  type CompileFailure,
  type ExecutionId,
  type ExtendedTokenUsageStats,
  type OutputFileInfo,
  type Plan,
  type RoundIndexed,
  type RunIdentity,
  type StreamLogEntry,
  type StreamTabId,
  type TodoItem,
} from '@shared/schemas';
import type { StreamSnapshotStore } from '@transcript';
import type { StreamLogAppendInput } from '@transcript/StreamLog';
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
 * mutation entry point: the session-event projection `attachSessionEvents`
 * returns, called with the durable arm of each fact.
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
    storageKey: ExecutionId,
    usage: ExtendedTokenUsageStats,
  ): void;
  setDescription(stream: StreamTabId, description: string): void;
  setParentStream(child: StreamTabId, parent: StreamTabId | null): void;
}

/** Attach `store`'s projection and return fact-emitting drivers for it. */
export function snapshotFacts(store: StreamSnapshotStore): SnapshotProjection {
  const project = store.attachSessionEvents();
  // As `SessionHandle.publish` does: a projection the store rejects is logged
  // there and the fact still lands; these suites assert what the store kept.
  const apply: typeof project = (event) => {
    try {
      project(event);
    } catch {
      // The store's own validation refused the patch; nothing was mutated.
    }
  };
  return {
    setRunStart: ({ streamId, executionId, identity }) => {
      apply({
        type: 'run.start',
        aggregateId: qualifyAggregateId('stream', streamId),
        executionId,
        identity,
        category: 'toolUse',
        isRemote: false,
        userFollowUpSupport: 'unsupported',
      });
    },
    setRunConfig: (streamId, config, executionId) => {
      apply({
        type: 'run.config',
        aggregateId: qualifyAggregateId('stream', streamId),
        executionId,
        config,
      });
    },
    setTodos: (streamId, todos) => {
      apply({
        type: 'updateTodos',
        aggregateId: qualifyAggregateId('stream', streamId),
        todos,
      });
    },
    setPlan: (streamId, plan) => {
      apply({
        type: 'updatePlan',
        aggregateId: qualifyAggregateId('stream', streamId),
        plan,
      });
    },
    addOutputFiles: (streamId, filesByRound) => {
      apply({
        type: 'addOutputFiles',
        aggregateId: qualifyAggregateId('stream', streamId),
        filesByRound,
      });
    },
    updateMissingOutputs: (streamId, filesByRound) => {
      apply({
        type: 'updateMissingOutputs',
        aggregateId: qualifyAggregateId('stream', streamId),
        filesByRound,
      });
    },
    updateCompileFailures: (streamId, filesByRound) => {
      apply({
        type: 'updateCompileFailures',
        aggregateId: qualifyAggregateId('stream', streamId),
        filesByRound,
      });
    },
    addUsage: (streamId, storageKey, usage) => {
      apply({
        type: 'usage',
        aggregateId: qualifyAggregateId('stream', streamId),
        storageKey,
        usage,
      });
    },
    setDescription: (streamId, description) => {
      apply({
        type: 'updateStreamDescription',
        aggregateId: qualifyAggregateId('stream', streamId),
        description,
      });
    },
    setParentStream: (child, parent) => {
      apply({
        type: 'setParentStream',
        aggregateId: qualifyAggregateId('stream', child),
        parentStreamId: parent,
      });
    },
  };
}
