import prettyMilliseconds from 'pretty-ms';
import { buildMcpToolName } from '@texra-ai/harness/transcript';
import {
  getBasename,
  truncateSummary,
  type McpToolOutput,
  type ToolCallStatus,
  type ToolCard,
  type ToolUseLog,
} from '@texra-ai/harness/schemas';
import type {
  CommandExecutionItem,
  FileChangeItem,
  McpToolCallItem,
  ThreadStartedEvent,
} from '@openai/codex-sdk';

export const CODEX_AGENT_NAME = 'codex';
/** The tool names of the cards a Codex turn reports beside its commands and
 *  MCP calls: its file changes, its thread, and the turn itself. */
const CODEX_FILE_CHANGE_TOOL = 'codex_patch';
const CODEX_THREAD_TOOL = 'codex_thread';
const CODEX_TURN_TOOL = 'codex_turn';
const CODEX_COMMAND_SUMMARY_MAX_LENGTH = 60;

/**
 * The card of a `codex` call: its prompt, and as badges its sandbox mode and
 * whether it continues an existing thread.
 */
export function codexCallCard(input: {
  readonly prompt: string;
  readonly sandbox_mode?: string | null;
  readonly thread_id?: string | null;
}): ToolCard {
  const badges = [
    ...(input.sandbox_mode ? [input.sandbox_mode] : []),
    ...(input.thread_id ? ['follow-up'] : []),
  ];
  return {
    title: CODEX_AGENT_NAME,
    sections: [
      ...(input.prompt
        ? [{ kind: 'text' as const, label: 'Prompt:', text: input.prompt }]
        : []),
      ...(badges.length > 0
        ? [{ kind: 'badges' as const, label: 'Mode:', badges }]
        : []),
    ],
  };
}

type CodexFileChange = FileChangeItem['changes'][number];
type CodexCommandToolLogOptions = Pick<
  CommandExecutionItem,
  'command' | 'aggregated_output' | 'exit_code' | 'status'
>;
/** The card status of a Codex item: live while it runs, then its outcome. */
function codexCardStatus(inProgress: boolean, failed: boolean): ToolCallStatus {
  if (inProgress) return 'in_progress';
  return failed ? 'failed' : 'completed';
}

/** Normalize Codex command execution events for the native bash tool card. */
export function buildCodexCommandToolLog(
  options: CodexCommandToolLogOptions,
): ToolUseLog {
  const isError =
    options.status === 'failed' ||
    (options.exit_code != null && options.exit_code !== 0);
  const toolStatus = codexCardStatus(options.status === 'in_progress', isError);
  const command = options.command.trim();
  const exitInfo =
    options.exit_code == null
      ? options.status?.trim() || 'completed'
      : `exit ${options.exit_code}`;
  const output =
    options.aggregated_output.trimEnd() ||
    (toolStatus === 'in_progress' ? '' : `(${exitInfo})`);

  return {
    toolName: 'bash',
    summary: truncateSummary(
      command || 'command',
      CODEX_COMMAND_SUMMARY_MAX_LENGTH,
    ),
    input: { command: options.command },
    ...(output && { output }),
    ...(options.exit_code != null && { exitCode: options.exit_code }),
    ...(isError && { error: `Command failed (${exitInfo})` }),
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

  const patchFailed = item.status === 'failed';
  const summary =
    dedupedChanges.length === 1
      ? `${patchFailed ? 'failed ' : ''}${dedupedChanges[0].kind} ${getBasename(dedupedChanges[0].path)}`
      : `${dedupedChanges.length} file changes${patchFailed ? ' failed' : ''}`;

  return {
    toolName: CODEX_FILE_CHANGE_TOOL,
    summary,
    input: { changes: dedupedChanges, patchStatus: item.status },
    card: {
      title: 'Codex Files',
      sections: [
        ...(item.status
          ? [{ kind: 'status' as const, label: 'Status:', status: item.status }]
          : []),
        {
          kind: 'fileList',
          label: 'Files:',
          files: dedupedChanges.map(({ path, kind }) => ({ path, note: kind })),
        },
      ],
    },
    ...(patchFailed && { error: 'Patch apply failed' }),
    status: patchFailed ? 'failed' : 'completed',
  };
}

export function buildCodexMcpToolLog(item: McpToolCallItem): ToolUseLog {
  const contentBlocks = item.result?.content ?? [];
  const output: McpToolOutput = {
    status: item.status,
    ...(item.result?.structured_content !== undefined && {
      structuredContent: item.result.structured_content,
    }),
    ...(contentBlocks.length > 0 && {
      contentBlocks,
    }),
  };

  return {
    toolName: buildMcpToolName(item.server, item.tool),
    input: item.arguments,
    output,
    ...(item.error && { error: item.error.message }),
    status: codexCardStatus(item.status === 'in_progress', item.error != null),
  };
}

export function buildCodexThreadToolLog(event: ThreadStartedEvent): ToolUseLog {
  return {
    toolName: CODEX_THREAD_TOOL,
    summary: 'Created',
    input: { threadId: event.thread_id },
    card: {
      title: 'Codex Thread',
      sections: [
        { kind: 'identifier', label: 'Thread ID:', value: event.thread_id },
      ],
    },
    status: 'completed',
  };
}

type CodexTurnState = 'running' | 'completed' | 'failed';

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

export function buildCodexTurnToolLog({
  state,
  wallTimeMs,
  error,
}: {
  state: CodexTurnState;
  wallTimeMs?: number;
  error?: string;
}): ToolUseLog {
  const roundedMs =
    wallTimeMs == null ? undefined : Math.max(0, Math.round(wallTimeMs));
  return {
    toolName: CODEX_TURN_TOOL,
    summary: codexTurnSummary(state),
    input: { state, ...(roundedMs != null && { wallTimeMs: roundedMs }) },
    card: {
      title: 'Codex Turn',
      sections: [
        { kind: 'status', label: 'State:', status: state },
        ...(roundedMs
          ? [
              {
                kind: 'text' as const,
                label: 'Duration:',
                // Whole seconds, at least 1s: the card's wall-time reading.
                text: prettyMilliseconds(
                  Math.max(1000, Math.floor(roundedMs / 1000) * 1000),
                  { secondsDecimalDigits: 0 },
                ),
              },
            ]
          : []),
      ],
    },
    // A failed turn is a failed card so the progress view shows failure
    // chrome; the error message is attached when the caller has one (turn.failed
    // / stream error) but omitted for abort or an early stream end.
    ...(state === 'failed' && error && { error }),
    status: codexCardStatus(state === 'running', state === 'failed'),
  };
}
