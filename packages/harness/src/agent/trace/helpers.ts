/**
 * Logging sugar over {@link AgentTrace}, as plain functions.
 *
 * Every helper takes the trace as its first argument and reduces to a
 * single primitive call (`info` / `warn` / `error` / `emit`).
 * Agent code uses these instead of the bigger
 * `error(msg, { data: buildErrorLogData(...), messageType })` blocks so
 * call sites stay 1 line.
 *
 * The transcript fold renders `level=error` with `messageType: ERROR` as an
 * error row.
 */
// Third-party imports
import { Effect } from 'effect';

// Local imports
import {
  buildErrorLogData,
  normalizeProviderError,
} from '@common/errors/sdkError/providerErrorFormat';
import { withLogChannel } from '@logger/effectLog';
import {
  MESSAGE_TYPES,
  toRetryErrorInfo,
  type CompactionActivityData,
  type CompactionActivityOutcome,
  type ContextManagementData,
  type ErrorContext,
  type ErrorLogData,
  type MediaAttachmentKind,
  type ProviderError,
  type ScriptDeliverySummary,
} from '@shared/schemas';

import type { AgentTrace } from './AgentTrace';

// ─── Error / progress / internal ────────────────────────────────────────

/** Serialize an error + context and emit it as a structured error log. */
export function logSdkError(
  trace: AgentTrace,
  message: string,
  err: unknown,
  context?: ErrorContext,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    logErrorData(trace, message, buildErrorLogData(err, context));
    return logProviderBody(message, normalizeProviderError(err).rawErrorBody);
  });
}

/** Log a normalized provider failure: its body-free `RetryErrorInfo` on the
 *  stream log, its raw response body on the process log only. */
export function logProviderError(
  trace: AgentTrace,
  message: string,
  error: ProviderError,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    logErrorData(trace, message, toRetryErrorInfo(error));
    return logProviderBody(message, error.rawErrorBody);
  });
}

/** The provider's raw response body stays out of the stream log and every
 *  session row, since it can echo the request; it is a diagnostic for the
 *  process log. */
function logProviderBody(message: string, body: unknown): Effect.Effect<void> {
  return body === undefined
    ? Effect.void
    : Effect.logWarning(`${message} (provider response body)`).pipe(
        Effect.annotateLogs({ data: body }),
        withLogChannel('agentTrace'),
      );
}

/** Emit an error log row. A `ProviderError` does not fit `data`: its raw
 *  body is rejected by the row schema, so pass its `RetryErrorInfo`. */
function logErrorData(
  trace: AgentTrace,
  message: string,
  data: ErrorLogData & { readonly rawErrorBody?: never },
): void {
  trace.error(message, { messageType: MESSAGE_TYPES.ERROR, data });
}

/**
 * Emit a user-visible progress/status note. A status note is its message
 * alone and takes no payload: the transcript stringifies a `progressStatus`
 * row's `data` verbatim into its detail, and an arbitrary payload (a request,
 * headers, config) could write a secret there.
 */
export function logProgressStatus(trace: AgentTrace, message: string): void {
  trace.info(message, { messageType: MESSAGE_TYPES.PROGRESS_STATUS });
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
  /** Emit the first terminal result; later calls are no-ops. */
  finish(outcome: CompactionActivityOutcome): void;
}

/** Start one idempotently-terminalized context-compaction operation. */
export function startCompactionActivity(
  trace: AgentTrace,
): CompactionActivityOperation {
  const operationId = `compaction-${crypto.randomUUID()}`;
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
 * message, and `mediaFiles` the files a follow-up attached, which
 * "Fork from here" carries into the fork's composer. `scriptSummary` carries
 * a workflow delivery's typed presentation facts beside the row text
 * (`UserMessagePayloadSchema`), so renderers never re-parse them out of the
 * text.
 */
export function logUserMessage(
  trace: AgentTrace,
  message: string,
  {
    attachments,
    mediaFiles,
    scriptSummary,
  }: {
    readonly attachments?: readonly MediaAttachmentKind[];
    readonly mediaFiles?: readonly string[] | null;
    readonly scriptSummary?: ScriptDeliverySummary;
  } = {},
): void {
  const data = {
    ...(attachments?.length ? { attachments } : {}),
    ...(mediaFiles?.length ? { mediaFiles } : {}),
    ...(scriptSummary ? { scriptSummary } : {}),
  };
  trace.info(message, {
    messageType: MESSAGE_TYPES.USER_MESSAGE,
    ...(Object.keys(data).length > 0 ? { data } : {}),
  });
}

// ─── Category rows ──────────────────────────────────────────────────────

/**
 * Emit a context-management event. Its producers (the output-budget clamp in
 * `ModelInvoker`, compaction in `run/compaction.ts`) build `text` and
 * `data.details` from token counts and their own labels, never from provider
 * or tool text, so no secret can reach this row; keep it that way.
 */
export function logContextManagementEvent(
  trace: AgentTrace,
  text: string,
  data?: ContextManagementData,
): void {
  trace.info(text, { messageType: MESSAGE_TYPES.CONTEXT_MANAGEMENT, data });
}
