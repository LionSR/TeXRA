/**
 * TeXRA sugar over {@link AgentTrace}, as plain functions.
 *
 * Every helper takes the trace as its first argument and reduces to a
 * single primitive call (`info` / `warn` / `error` / `domain` /
 * `contextState`). Agent code uses these instead of the bigger
 * `error(msg, { data: buildErrorLogData(...), messageType })` blocks so
 * call sites stay 1 line.
 *
 * Subscribers continue to receive the same events they did when these
 * lived as methods on `TexraTrace` — `TexraTranscriptRecorder` maps
 * every domain `key` here onto a TeXRA `MessageType`, and `level=error`
 * with `messageType: ERROR` renders the same way it always did.
 */
import { buildErrorLogData } from '@common/errors/sdkErrorUtils';
import {
  MESSAGE_TYPES,
  type ContextManagementData,
  type ErrorContext,
  type FileListEntry,
} from '@shared/schemas';

import type { AgentTrace } from './AgentTrace';

// ─── Error / progress / internal ────────────────────────────────────────

/** Serialize an error + context and emit it as a structured error log. */
export function logSdkError(
  trace: AgentTrace,
  message: string,
  err: unknown,
  context?: ErrorContext,
  stageId?: string,
): void {
  trace.error(message, {
    messageType: MESSAGE_TYPES.ERROR,
    data: buildErrorLogData(err, context),
    stageId,
  });
}

/** Emit an error log with a pre-serialized data payload. */
export function logErrorData(
  trace: AgentTrace,
  message: string,
  data: unknown,
  stageId?: string,
): void {
  trace.error(message, {
    messageType: MESSAGE_TYPES.ERROR,
    data,
    stageId,
  });
}

/** Emit a user-visible progress/status note. */
export function logProgressStatus(
  trace: AgentTrace,
  message: string,
  data?: unknown,
  stageId?: string,
): void {
  trace.info(message, {
    messageType: MESSAGE_TYPES.PROGRESS_STATUS,
    data,
    stageId,
  });
}

/** Echo a user instruction back into the transcript at the run boundary. */
export function logUserMessage(trace: AgentTrace, message: string): void {
  trace.info(message, { messageType: MESSAGE_TYPES.USER_MESSAGE });
}

/** Internal-only info line; subscribers suppress it from non-debug views. */
export function logInternal(
  trace: AgentTrace,
  message: string,
  stageId?: string,
): void {
  trace.info(message, { messageType: MESSAGE_TYPES.INTERNAL, stageId });
}

/** Internal-only debug line. */
export function debugInternal(
  trace: AgentTrace,
  message: string,
  stageId?: string,
): void {
  trace.debug(message, { messageType: MESSAGE_TYPES.INTERNAL, stageId });
}

// ─── Domain events ──────────────────────────────────────────────────────

export function logScratchpad(
  trace: AgentTrace,
  content: string,
  stageId?: string,
): void {
  trace.domain({ key: 'scratchpad', text: content, stageId });
}

export function logContextManagementEvent(
  trace: AgentTrace,
  text: string,
  data?: ContextManagementData,
  stageId?: string,
): void {
  trace.domain({ key: 'contextManagement', text, data, stageId });
}

export function logWebSearch(
  trace: AgentTrace,
  data: unknown,
  stageId?: string,
): void {
  trace.domain({ key: 'webSearch', data, stageId });
}

export function logWebFetch(
  trace: AgentTrace,
  data: unknown,
  stageId?: string,
): void {
  trace.domain({ key: 'webFetch', data, stageId });
}

export function logLatexdiff(
  trace: AgentTrace,
  results: unknown[],
  stageId?: string,
): void {
  trace.domain({
    key: 'latexdiff',
    text: `Latexdiff results: ${results.length}`,
    data: results,
    stageId,
  });
}

/** Files-loaded card with full {@link FileListEntry} entries. */
export function logFilesLoaded(
  trace: AgentTrace,
  category: string,
  entries: readonly FileListEntry[],
  stageId?: string,
): void {
  trace.domain({
    key: 'filesLoaded',
    data: { category, entries },
    text: category,
    stageId,
  });
}

/**
 * Files-loaded card built from path/ok pairs — the category becomes both
 * the source label and the display label.
 */
export function logFileCategory(
  trace: AgentTrace,
  category: string,
  files: ReadonlyArray<Pick<FileListEntry, 'path'> & { ok?: boolean }>,
  stageId?: string,
): void {
  if (files.length === 0) return;
  const entries: FileListEntry[] = files.map((f) => ({
    path: f.path,
    ok: f.ok === true,
    source: category,
    sourceDisplay: category,
  }));
  logFilesLoaded(trace, category, entries, stageId);
}

/** Missing-outputs notification — counts `missing` entries for the label. */
export function logMissingOutputs(
  trace: AgentTrace,
  info: { missing?: unknown[] } & Record<string, unknown>,
  stageId?: string,
): void {
  const count = Array.isArray(info.missing) ? info.missing.length : 0;
  trace.domain({
    key: 'missingOutputs',
    text: `${count} output file${count === 1 ? '' : 's'} missing`,
    data: info,
    stageId,
  });
}

// ─── Context-state snapshot ─────────────────────────────────────────────

/** Emit a context-window utilization snapshot. */
export function logContextStateSnapshot(
  trace: AgentTrace,
  inputTokens: number,
  contextWindow: number,
  stageId?: string,
): void {
  trace.contextState(
    {
      inputTokens,
      contextWindow,
      utilizationPercent:
        contextWindow > 0 ? (inputTokens / contextWindow) * 100 : 0,
    },
    { stageId },
  );
}
