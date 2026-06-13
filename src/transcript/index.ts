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
  getDefaultStreamLogStore,
  setDefaultStreamLogStore,
  StreamLogStore,
  STREAM_LOGS_DIR,
  STREAM_LOG_SUMMARIES_DIR,
} from './StreamLogStore';
export {
  StreamLog,
  type StreamLogAppendInput,
  type StreamLogUpdatePatch,
} from './StreamLog';
export { type TranscriptRecorderHandle } from './TexraTranscriptRecorder';
export {
  createRunTrace,
  flushPendingRunTraces,
  getActiveFlushers,
  type RunTrace,
} from './runTrace';
export { streamDataDir, type StreamDataKey } from './streamDataPaths';
export { StreamSnapshotStore } from './StreamSnapshotStore';
