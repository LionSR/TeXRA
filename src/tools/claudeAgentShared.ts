// Shared constants and helpers for the Claude Code CLI tool.

import type { TokenUsageStats, ToolUseLog } from '@shared/schemas';
import {
  collapseWhitespace,
  truncateWithEllipsis,
} from '@utils/text/stringUtils';

export const CLAUDE_AGENT_NAME = 'claude_code';
export const CLAUDE_AGENT_DISPLAY_MODEL = 'claude';
export const CLAUDE_AGENT_PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
] as const;
export type ClaudeAgentPermissionMode =
  (typeof CLAUDE_AGENT_PERMISSION_MODES)[number];

/** Effort levels mirror the SDK's `EffortLevel` (low → max). Claude decides
 * adaptively how much thinking to do, scaled by this hint. */
export const CLAUDE_AGENT_EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export type ClaudeAgentEffort = (typeof CLAUDE_AGENT_EFFORT_LEVELS)[number];

/** Canonical Claude model IDs surfaced by the settings dropdown.
 * The SDK accepts arbitrary model strings; this list is what we expose in the
 * UI. Keep it in sync with `ClaudeAgentModelSchema` in settingsViewMessages.ts.
 * Sonnet and Opus use the alias form; Haiku 4.5 ships with a dated snapshot
 * suffix (its only published identifier at time of writing). */
export const CLAUDE_AGENT_MODELS = [
  'claude-sonnet-4-6',
  'claude-opus-4-7',
  'claude-haiku-4-5-20251001',
] as const;
export type ClaudeAgentModel = (typeof CLAUDE_AGENT_MODELS)[number];

/**
 * Adaptive thinking is only supported on Opus 4.6+ and Sonnet 4.6+. Haiku
 * (and any earlier model) rejects the `thinking: { type: 'adaptive' }`
 * option — gate the SDK option on this predicate to keep Haiku usable.
 */
export function modelSupportsAdaptiveThinking(model: string): boolean {
  return model.startsWith('claude-opus-') || model.startsWith('claude-sonnet-');
}

const SUMMARY_MAX_LENGTH = 60;
type ToolUseStatus = NonNullable<ToolUseLog['status']>;

/**
 * Subset of the SDK's `SDKAssistantMessage.message` shape we need to log
 * (kept as `unknown` indices in the public type to avoid importing the
 * private MessageParam shape from `@anthropic-ai/sdk` into VS Code-free
 * zones).
 */
export interface ClaudeMessageBlock {
  type: string;
  id?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/** Format a usage object into TeXRA's TokenUsageStats. */
export function buildClaudeUsageStats(usage: {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}): TokenUsageStats {
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

function truncateSummary(text: string, maxLength: number): string {
  return truncateWithEllipsis(collapseWhitespace(text), maxLength);
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
