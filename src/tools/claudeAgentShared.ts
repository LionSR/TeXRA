// Shared constants and helpers for the Claude Code CLI tool.

import type { TokenUsageStats, ToolUseLog } from '@shared/schemas';
import {
  ClaudeAgentEffortSchema,
  ClaudeAgentPermissionModeSchema,
} from '@shared/schemas/agentCliSettings';
import { truncateSummary } from '@utils/text/stringUtils';

import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';

// Re-export native SDK types where our values match exactly.
export type ClaudeAgentEffort = EffortLevel;

/**
 * Compile-time guard: the effort-level schema and the SDK's `EffortLevel`
 * union must stay synchronized in both directions. If the SDK adds or removes
 * an effort level, this line produces a type error so `ClaudeAgentEffortSchema`
 * (the source of truth) and the SDK type are reviewed together.
 */
type _AssertExact<T extends true> = T;
type _IsExact<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

type _EffortLevelsAligned = _AssertExact<
  _IsExact<ClaudeAgentEffort, (typeof CLAUDE_AGENT_EFFORT_LEVELS)[number]>
>;

export const CLAUDE_AGENT_NAME = 'claude_code';
export const CLAUDE_AGENT_DISPLAY_MODEL = 'claude';

/**
 * Permission modes exposed in the settings UI.
 * Subset of the SDK's PermissionMode — 'dontAsk' and 'auto' are internal only.
 * Derived from `ClaudeAgentPermissionModeSchema` (the single source of truth in
 * `@shared`) so the runtime list and the IPC schema can't drift.
 */
export const CLAUDE_AGENT_PERMISSION_MODES =
  ClaudeAgentPermissionModeSchema.options;
export type ClaudeAgentPermissionMode =
  (typeof CLAUDE_AGENT_PERMISSION_MODES)[number];

/** Effort levels mirror the SDK's `EffortLevel` (low → max). Claude decides
 * adaptively how much thinking to do, scaled by this hint. Derived from
 * `ClaudeAgentEffortSchema` (the single source of truth in `@shared`). */
export const CLAUDE_AGENT_EFFORT_LEVELS = ClaudeAgentEffortSchema.options;

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
type ToolUseStatus = NonNullable<ToolUseLog['status']>;

/**
 * Subset of the SDK's `SDKAssistantMessage.message` content blocks we need to
 * log, hand-declared as a discriminated union (rather than importing the
 * private MessageParam shape from `@anthropic-ai/sdk` into VS Code-free
 * zones). Narrowing on `type` gives each variant only its own fields, so a
 * caller can't accidentally read e.g. `tool_use_id` off a `text` block.
 */
export type ClaudeMessageBlock =
  | { type: 'text'; text?: string }
  | { type: 'thinking'; thinking?: string }
  | { type: 'tool_use'; id?: string; name?: string; input?: unknown }
  | {
      type: 'tool_result';
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    };

/** Raw per-turn usage as reported by the Claude Agent SDK (snake_case, all optional). */
export interface ClaudeTurnUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Format a usage object into TeXRA's TokenUsageStats. */
export function buildClaudeUsageStats(usage: ClaudeTurnUsage): TokenUsageStats {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cost: 0,
    ...(usage.cache_read_input_tokens != null &&
      usage.cache_read_input_tokens > 0 && {
        cacheReadInputTokens: usage.cache_read_input_tokens,
      }),
    ...(usage.cache_creation_input_tokens != null &&
      usage.cache_creation_input_tokens > 0 && {
        cacheCreationInputTokens: usage.cache_creation_input_tokens,
      }),
  };
}

/**
 * Build a tool-use log entry for a Claude `tool_use` content block.
 * Mirrors the rendering of Codex's command/file-change events while retaining
 * Claude's concrete built-in tool name.
 */
export function buildClaudeToolUseLog(params: {
  toolName: string;
  input: unknown;
  status: ToolUseStatus;
  isError?: boolean;
  output?: unknown;
  errorMessage?: string;
}): ToolUseLog {
  const summarySource = describeToolInput(params.toolName, params.input);
  return {
    toolName: `claude:${params.toolName}`,
    summary: truncateSummary(summarySource, SUMMARY_MAX_LENGTH),
    input: params.input as Record<string, unknown>,
    ...(params.output !== undefined && {
      output: params.output as Record<string, unknown>,
    }),
    ...(params.isError &&
      params.errorMessage && {
        error: params.errorMessage,
        isError: true,
      }),
    status: params.status,
  };
}

/**
 * Produce a short summary line for the supported built-in tools. Falls back
 * to the tool name when the input shape isn't recognized.
 */
function describeToolInput(toolName: string, input: unknown): string {
  if (input == null || typeof input !== 'object') return toolName;
  const record = input as Record<string, unknown>;

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
      if (typeof record.pattern === 'string') {
        return `Glob ${record.pattern}`;
      }
      break;
    case 'Grep':
      if (typeof record.pattern === 'string') {
        return `Grep ${record.pattern}`;
      }
      break;
    case 'WebFetch':
      if (typeof record.url === 'string') return `WebFetch ${record.url}`;
      break;
    case 'WebSearch':
      if (typeof record.query === 'string') return `WebSearch ${record.query}`;
      break;
    case 'TodoWrite':
      return 'TodoWrite';
    case 'Task':
      if (typeof record.description === 'string') {
        return `Task ${record.description}`;
      }
      break;
  }
  return toolName;
}
