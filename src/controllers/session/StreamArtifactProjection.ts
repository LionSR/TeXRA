import {
  sumUsageStats,
  type CompileFailure,
  type OutputFileInfo,
  type Plan,
  type RoundIndexed,
  type StreamTabId,
  type TodoItem,
  type TokenUsageStats,
} from '@shared/schemas';
import type { StreamSnapshotStore } from '@transcript';

/**
 * The store surface a host needs to preload and read the accumulated
 * round-artifact/usage projection. The CLI and the shared progress-view
 * controllers project the same fields, so the reader shape lives here rather
 * than on any one host.
 */
export type StreamArtifactReader = Pick<
  StreamSnapshotStore,
  | 'preload'
  | 'getOutputFiles'
  | 'getMissingOutputs'
  | 'getCompileFailures'
  | 'getRunUsage'
  | 'getWorkPlan'
>;

/** Canonical per-stream artifact/usage projection read from the store. */
export interface StreamArtifactProjection {
  readonly outputFilesByRound: RoundIndexed<OutputFileInfo>;
  readonly missingOutputsByRound: RoundIndexed<string>;
  readonly compileFailuresByRound: RoundIndexed<CompileFailure>;
  readonly cumulativeUsage: TokenUsageStats | undefined;
  readonly todos: readonly TodoItem[];
  readonly plan: Plan | null;
}

/**
 * Read the artifact/usage fields the TUI renderers present. The store has
 * already ordered the disk seed against live facts, so this is a pure
 * projection — no host-side merge.
 */
export function projectStreamArtifacts(
  store: StreamArtifactReader,
  streamId: StreamTabId,
): StreamArtifactProjection {
  const runUsage = [...store.getRunUsage(streamId).values()];
  const workPlan = store.getWorkPlan(streamId);
  return {
    outputFilesByRound: store.getOutputFiles(streamId),
    missingOutputsByRound: store.getMissingOutputs(streamId),
    compileFailuresByRound: store.getCompileFailures(streamId),
    cumulativeUsage: runUsage.length > 0 ? sumUsageStats(runUsage) : undefined,
    todos: workPlan.todos,
    plan: workPlan.plan,
  };
}
