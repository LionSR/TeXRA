// Third-party imports
import { z } from 'zod';

// Local imports - core flow primitives
import { BaseCycleFieldsSchema } from '@agent/core/flows/CommonCycleTypes';
import type { SdkToolCall } from '@agent/modelHandlers/types/IModelHandler';
import {
  NormalizedUsageSchema,
  type NormalizedUsage,
} from '@agent/types/NormalizedUsage';

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
 * - response, toolCalls, text, cycleIndex, cycleResponseTimeMs, cycleNormalizedUsage
 */
export const ToolUseRoundFieldsSchema = BaseCycleFieldsSchema.extend({
  /** Raw response from model (provider-specific, not schematized) */
  response: z.unknown().optional(),
  /**
   * Tool calls extracted from response.
   * Runtime type is SdkToolCall[] (discriminated union of provider-specific types).
   * Uses z.unknown() because SdkToolCall is a complex union without a Zod schema.
   */
  toolCalls: z.array(z.unknown()).optional(),
  /** Text content from response */
  text: z.string().optional(),
  /**
   * Current round index (0-based).
   *
   * Used for debug file naming and usage tracking. Incremented after each
   * successful round in ToolUseProcessNode.post().
   */
  cycleIndex: z.int().nonnegative(),
  /**
   * Accumulated response time for current round (milliseconds).
   * Reset after finalization when continuing to next round.
   */
  cycleResponseTimeMs: z.number().nonnegative(),
  /**
   * Normalized usage for current round.
   * Reset after finalization when continuing to next round.
   */
  cycleNormalizedUsage: NormalizedUsageSchema.optional(),
});

/** Tool-use round fields derived from schema */
export type ToolUseRoundFields = z.infer<typeof ToolUseRoundFieldsSchema>;

/**
 * Shared state for tool-use round flows.
 *
 * Uses flat structure (like ResponseCycleFlow) for consistency.
 * All fields from ToolUseRoundFieldsSchema plus runtime-only toolCalls typing.
 *
 * ## Architecture
 * - Mutable state: `shared` (this interface) - flat, no nested wrappers
 * - Immutable services: `this.services` (ToolUseRoundServices)
 */
export interface ToolUseRoundShared extends ToolUseRoundFields {
  /** Tool calls with proper typing (schema uses z.unknown()) */
  toolCalls?: SdkToolCall[];
  /** Normalized usage with proper typing */
  cycleNormalizedUsage?: NormalizedUsage;
}
