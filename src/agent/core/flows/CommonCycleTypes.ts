/** Common types shared across cycle flows (ResponseCycleFlow, ToolUseCycleFlow). */

import { z } from 'zod';

import {
  ProviderMessageSchema,
  type ProviderMessage,
} from '@agent/modelHandlers/types/ProviderMessage';
import type { DebugContext } from '@agent/utils/debugMessageSaver';
import type { AgentLogger } from '@logger/AgentLogger';
import { RetryErrorInfoSchema } from '@shared/schemas';
import type { ExecutionId } from '@shared/schemas';

/** Base schema for fields common to all cycle flows. */
export const BaseCycleFieldsSchema = z.object({
  messages: z.array(ProviderMessageSchema),
  shouldStop: z.boolean(),
  /** Distinguishes: completion (true) vs cancellation/failure (false) */
  endTurn: z.boolean(),
  responseTimeMs: z.number().nonnegative().optional(),
  stopReason: z.string().nullish(),
  lastError: RetryErrorInfoSchema.optional(),
});

export type BaseCycleFields = z.infer<typeof BaseCycleFieldsSchema>;

/** Derive debug context from services at call site. */
export function getDebugContext(
  services: { logger: AgentLogger; executionId?: ExecutionId },
  params: { modelName?: string; isRemote?: boolean },
): DebugContext {
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
  systemPrompt?: string;
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
