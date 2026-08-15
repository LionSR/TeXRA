// Third-party imports
import { z } from 'zod';

// Local imports - core flow primitives
import { BaseCycleFieldsSchema } from '@agent/core/flows/CommonCycleTypes';
import type {
  FinalTool,
  SdkToolCall,
} from '@agent/types/ModelHandlerContracts';
import { NormalizedUsageSchema } from '@agent/types/NormalizedUsage';

/**
 * Schema for serializable tool-use round fields.
 *
 * Extends BaseCycleFieldsSchema with tool-specific fields.
 * Uses the same flat pattern as ResponseCycleFlow for consistency.
 *
 * ## Field Categories
 *
 * From BaseCycleFieldsSchema (shared with ResponseCycleFlow):
 * - messages, shouldStop, endTurn, responseTimeMs, stopReason, lastError
 *
 * Tool-use specific fields:
 * - response, toolCalls, text, roundIndex, roundResponseTimeMs, roundNormalizedUsage
 */
const ToolUseRoundFieldsSchema = BaseCycleFieldsSchema.extend({
  /**
   * System prompt for providers that pass `system` per-call (Anthropic,
   * Google) rather than embedding it into `messages` at session init.
   * Set once by `ToolUsePrepareNode` and held stable for the life of the
   * session — never regenerated mid-round, since providers like Anthropic
   * treat any byte change to this string as a full cache-prefix miss.
   */
  systemPrompt: z.string().optional(),
  /** Raw response from model (provider-specific, not schematized) */
  response: z.unknown().optional(),
  /**
   * Tool calls extracted from response.
   * Uses z.custom<SdkToolCall>() because SdkToolCall is a complex discriminated
   * union of provider-specific types without a Zod schema of its own.
   */
  toolCalls: z.array(z.custom<SdkToolCall>()).optional(),
  /** Text content from response */
  text: z.string().optional(),
  /**
   * Current round index (0-based).
   *
   * Used for debug file naming and usage tracking. Incremented after each
   * successful round in ToolUseProcessNode.post().
   */
  roundIndex: z.int().nonnegative(),
  /**
   * Accumulated response time for current round (milliseconds).
   * Reset after finalization when continuing to next round.
   */
  roundResponseTimeMs: z.number().nonnegative(),
  /**
   * Normalized usage for current round.
   * Reset after finalization when continuing to next round.
   */
  roundNormalizedUsage: NormalizedUsageSchema.optional(),
  /** Last tool-result message index that received a blank-turn continuation. */
  blankToolResultContinuationMessageIndex: z.int().nonnegative().optional(),
});

/** Tool-use round fields derived from schema */
type ToolUseRoundFields = z.infer<typeof ToolUseRoundFieldsSchema>;

/**
 * Shared state for tool-use round flows.
 *
 * Uses flat structure (like ResponseCycleFlow) for consistency.
 * All fields come from ToolUseRoundFieldsSchema.
 *
 * ## Architecture
 * - Mutable state: `shared` (this interface) - flat, no nested wrappers
 * - Immutable services: `this.services` (ToolUseRoundServices)
 */
export interface ToolUseRoundShared extends ToolUseRoundFields {
  /** Latest non-empty assistant text produced anywhere in this cycle. */
  latestAssistantText?: string;
  /** Current user instruction, refreshed when the round consumes user input. */
  currentUserInstruction?: string;
  /** Named tool forced on this round's model request. */
  finalTool?: FinalTool;
  /** Whether this cycle has already issued its one provider-native final turn. */
  finalToolAttempted?: boolean;
}
