/**
 * TeXRA sugar over {@link AgentTrace}, as plain functions.
 *
 * Every helper takes the trace as its first argument and reduces to a
 * single primitive call (`info` / `warn` / `error` / `domain` / `emit` /
 * `contextState`). Agent code uses these instead of the bigger
 * `error(msg, { data: buildErrorLogData(...), messageType })` blocks so
 * call sites stay 1 line.
 *
 * Subscribers continue to receive the same events they did when these
 * lived as methods on `TexraTrace` — `TexraTranscriptRecorder` maps
 * every domain `key` here onto a TeXRA `MessageType`, and `level=error`
 * with `messageType: ERROR` renders the same way it always did.
 */
import { buildErrorLogData } from '@common/errors/sdkError/providerErrorFormat';
import {
  MESSAGE_TYPES,
  type CompactionActivityData,
  type CompactionActivityOutcome,
  type ContextManagementData,
  type ConversationProgress,
  type ErrorContext,
  type FileListEntry,
  type MediaAttachmentKind,
  type WorkflowScriptDeliverySummary,
} from '@shared/schemas';
import { generateShortId } from '@utils/core';

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
  logErrorData(trace, message, buildErrorLogData(err, context), stageId);
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

const COMPACTION_ACTIVITY_LOG_TEXT: Record<
  CompactionActivityData['state'],
  string
> = {
  started: 'Compacting conversation context',
  completed: 'Conversation context compaction completed',
  failed: 'Conversation context compaction failed',
  cancelled: 'Conversation context compaction cancelled',
  skipped: 'Conversation context compaction skipped',
};

export interface CompactionActivityOperation {
  readonly operationId: string;
  /** Emit the first terminal result; later calls are no-ops. */
  finish(outcome: CompactionActivityOutcome): void;
}

/** Start one idempotently-terminalized context-compaction operation. */
export function startCompactionActivity(
  trace: AgentTrace,
): CompactionActivityOperation {
  const operationId = `compaction-${generateShortId()}`;
  let finished = false;
  const emit = (state: CompactionActivityData['state']): void => {
    trace.info(COMPACTION_ACTIVITY_LOG_TEXT[state], {
      messageType: MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY,
      data: {
        activity: 'context_compaction',
        operationId,
        state,
      } satisfies CompactionActivityData,
    });
  };

  emit('started');
  return {
    operationId,
    finish: (outcome) => {
      if (finished) return;
      finished = true;
      emit(outcome);
    },
  };
}

/**
 * Echo a user instruction back into the transcript at the run boundary.
 * `attachments` records each attached media file's kind (not bytes) so the
 * archived conversation can render `[image attachment]` / `[document
 * attachment]` markers for media that only ever reached the provider
 * message (#7508). `workflowSummary` carries a workflow delivery's typed
 * presentation facts beside the row text (`UserMessagePayloadSchema`), so
 * renderers never re-parse them out of the text.
 */
export function logUserMessage(
  trace: AgentTrace,
  message: string,
  attachments?: readonly MediaAttachmentKind[],
  workflowSummary?: WorkflowScriptDeliverySummary,
): void {
  const data = {
    ...(attachments?.length ? { attachments } : {}),
    ...(workflowSummary ? { workflowSummary } : {}),
  };
  trace.info(message, {
    messageType: MESSAGE_TYPES.USER_MESSAGE,
    ...(Object.keys(data).length > 0 ? { data } : {}),
  });
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

/**
 * Report conversation-progress counters (tool-call count).
 * The retained `updateConversationProgress` host event is projected from this
 * run fact by the session progress projector instead of flow code calling
 * `session.interactions.emit` directly.
 * Never rendered as a transcript row (suppressed in `TexraTranscriptRecorder`)
 * — it is a UI-only signal, not a log line. Round labels come from typed
 * `stage.start` metadata with `kind: "round"`.
 */
export function logConversationProgress(
  trace: AgentTrace,
  data: ConversationProgress,
  stageId?: string,
): void {
  trace.emit({ type: 'conversation.progress', progress: data, stageId });
}
