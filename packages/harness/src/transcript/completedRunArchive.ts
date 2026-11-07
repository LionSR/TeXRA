/** Completed-run display reads, keyed by run id. */
import { Effect, Predicate, Result, Schema, absurd } from 'effect';
import type { ExportNode } from '@agent/export/schemas';
import { formatToolResultAsText } from '@agent/runtime/run/toolResultText';
import { stringifyConversationValue } from '@agent/storage/conversationFormat';

import { Settings, type ConfigProvider } from '@shared/config/settings';
import {
  TOOL_CALL_STATUS,
  ToolResultSchema,
  type RunId,
  type ToolUseLog,
} from '@shared/schemas';
import { SessionLog } from '@shared/session/runHistory';
import type { TranscriptView } from '@shared/session/sessionView';
import { buildRunTranscript } from '@shared/session/transcriptUpdate';
import { DEBUG_MODE_SETTING } from '@shared/state/stateSettings';

// ============================================================================
// Conversation
// ============================================================================

/** The result a call the run's end cut short (`ToolRow.cutByRunEnd`)
 *  reads with, for a model reading the run through `executions` and for an
 *  export: nothing records how the call ended. */
const CUT_BY_RUN_END_RESULT = 'The task ended before this tool completed.';

/**
 * A call's `tool-result` node, when it has a result: the text the model read
 * and the structured `value` the call recorded, if any. Deliberate non-goal
 * (#7508): image blocks inside a tool result are not reconstructed here.
 * `ToolUseLog.output` carries either historical display text or the
 * attachment-stripped `ToolResult` fields; attachment bytes never reach the
 * transcript row.
 */
function toolResultNodes(tool: ToolUseLog): ExportNode[] {
  const node = (text: string): ExportNode[] => [{ kind: 'tool-result', text }];
  if (tool.error !== undefined) return node(tool.error);
  if (typeof tool.output === 'string') return node(tool.output);
  if (Predicate.isObject(tool.output)) {
    const result = Schema.decodeUnknownResult(ToolResultSchema)({
      ...tool.output,
      status: tool.status === TOOL_CALL_STATUS.FAILED ? 'error' : 'executed',
    });
    if (Result.isSuccess(result)) {
      const decoded = result.success;
      return [
        {
          kind: 'tool-result',
          text: formatToolResultAsText(decoded),
          ...(decoded.status === 'executed' &&
            decoded.value !== undefined && { value: decoded.value }),
        },
      ];
    }
  }
  if (tool.output !== undefined)
    return node(stringifyConversationValue(tool.output));
  return tool.summary === undefined ? [] : node(tool.summary);
}

/**
 * Map one transcript row to conversation nodes. Exhaustive over the row
 * kinds: the transcript is the single completed-run record, so every kind
 * must carry an explicit map-or-skip decision here; adding a new kind without
 * deciding fails to compile (`absurd`), instead of silently dropping
 * conversation content.
 */
function conversationNodesForRow(
  row: TranscriptView['rows'][number],
): ExportNode[] {
  switch (row.kind) {
    // ── Conversation content ────────────────────────────────────────────
    // A user row may carry an attachment-kind list (#7508): media that was
    // sent to the model but only ever lived in the provider message. Each
    // kind becomes an attachment part (no bytes) after the text.
    case 'user':
      return row.text.full
        ? [
            {
              kind: 'user-message',
              parts: [
                { type: 'text', text: row.text.full },
                ...(row.attachments ?? []).map((attachmentType) => ({
                  type: 'attachment' as const,
                  attachmentType,
                })),
              ],
            },
          ]
        : [];
    case 'assistant':
      return [{ kind: 'assistant-text', text: row.text.full }];
    case 'thinking':
      return [{ kind: 'thinking', text: row.text.full }];
    case 'tool':
      return [
        {
          kind: 'tool-call',
          name: row.log.toolName ?? 'unknown',
          input: row.log.input ?? {},
        },
        ...(row.cutByRunEnd === true
          ? [{ kind: 'tool-result' as const, text: CUT_BY_RUN_END_RESULT }]
          : toolResultNodes(row.log)),
      ];
    case 'webSearch':
      return row.query ? [{ kind: 'web-search', query: row.query }] : [];
    // ── Deliberately skipped: not conversation content ──────────────────
    // scratchpad is a derived view carved from the model response's raw
    // text (already mapped above); the rest are run diagnostics and status
    // rows, not conversation content.
    case 'scratchpad':
    case 'error':
    case 'fileList':
    case 'contextManagement':
    case 'progressStatus':
    case 'compactionActivity':
    case 'log':
      return [];
    default:
      return absurd(row);
  }
}

/**
 * Read a completed run's conversation from the canonical transcript fold as
 * the typed nodes every conversation view (chat export, the ExecutionsTool
 * endpoint, the CLI history views) renders. Empty when the transcript holds
 * no conversation.
 */
export const readCompletedRunConversation = Effect.fn(
  'readCompletedRunConversation',
)(function* (
  runId: RunId,
  config: ConfigProvider,
): Effect.fn.Return<ExportNode[], Error, SessionLog> {
  // The transcript is built cold from the run's committed rows by the same
  // reducer the session view runs, at the verbosity the session's config
  // reads now; empty when the run never existed or was removed.
  const transcript = buildRunTranscript(
    yield* (yield* SessionLog).display(runId),
    Settings.getConfig(config, DEBUG_MODE_SETTING),
  );
  return transcript.rows.flatMap(conversationNodesForRow);
});
