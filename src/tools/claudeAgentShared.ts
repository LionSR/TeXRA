// Shared constants and helpers for the Claude Code CLI tool.

import { warn } from '@logger/logUtils';
import type {
  ClaudeAgentEffort,
  ToolUseLog,
  ToolCallStatus,
} from '@shared/schemas';
import { truncateSummary } from '@utils/text/stringUtils';

import type { EffortLevel, ModelUsage } from '@anthropic-ai/claude-agent-sdk';

const LOG_CHANNEL = 'claudeAgent';

/**
 * Compile-time guard: `ClaudeAgentEffort` in `@shared` (the single source of
 * truth for the settings UI, the IPC schema, and the tool runtime) and the
 * SDK's `EffortLevel` union must stay synchronized in both directions. If the
 * SDK adds or removes an effort level, this line produces a type error so
 * `ClaudeAgentEffortSchema` and the SDK type are reviewed together. Effort
 * levels mirror the SDK's `EffortLevel` (low → max): Claude decides adaptively
 * how much thinking to do, scaled by this hint.
 */
type _AssertExact<T extends true> = T;
type _IsExact<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

type _EffortLevelsAligned = _AssertExact<
  _IsExact<EffortLevel, ClaudeAgentEffort>
>;

export const CLAUDE_AGENT_NAME = 'claude_code';

/**
 * Adaptive thinking is only supported on Fable 5, Opus 4.6+, and Sonnet 4.6+
 * (on Fable thinking is always on; an explicit `adaptive` is accepted). Haiku
 * (and any earlier model) rejects the `thinking: { type: 'adaptive' }`
 * option — gate the SDK option on this predicate to keep Haiku usable.
 */
export function modelSupportsAdaptiveThinking(model: string): boolean {
  return (
    model.startsWith('claude-opus-') ||
    model.startsWith('claude-sonnet-') ||
    model.startsWith('claude-fable-')
  );
}

const SUMMARY_MAX_LENGTH = 60;

/** Raw per-turn usage as reported by the Claude Agent SDK (snake_case, all optional). */
export interface ClaudeTurnUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cost_usd?: number;
}

/** Collapse the SDK's authoritative per-model totals into one turn summary. */
export function aggregateClaudeModelUsage(
  modelUsage: Readonly<Record<string, ModelUsage>> | undefined,
): ClaudeTurnUsage | null {
  const models = Object.values(modelUsage ?? {});
  if (models.length === 0) return null;

  const sum = (pick: (model: ModelUsage) => number): number =>
    models.reduce((total, model) => total + pick(model), 0);
  const usage: Required<ClaudeTurnUsage> = {
    input_tokens: sum((model) => model.inputTokens),
    output_tokens: sum((model) => model.outputTokens),
    cache_read_input_tokens: sum((model) => model.cacheReadInputTokens),
    cache_creation_input_tokens: sum((model) => model.cacheCreationInputTokens),
    cost_usd: sum((model) => model.costUSD),
  };
  return usage;
}

/** Narrow an SDK-sourced value to a plain record, the way every built-in
 *  tool's `input` arrives per the tool-use protocol (a no-argument call still
 *  sends `{}`, never a bare primitive or `null`). */
function isToolRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/**
 * Narrow a `tool_use` block's `input` to a record for storage on
 * `ToolUseLog`. A non-object payload here means the SDK sent something
 * outside the tool-use contract (every call — including no-argument ones —
 * carries a JSON object), so it's worth a loud warning rather than a cast
 * that silently misrepresents the value as a record.
 */
function toToolInputRecord(
  toolName: string,
  input: unknown,
): Record<string, unknown> | undefined {
  if (input === undefined) return undefined;
  if (isToolRecord(input)) return input;
  warn(
    LOG_CHANNEL,
    `Claude tool "${toolName}" sent a non-object input; expected a JSON object per the tool-use protocol.`,
    { data: { input } },
  );
  return undefined;
}

/**
 * Build a tool-use log entry for a Claude `tool_use` content block.
 * Mirrors the rendering of Codex's command/file-change events while retaining
 * Claude's concrete built-in tool name.
 */
export function buildClaudeToolUseLog(params: {
  toolName: string;
  input: unknown;
  status: ToolCallStatus;
}): ToolUseLog {
  const summarySource = describeToolInput(params.toolName, params.input);
  return {
    toolName: `claude:${params.toolName}`,
    summary: truncateSummary(summarySource, SUMMARY_MAX_LENGTH),
    input: toToolInputRecord(params.toolName, params.input),
    status: params.status,
  };
}

/**
 * Produce a short summary line for the supported built-in tools. Falls back
 * to the tool name when the input shape isn't recognized.
 */
function describeToolInput(toolName: string, input: unknown): string {
  if (!isToolRecord(input)) return toolName;
  const record = input;

  switch (toolName) {
    case 'Bash':
      if (typeof record.command === 'string') return record.command;
      break;
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      if (typeof record.file_path === 'string') {
        return `${toolName} ${record.file_path}`;
      }
      break;
    case 'Glob':
    case 'Grep':
      if (typeof record.pattern === 'string') {
        return `${toolName} ${record.pattern}`;
      }
      break;
    case 'WebFetch':
      if (typeof record.url === 'string') return `WebFetch ${record.url}`;
      break;
    case 'WebSearch':
      if (typeof record.query === 'string') return `WebSearch ${record.query}`;
      break;
    case 'TaskCreate':
      if (typeof record.subject === 'string') {
        return `Create task: ${record.subject}`;
      }
      break;
    case 'TaskUpdate': {
      const task = [record.subject, record.taskId].find(
        (value): value is string => typeof value === 'string',
      );
      if (task) {
        return typeof record.status === 'string'
          ? `Update task: ${task} → ${record.status}`
          : `Update task: ${task}`;
      }
      break;
    }
    case 'TaskGet':
      if (typeof record.taskId === 'string') {
        return `Get task: ${record.taskId}`;
      }
      break;
    case 'TaskList':
      return 'List tasks';
    case 'Agent':
      if (typeof record.description === 'string') {
        return `Agent ${record.description}`;
      }
      break;
  }
  return toolName;
}
