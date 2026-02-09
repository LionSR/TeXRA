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
  /**
   * If messages were transformed (e.g., compaction), the updated array.
   * Undefined means messages were not modified.
   */
  updatedMessages?: ProviderMessage[];
}

/**
 * Replace array contents in-place to preserve references.
 * Used when compaction returns new messages - mutating in-place ensures
 * all code holding references to the array sees the updated contents.
 */
export function replaceMessagesInPlace<T>(target: T[], newContents: T[]): void {
  target.length = 0;
  target.push(...newContents);
}

// --- Cycle Outcome Interpretation ---

/**
 * Outcome of a cycle flow execution, derived from cycle shared state.
 *
 * Used by both ResponseCycleNode and ToolUseCycleNode to avoid duplicating
 * the three-way interpretation of shouldStop / lastError / endTurn.
 */
export type CycleOutcome = 'completed' | 'cancelled' | 'failed';

/**
 * Interpret cycle shared state into a single outcome.
 *
 * Both cycle nodes (Response and ToolUse) use the same three-flag pattern:
 * - shouldStop + lastError → failed
 * - shouldStop + !lastError + !endTurn → cancelled (user stopped)
 * - otherwise → completed
 *
 * This is the single source of truth for that interpretation.
 */
export function interpretCycleOutcome(shared: BaseCycleFields): CycleOutcome {
  if (shared.shouldStop && shared.lastError) {
    return 'failed';
  }
  if (shared.shouldStop && !shared.lastError && !shared.endTurn) {
    return 'cancelled';
  }
  return 'completed';
}
