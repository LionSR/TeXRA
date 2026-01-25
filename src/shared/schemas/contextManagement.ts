/**
 * Zod schemas for context management events.
 * Used by AgentLogger and progress view formatters.
 */

// Third-party imports
import { z } from 'zod';

/**
 * Context management actions that can be logged.
 * - compaction: OpenAI conversation compaction
 * - clear_tool_uses: Anthropic server-side tool use clearing
 * - clear_thinking: Anthropic server-side thinking clearing
 * - truncation: Generic message/context truncation
 * - max_tokens_reduced: Max output tokens reduced due to context pressure
 */
export const ContextManagementAction = z.enum([
  'compaction',
  'clear_tool_uses',
  'clear_thinking',
  'truncation',
  'max_tokens_reduced',
]);
export type ContextManagementAction = z.infer<typeof ContextManagementAction>;

/**
 * Context management event data for logging compaction, truncation, etc.
 * Schema-first definition following project conventions (CLAUDE.md).
 */
export const ContextManagementDataSchema = z.object({
  /** Type of context management action */
  action: ContextManagementAction,
  /** Tokens before the action */
  tokensBefore: z.number().nonnegative(),
  /** Tokens after the action (if known) */
  tokensAfter: z.number().nonnegative().optional(),
  /** Context window size */
  contextWindow: z.number().positive(),
  /** Percentage of context utilized before action */
  utilizationBefore: z.number().nonnegative(),
  /** Percentage of context utilized after action (if known) */
  utilizationAfter: z.number().nonnegative().optional(),
  /** Provider-specific details */
  details: z.string().optional(),
  /** Original max tokens before reduction (for max_tokens_reduced action) */
  originalMaxTokens: z.number().positive().optional(),
  /** Reduced max tokens after adjustment (for max_tokens_reduced action) */
  reducedMaxTokens: z.number().positive().optional(),
});

export type ContextManagementData = z.infer<typeof ContextManagementDataSchema>;

/**
 * Context state data for tracking current context utilization.
 * Emitted after token counting to update UI with current usage.
 */
export const ContextStateDataSchema = z.object({
  /** Current input tokens in the context */
  inputTokens: z.number().nonnegative(),
  /** Maximum context window size */
  contextWindow: z.number().positive(),
  /** Percentage of context utilized (0-100) */
  utilizationPercent: z.number().nonnegative(),
});

export type ContextStateData = z.infer<typeof ContextStateDataSchema>;
