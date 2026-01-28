/**
 * Common types shared across cycle flows (ResponseCycleFlow, ToolUseCycleFlow).
 *
 * Schema-First: `BaseCycleFieldsSchema` is the single source of truth for shared fields.
 *
 * PocketFlow Separation: prep() extracts data, exec() computes (no shared access),
 * post() writes results. Services accessed via `this.services`.
 */

import { z } from 'zod';

import { RetryErrorInfoSchema } from '@shared/schemas';
import {
  ProviderMessageSchema,
  type ProviderMessage,
} from '@agent/modelHandlers/types/ProviderMessage';
import type { AgentLogger } from '@logger/AgentLogger';
import type { ExecutionId } from '@shared/schemas';

// --- Base Cycle Schema (Single Source of Truth) ---

/** Base schema for fields common to all cycle flows. */
export const BaseCycleFieldsSchema = z.object({
  messages: z.array(ProviderMessageSchema),
  shouldStop: z.boolean(),
  /** Distinguishes: completion (true) vs cancellation/failure (false) */
  endTurn: z.boolean(),
  responseTimeMs: z.number().optional(),
  stopReason: z.string().nullish(),
  lastError: RetryErrorInfoSchema.optional(),
});

export type BaseCycleFields = z.infer<typeof BaseCycleFieldsSchema>;

/** Internal debug context - use getDebugContext() to create. */
interface CycleDebugContext {
  logger: AgentLogger;
  modelName?: string;
  executionId?: ExecutionId;
  isRemote?: boolean;
}

/** Derive debug context from services at call site. */
export function getDebugContext(
  services: { logger: AgentLogger; executionId?: ExecutionId },
  params: { modelName?: string; isRemote?: boolean },
): CycleDebugContext {
  return {
    logger: services.logger,
    executionId: services.executionId,
    modelName: params.modelName,
    isRemote: params.isRemote,
  };
}

/** Result type for nodes that can be skipped based on flow state. */
export type SkippableNodeResult<T> =
  | { kind: 'skipped' }
  | { kind: 'success'; value: T };

/** Reset cycle state to initial values, plus any flow-specific fields to undefined. */
export function resetCycleState<T extends BaseCycleFields>(
  state: T,
  additionalFields: (keyof T)[] = [],
): void {
  state.shouldStop = false;
  state.endTurn = false;
  state.responseTimeMs = undefined;
  state.stopReason = undefined;
  state.lastError = undefined;

  for (const field of additionalFields) {
    state[field] = undefined as T[typeof field];
  }
}

// --- Shared Prep/Exec Types for Invocation Nodes ---

/** Base prep result for model/tool invocation nodes. */
export interface BaseInvocationPrepResult {
  shouldStop: boolean;
  messages: ProviderMessage[];
}

/** Base success data returned from model/tool invocations. */
export interface BaseInvocationSuccessData {
  response: unknown;
  responseTimeMs?: number;
}

// --- Cycle Result Interpretation ---

/** Interpreted result from cycle completion: error, cancellation, or success. */
export interface CycleCompletionResult {
  failedWithError: boolean;
  errorMessage?: string;
  userCancelled: boolean;
}

interface CycleCompletionInput {
  shouldStop: boolean;
  endTurn?: boolean;
  lastError?: { message: string };
}

/**
 * Interprets cycle completion from shared state:
 * - Error: shouldStop + lastError → failedWithError
 * - Cancelled: shouldStop + no lastError + no endTurn → userCancelled
 * - Success: shouldStop + endTurn → neither
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
