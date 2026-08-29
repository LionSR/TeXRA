import {
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type StreamLogEntry,
} from '@shared/schemas';
import { getModelLabel } from '@shared/model/modelLabel';

/**
 * Webview/browser-facing copy of one transcript entry. The stream-log store
 * keeps the canonical `WorkflowCallProgress.model` id; only the copy that
 * crosses the progress-view boundary projects it through the browser-safe
 * static label lookup (the CLI's headless workflow output does the same at its
 * write site), keeping runtime model state out of the browser import graph.
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
  const model = getModelLabel(call.model);
  if (model === call.model) return entry;
  return { ...entry, data: { ...call, model } } as StreamLogEntry;
}

/** Project every entry in a trace/stream-log range. */
export function projectWorkflowCallEntries(
  entries: readonly StreamLogEntry[],
): StreamLogEntry[] {
  return entries.map(projectWorkflowCallEntry);
}
