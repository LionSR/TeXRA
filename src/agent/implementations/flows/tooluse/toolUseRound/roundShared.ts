// Local imports - core flow primitives
import type { BaseCycleFields } from '@agent/core/flows/CommonCycleTypes';
import type {
  FinalTool,
  SdkToolCall,
} from '@agent/types/ModelHandlerContracts';

/**
 * Shared state for tool-use round flows.
 *
 * Flat, and deliberately narrower than the reflection cycle's state: per-round
 * counters and accumulators are not mirrored here. The round index is
 * `services.run.totalRounds`, and the response time and usage of the one model
 * call a round makes are read straight off that call's result.
 *
 * ## Architecture
 * - Mutable state: `shared` (this interface) - flat, no nested wrappers
 * - Immutable services: `this.services` (ToolUseRoundServices)
 */
export interface ToolUseRoundShared extends BaseCycleFields {
  /**
   * System prompt for providers that pass `system` per-call (Anthropic,
   * Google) rather than embedding it into `messages` at session init.
   * Set once by `ToolUsePrepareNode` and held stable for the life of the
   * session — never regenerated mid-round, since providers like Anthropic
   * treat any byte change to this string as a full cache-prefix miss.
   */
  systemPrompt?: string;
  /** Raw response from model (provider-specific, not schematized) */
  response?: unknown;
  /** Tool calls extracted from response. */
  toolCalls?: SdkToolCall[];
  /** Text content from response */
  text?: string;
  /** Last tool-result message index that received a blank-turn continuation. */
  blankToolResultContinuationMessageIndex?: number;
  /** Latest non-empty assistant text produced anywhere in this cycle. */
  latestAssistantText?: string;
  /** Current user instruction, refreshed when the round consumes user input. */
  currentUserInstruction?: string;
  /** Named tool forced on this round's model request. */
  finalTool?: FinalTool;
  /** Whether this cycle has already issued its one provider-native final turn. */
  finalToolAttempted?: boolean;
}
