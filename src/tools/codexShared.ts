// Local imports - shared schemas
import type { TokenUsageStats, ToolUseLog } from '@shared/schemas';
import {
  CODEX_FILE_CHANGE_TOOL,
  CODEX_THREAD_TOOL,
  CODEX_TODO_TOOL,
  CODEX_TURN_TOOL,
} from '@shared/schemas/codex';
import type {
  CodexFileChangeToolInput,
  CodexMcpToolOutput,
  CodexThreadToolInput,
  CodexTodoToolInput,
  CodexTurnState,
  CodexTurnToolInput,
} from '@shared/schemas/codex';
import { getBasename } from '@utils/core';
import { truncateSummary } from '@utils/text/stringUtils';
import type {
  CommandExecutionItem,
  FileChangeItem,
  McpToolCallItem,
  ThreadStartedEvent,
  TodoListItem,
  Usage,
} from '@openai/codex-sdk';

export const CODEX_AGENT_NAME = 'codex';
export const CODEX_DISPLAY_MODEL = 'gpt55';
const CODEX_COMMAND_SUMMARY_MAX_LENGTH = 60;
export type ToolUseStatus = NonNullable<ToolUseLog['status']>;

type CodexFileChange = FileChangeItem['changes'][number];
type CodexCommandToolLogOptions = Pick<
  CommandExecutionItem,
  'command' | 'aggregated_output' | 'exit_code' | 'status'
>;
/** Normalize Codex command execution events for the native bash tool card. */
export function buildCodexCommandToolLog(
  options: CodexCommandToolLogOptions,
): ToolUseLog {
  const toolStatus: ToolUseStatus =
    options.status === 'in_progress' ? 'in_progress' : 'completed';
  const command = options.command.trim();
  const exitInfo =
    options.exit_code == null
      ? options.status?.trim() || 'completed'
      : `exit ${options.exit_code}`;
  const output =
    options.aggregated_output.trimEnd() ||
    (toolStatus === 'completed' ? `(${exitInfo})` : '');
  const isError =
    options.status === 'failed' ||
    (options.exit_code != null && options.exit_code !== 0);

  return {
    toolName: 'bash',
    summary: truncateSummary(
      command || 'command',
      CODEX_COMMAND_SUMMARY_MAX_LENGTH,
    ),
    input: { command: options.command },
    ...(output && { output }),
    ...(isError && {
      error: `Command failed (${exitInfo})`,
      isError: true,
    }),
    status: toolStatus,
  };
}

/** Normalize and summarize Codex file-change events for the native tool-use UI. */
export function buildCodexFileChangeToolLog(
  item: Pick<FileChangeItem, 'changes' | 'status'>,
): ToolUseLog | null {
  const dedupedChanges: CodexFileChange[] = [];
  const seen = new Set<string>();

  for (const change of item.changes) {
    const filePath = change.path?.trim();
    const kind = change.kind;
    if (!filePath || !kind) continue;

    const key = `${kind}\u0000${filePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedChanges.push({ path: filePath, kind });
  }

  if (dedupedChanges.length === 0) {
    return null;
  }

  const summary =
    dedupedChanges.length === 1
      ? `${item.status === 'failed' ? 'failed ' : ''}${dedupedChanges[0].kind} ${getBasename(dedupedChanges[0].path)}`
      : `${dedupedChanges.length} file changes${item.status === 'failed' ? ' failed' : ''}`;

  return {
    toolName: CODEX_FILE_CHANGE_TOOL,
    summary,
    input: {
      changes: dedupedChanges,
      patchStatus: item.status,
    } satisfies CodexFileChangeToolInput,
    ...(item.status === 'failed' && {
      error: 'Patch apply failed',
      isError: true,
    }),
    status: 'completed',
  };
}

export function buildCodexMcpToolLog(item: McpToolCallItem): ToolUseLog {
  const contentBlocks = item.result?.content ?? [];
  const output: CodexMcpToolOutput = {
    status: item.status,
    ...(item.result?.structured_content !== undefined && {
      structuredContent: item.result.structured_content,
    }),
    ...(contentBlocks.length > 0 && {
      contentBlocks,
    }),
  };

  return {
    toolName: `mcp:${item.server}/${item.tool}`,
    input: item.arguments,
    output,
    ...(item.error && {
      error: item.error.message,
      isError: true,
    }),
    status: item.status === 'in_progress' ? 'in_progress' : 'completed',
  };
}

export function buildCodexThreadToolLog(event: ThreadStartedEvent): ToolUseLog {
  return {
    toolName: CODEX_THREAD_TOOL,
    summary: 'Created',
    input: {
      threadId: event.thread_id,
    } satisfies CodexThreadToolInput,
    status: 'completed',
  };
}

export function buildCodexTodoToolLog(
  item: TodoListItem,
  status: ToolUseStatus,
): ToolUseLog {
  const completedCount = item.items.filter((todo) => todo.completed).length;
  const totalCount = item.items.length;
  const summary =
    totalCount > 0 ? `${completedCount}/${totalCount} completed` : 'No tasks';

  return {
    toolName: CODEX_TODO_TOOL,
    summary,
    input: {
      items: item.items,
      completedCount,
      totalCount,
    } satisfies CodexTodoToolInput,
    status,
  };
}

/** Human-readable label for a Codex turn state. */
function codexTurnSummary(state: CodexTurnState): string {
  switch (state) {
    case 'running':
      return 'Running';
    case 'failed':
      return 'Failed';
    case 'completed':
      return 'Completed';
  }
}

export function buildCodexTurnToolLog(options?: {
  wallTimeMs?: number | null;
  state?: CodexTurnState;
  error?: string;
}): ToolUseLog {
  const state = options?.state ?? (options?.error ? 'failed' : 'completed');
  const roundedMs =
    options?.wallTimeMs == null
      ? undefined
      : Math.max(0, Math.round(options.wallTimeMs));
  const input: CodexTurnToolInput = {
    state,
    ...(roundedMs != null && {
      wallTimeMs: roundedMs,
    }),
  };

  return {
    toolName: CODEX_TURN_TOOL,
    summary: codexTurnSummary(state),
    input,
    // A failed turn is always an error card so the progress view shows failure
    // chrome; the error message is attached when the caller has one (turn.failed
    // / stream error) but omitted for abort or an early stream end.
    ...(state === 'failed' && {
      isError: true,
      ...(options?.error && { error: options.error }),
    }),
    status: state === 'running' ? 'in_progress' : 'completed',
  };
}

export function buildCodexUsageStats(usage: Usage): TokenUsageStats {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cost: 0,
    ...(usage.cached_input_tokens > 0 && {
      cacheReadInputTokens: usage.cached_input_tokens,
    }),
  };
}
