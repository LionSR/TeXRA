/** Completed-run display reads, keyed by run id. */
import { Effect } from 'effect';
import type { ExportNode } from '@agent/export/schemas';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { formatToolResultAsText } from '@agent/runtime/run/toolResultText';
import { stringifyConversationValue } from '@agent/storage/conversationFormat';

import {
  TOOL_CALL_STATUS,
  ToolResultSchema,
  type RunId,
  type ToolUseLog,
} from '@shared/schemas';
import type { TranscriptView } from '@shared/session/sessionView';
import { assertNever, isObject } from '@utils/core';
import { readRunTranscript } from './runTranscript';

// ============================================================================
// Conversation
// ============================================================================

type CompletedRunConversationSource = 'streamLog' | 'none';

export interface CompletedRunConversationReadResult {
  /** Typed conversation nodes, or `null` when the transcript holds no
   *  conversation data. */
  readonly conversation: ExportNode[] | null;
  readonly source: CompletedRunConversationSource;
}

/** Whether completed-run storage proves a conversation or transcript association exists. */
export function hasCompletedRunConversationEvidence(
  result: CompletedRunConversationReadResult,
): boolean {
  return (result.conversation?.length ?? 0) > 0;
}

/**
 * Deliberate non-goal (#7508): image blocks inside a tool result are not
 * reconstructed here. `ToolUseLog.output` carries either historical display
 * text or the attachment-stripped `ToolResult` fields; attachment bytes never
 * reach the transcript row, and the `tool-result` node is `{text}` only.
 */
function toolResultText(tool: ToolUseLog): string | undefined {
  if (tool.error !== undefined) return tool.error;
  if (typeof tool.output === 'string') return tool.output;
  if (isObject(tool.output)) {
    const result = ToolResultSchema.safeParse({
      ...tool.output,
      status: tool.status === TOOL_CALL_STATUS.FAILED ? 'error' : 'executed',
    });
    if (result.success) return formatToolResultAsText(result.data);
  }
  if (tool.output !== undefined) return stringifyConversationValue(tool.output);
  return tool.summary;
}

/**
 * Map one transcript row to conversation nodes. Exhaustive over the row
 * kinds: the transcript is the single completed-run record, so every kind
 * must carry an explicit map-or-skip decision here; adding a new kind without
 * deciding fails to compile (`assertNever`), instead of silently dropping
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
    case 'tool': {
      const text = toolResultText(row.log);
      return [
        {
          kind: 'tool-call',
          name: row.log.toolName ?? 'unknown',
          input: row.log.input ?? {},
        },
        ...(text !== undefined ? [{ kind: 'tool-result' as const, text }] : []),
      ];
    }
    case 'webSearch':
      return row.query ? [{ kind: 'web-search', query: row.query }] : [];
    // ── Deliberately skipped: not conversation content ──────────────────
    // scratchpad is a derived view carved from the model response's raw
    // text (already mapped above); the rest are run diagnostics and status
    // rows, not conversation content.
    case 'scratchpad':
    case 'error':
    case 'fileList':
    case 'missingOutputs':
    case 'latexdiff':
    case 'statistics':
    case 'contextManagement':
    case 'progressStatus':
    case 'workflowTask':
    case 'compactionActivity':
    case 'phase':
    case 'log':
      return [];
    default:
      return assertNever(row, 'Unmapped transcript row kind');
  }
}

/**
 * Read a completed run's conversation from the canonical transcript fold as
 * the typed nodes every conversation view (chat export, the ExecutionsTool
 * endpoint, the CLI history views) renders.
 */
export const readCompletedRunConversation = Effect.fn(
  'readCompletedRunConversation',
)(function* (
  runId: RunId,
  session: SessionHandle,
): Effect.fn.Return<CompletedRunConversationReadResult, Error> {
  const conversation = (yield* readRunTranscript(session, runId)).rows.flatMap(
    conversationNodesForRow,
  );
  return conversation.length > 0
    ? { conversation, source: 'streamLog' }
    : { conversation: null, source: 'none' };
});
