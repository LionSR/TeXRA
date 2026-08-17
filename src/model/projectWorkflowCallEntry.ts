import { getRuntimeModelLabel } from '@model/runtimeModelRegistry';
import {
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type StreamLogEntry,
} from '@shared/schemas';

/**
 * Webview/browser-facing copy of one transcript entry. The stream-log store
 * keeps the canonical `WorkflowCallProgress.model` id; only the copy that
 * crosses the progress-view boundary projects it through the runtime model
 * registry. This mirrors `formatCliWorkflowCallLine` while keeping
 * `@model/runtimeModelRegistry` out of the browser frontend import graph.
 *
 * Shared by the live `WebviewBridge` LOG_DELTA path and the host-side trace
 * exporters so exported/archived traces show the same runtime label as the
 * live surface (see #10178).
 */
export function projectWorkflowCallEntry(
  entry: StreamLogEntry,
): StreamLogEntry {
  if (
    entry.type !== STREAM_LOG_ENTRY_TYPES.LOG ||
    entry.messageType !== MESSAGE_TYPES.WORKFLOW_TASK
  ) {
    return entry;
  }
  const call = entry.data;
  if (!('model' in call) || call.model === undefined) return entry;
  const model = getRuntimeModelLabel(call.model);
  if (model === call.model) return entry;
  return { ...entry, data: { ...call, model } } as StreamLogEntry;
}

/** Project every entry in a trace/stream-log range. */
export function projectWorkflowCallEntries(
  entries: readonly StreamLogEntry[],
): StreamLogEntry[] {
  return entries.map(projectWorkflowCallEntry);
}
