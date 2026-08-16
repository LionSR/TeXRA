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
  ephemeralTranscriptWarning,
  StreamDeletionSupersededError,
  StreamLogStore,
  STREAM_LOGS_DIR,
  STREAM_LOG_SUMMARIES_DIR,
} from './StreamLogStore';
export {
  StreamLog,
  StreamLogDeltaBuffer,
  type StreamLogAppendInput,
  type StreamLogDelta,
} from './StreamLog';
export { createRunTrace, type RunTrace } from './runTrace';
export { streamDataDir } from './streamDataPaths';
export { StreamSnapshotStore } from './StreamSnapshotStore';
export { assembleTrace, type AssembleTraceResult } from './traceAssembler';
export type { TraceDocument } from './traceDocumentSchema';
export {
  hasCompletedRunConversationEvidence,
  readCompletedRunConversation,
  readCompletedRunTodos,
} from './completedRunArchive';
export { injectStandaloneTrace } from './standaloneTraceHtml';
