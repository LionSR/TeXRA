/**
 * Common types shared across different flow cycles to reduce duplication
 * and provide consistent interfaces.
 *
 * ## Schema-First Pattern
 *
 * This module provides `BaseCycleFieldsSchema` as the single source of truth
 * for fields common to all cycle flows (ResponseCycleFlow, ToolUseCycleFlow).
 * Specific flows extend this schema with their own fields.
 *
 * ## Architectural Note: PocketFlow Separation of Concerns
 *
 * Flow nodes follow PocketFlow's separation pattern:
 * - `prep(shared)` extracts data from shared state into a PrepResult
 * - `exec(prepRes)` performs compute using ONLY prepRes (no shared access)
 * - `post(shared, prepRes, execRes)` writes results back to shared
 *
 * This separation ensures:
 * 1. `exec()` is isolated and easier to test
 * 2. Retries don't have side effects on shared state
 * 3. Clear data flow through the node lifecycle
 *
 * Services (modelHandler, client, etc.) are accessed via `_params.services`,
 * which is the PocketFlow pattern for immutable configuration.
 */

import { z } from 'zod';

import {
  ProviderMessageSchema,
  type ProviderMessage,
} from '@agent/modelHandlers/types/ProviderMessage';
import type { ExecutionId } from '@agent/types/IdentifierTypes';
import type { AgentLogger } from '@logger/AgentLogger';
import { RetryErrorInfoSchema } from './RetryState';

// ============================================================================
// Base Cycle Schema (Single Source of Truth)
// ============================================================================

/**
 * Base schema for fields common to ALL cycle flows.
 *
 * This is the SINGLE SOURCE OF TRUTH for shared cycle field definitions.
 * Both ResponseCycleFlow and ToolUseCycleFlow extend this schema.
 *
 * ## Field Categories
 *
 * Required fields (must be initialized before cycle runs):
 * - messages, shouldStop, endTurn
 *
 * Optional fields (populated during/after cycle execution):
 * - responseTimeMs, stopReason, lastError
 *
 * ## Usage
 *
 * Specific flows extend this with their own fields:
 * ```typescript
 * // ResponseCycleFlow adds output tracking:
 * const CycleFieldsSchema = BaseCycleFieldsSchema.extend({
 *   outputExists: z.boolean(),
 *   outputLocation: AgentFileLocationSchema.nullable(),
 *   processedResponse: z.string().optional(),
 * });
 *
 * // ToolUseCycleFlow adds tool tracking:
 * const ToolUseCycleFieldsSchema = BaseCycleFieldsSchema.extend({
 *   toolCalls: z.array(SdkToolCallSchema).optional(),
 *   text: z.string().optional(),
 *   cycleIndex: z.number(),
 * });
 * ```
 */
export const BaseCycleFieldsSchema = z.object({
  /** Messages being processed in this cycle */
  messages: z.array(ProviderMessageSchema),
  /** Whether the cycle should stop processing */
  shouldStop: z.boolean(),
  /**
   * Whether the last cycle ended normally (model said end_turn).
   *
   * Used by callers to distinguish between:
   * - Normal completion: shouldStop=true, endTurn=true
   * - User cancellation: shouldStop=true, endTurn=false, lastError=undefined
   * - Failure: shouldStop=true, endTurn=false, lastError defined
   */
  endTurn: z.boolean(),
  /** Time taken for response in milliseconds */
  responseTimeMs: z.number().optional(),
  /** Reason the model stopped generating (nullable to match ProviderStopReason) */
  stopReason: z.string().nullable().optional(),
  /** Last error info for retry handling */
  lastError: RetryErrorInfoSchema.optional(),
});

/** Base cycle fields derived from schema */
export type BaseCycleFields = z.infer<typeof BaseCycleFieldsSchema>;

/**
 * Unified debug context used across all cycle flows.
 * Provides consistent logging and execution tracking.
 *
 * NOTE: This type is NOT stored in shared state - it's derived from services
 * at each `maybeSaveDebugObject` call site using `getDebugContext()`.
 * This eliminates redundant storage of logger and executionId.
 */
export interface CycleDebugContext {
  logger: AgentLogger;
  modelName?: string;
  executionId?: ExecutionId;
  /** Whether this is a remote agent (don't save messages to avoid leaking prompts) */
  isRemote?: boolean;
}

/**
 * Minimal services interface for deriving debug context.
 * Both ResponseCycleServices and ToolUseCycleServices satisfy this.
 */
export interface DebugContextServices {
  logger: AgentLogger;
  context: { executionId?: ExecutionId };
}

/**
 * Parameters for creating debug context (fields not available in services).
 */
export interface DebugContextParams {
  modelName?: string;
  isRemote?: boolean;
}

/**
 * Derive CycleDebugContext from services at call site.
 *
 * This eliminates redundant storage of logger/executionId in shared state.
 * Call this at each `maybeSaveDebugObject` invocation instead of storing
 * the context in shared or passing through prep/exec results.
 *
 * @param services - Services containing logger and context
 * @param params - Additional params not available from services (modelName, isRemote)
 * @returns CycleDebugContext for maybeSaveDebugObject
 */
export function getDebugContext(
  services: DebugContextServices,
  params: DebugContextParams,
): CycleDebugContext {
  return {
    logger: services.logger,
    executionId: services.context.executionId,
    modelName: params.modelName,
    isRemote: params.isRemote,
  };
}

/**
 * Result type for nodes that can be skipped based on flow state.
 * Uses 'kind' discriminant for consistency with InvocationResult.
 */
export type SkippableNodeResult<T> =
  | { kind: 'skipped' }
  | { kind: 'success'; value: T };

/**
 * Generic reset function for cycle states.
 * Resets base state fields and any additional optional fields to undefined.
 *
 * IMPORTANT: Only pass fields that should be reset to undefined.
 * - Do NOT pass 'messages' (preserved across cycles)
 * - Do NOT pass boolean fields like 'endTurn'
 *   (these should be reset to false separately, not undefined)
 *
 * @param state - The state object to reset (must extend BaseCycleFields)
 * @param additionalFields - Field names to reset to undefined (typically optional object fields)
 */
export function resetCycleState<T extends BaseCycleFields>(
  state: T,
  additionalFields: (keyof T)[],
): void {
  // Reset base cycle state fields
  state.shouldStop = false;
  state.endTurn = false;
  state.responseTimeMs = undefined;
  state.stopReason = undefined;
  state.lastError = undefined;

  // Reset additional optional fields to undefined
  for (const field of additionalFields) {
    // Skip 'messages' to preserve it across resets
    if (field !== 'messages') {
      state[field] = undefined as T[typeof field];
    }
  }
}

// ============================================================================
// Shared Prep/Exec Types for Invocation Nodes
// ============================================================================

/**
 * Base prep result for model/tool invocation nodes.
 * Contains the minimum data needed to decide whether to invoke.
 */
export interface BaseInvocationPrepResult {
  /** Whether to skip invocation (flow is stopping) */
  shouldStop: boolean;
  /** Messages to send to the model */
  messages: ProviderMessage[];
}

/**
 * Base success data returned from model/tool invocations.
 * Extended by specific flows with additional fields.
 */
export interface BaseInvocationSuccessData {
  /** Raw response from the model */
  response: unknown;
  /** Time taken for the response in milliseconds */
  responseTimeMs?: number;
}

// ============================================================================
// Cycle Result Interpretation
// ============================================================================

/**
 * Interpreted result from a cycle's shared state after flow completion.
 * Determines whether the cycle ended due to error, cancellation, or success.
 */
export interface CycleCompletionResult {
  /** True if the cycle stopped due to an error (not user cancellation). */
  failedWithError: boolean;
  /** Error message if failedWithError is true. */
  errorMessage?: string;
  /** True if the user cancelled the retry wait (should stop gracefully). */
  userCancelled: boolean;
}

/**
 * State needed to interpret cycle completion (flat pattern).
 * All cycle flows now use flat shared state with these fields at top level.
 */
interface CycleCompletionInput {
  shouldStop: boolean;
  endTurn?: boolean;
  lastError?: { message: string };
}

/**
 * Interprets cycle completion from shared state after flow execution.
 *
 * Determines if the cycle failed due to an error (not user cancellation):
 * - Error failure: shouldStop=true, lastError exists → failedWithError=true
 * - User cancelled: shouldStop=true, lastError=undefined, endTurn=false → userCancelled=true
 * - Successful completion: shouldStop=true, lastError=undefined, endTurn=true → neither
 *
 * @param shared - The flat shared state with shouldStop, endTurn, and lastError
 * @returns Interpreted completion result
 *
 * @example
 * const completion = interpretCycleCompletion(shared);
 */
export function interpretCycleCompletion(
  shared: CycleCompletionInput,
): CycleCompletionResult {
  const failedWithError = shared.shouldStop && !!shared.lastError;
  const userCancelled =
    shared.shouldStop && !shared.lastError && !shared.endTurn;

  return {
    failedWithError,
    errorMessage: shared.lastError?.message,
    userCancelled,
  };
}
