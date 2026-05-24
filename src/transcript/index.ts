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
} from './StreamLogStore';
export {
  StreamLog,
  isRunningGroupEntry,
  type StreamLogAppendInput,
  type StreamLogUpdatePatch,
} from './StreamLog';
export {
  attachTranscriptRecorder,
  type TranscriptRecorderHandle,
} from './TexraTranscriptRecorder';
