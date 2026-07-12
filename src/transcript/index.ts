/**
 * TeXRA transcript persistence — host product layer.
 *
 * `StreamLogStore` owns the per-stream, history-browsable, in-place-streamed
 * log model that drives TeXRA's webview transcript and CLI TUI. The
 * `TexraTranscriptRecorder` subscribes to an {@link AgentTrace} and
 * translates each {@link AgentEvent} into store appends/updates.
 *
 * SDK consumers do not depend on this module — they attach their own
 * subscriber via `trace.subscribe(...)` and persist however they need.
 */
export {
  StreamLogStore,
  STREAM_LOGS_DIR,
  STREAM_LOG_SUMMARIES_DIR,
  type StreamLogStoreMode,
} from './StreamLogStore';
export { StreamLog, type StreamLogAppendInput } from './StreamLog';
export {
  createRunTrace,
  flushPendingRunTraces,
  getActiveFlushers,
  unregisterFlushers,
  type RunTrace,
} from './runTrace';
export { streamDataDir } from './streamDataPaths';
export { StreamSnapshotStore } from './StreamSnapshotStore';
export {
  assembleTrace,
  type AssembleTraceResult,
  type TraceDocument,
} from './traceAssembler';
export {
  readCompletedRunConversation,
  readCompletedRunTodos,
} from './completedRunArchive';
export { resolvePersistedStreamIdForExecution } from './executionStreamResolver';
export { injectStandaloneTrace } from './standaloneTraceHtml';
