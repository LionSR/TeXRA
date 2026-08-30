import {
  sumUsageStats,
  type CompileFailure,
  type OutputFileInfo,
  type Plan,
  type ReadonlyRoundIndexed,
  type StreamTabId,
  type TodoItem,
  type TokenUsageStats,
} from '@shared/schemas';
import type { StreamSnapshotStore } from '@transcript';

/**
 * The store surface needed to preload and read the accumulated
 * round-artifact/usage projection. No host-neutral module imports this: the
 * progress-view renderer reads the store directly
 * (`state.snapshots.getOutputFiles`/`getRunUsage`), and the progress-view
 * controllers reach `getOutputFiles`/`preload` through their own narrower
 * `StreamOutputsSource` port. So this is CLI presentation, not shared state.
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
  readonly outputFilesByRound: ReadonlyRoundIndexed<OutputFileInfo>;
  readonly missingOutputsByRound: ReadonlyRoundIndexed<string>;
  readonly compileFailuresByRound: ReadonlyRoundIndexed<CompileFailure>;
  readonly cumulativeUsage: TokenUsageStats | undefined;
  readonly todos: readonly TodoItem[];
  readonly plan: Plan | null;
}

/**
 * Read the artifact/usage fields the TUI renderers present. The store has
 * already ordered the disk seed against live facts, so this is a pure
 * projection — no host-side merge.
 *
 * Five of the six fields are now straight reads of the store's live readonly
 * views (#11402), so they cost nothing. `cumulativeUsage` is the one that does
 * real work — a map spread plus `sumUsageStats` — which is why callers go
 * through `readStreamArtifacts`'s per-revision memo rather than calling this on
 * every repaint.
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
