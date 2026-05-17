/** Common types shared across cycle flows (ResponseCycleFlow, ToolUseCycleFlow). */

import { z } from 'zod';

import { isRemoteAgent } from '@agent/index/agentRegistry';
import type { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { AgentCore } from '@agent/implementations/flows/common/BaseFlowServices';
import {
  ProviderMessageSchema,
  type ProviderMessage,
} from '@agent/modelHandlers/types/ProviderMessage';
import type { ProviderUsage } from '@agent/core/ResponseUsage';
import { getActiveChildren } from '@agent/runtime/executionRegistry';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import type { DebugContext } from '@agent/utils/debugMessageSaver';
import type { AgentLogger } from '@logger/AgentLogger';
import { RetryErrorInfoSchema } from '@shared/schemas';
import type { ExecutionId } from '@shared/schemas';
import { formatPostCompactionContext } from '@tools/subagentResults';

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

// --- Shared Helpers for Cycle Flows ---

/** Services subset required by `defaultPostCompactionContext`. */
type PostCompactionServices = Pick<AgentCore, 'streamId'> & {
  workspace: Pick<AgentWorkspaceState, 'workPlan'>;
};

/**
 * Default post-compaction context for cycle flows: surfaces active subagents,
 * background processes, and the current work plan after a compaction event so
 * the next model call retains awareness of in-flight work.
 */
export function defaultPostCompactionContext(
  services: PostCompactionServices,
): string | null {
  const { subagents, processes } = getActiveChildren(services.streamId);
  return formatPostCompactionContext(
    subagents,
    processes,
    services.workspace.workPlan.toSnapshot(),
  );
}

/** Services subset required by `defaultDebugMeta`. */
type DebugMetaServices = Pick<AgentCore, 'config'>;

/** Build the `{ modelName, isRemote }` pair used by every cycle debug-save call. */
export function defaultDebugMeta(services: DebugMetaServices): {
  modelName?: string;
  isRemote?: boolean;
} {
  return {
    modelName: services.config.model,
    isRemote: isRemoteAgent(services.config.agent),
  };
}

/** Services subset required by `logAndNormalizeUsage`. */
type UsageLoggingServices = {
  modelHandler: Pick<
    AgentCore['modelHandler'],
    'normalizeUsage' | 'getEffectiveContextWindow'
  >;
  logger: Pick<AgentLogger, 'logContextState'>;
};

/**
 * Normalize provider usage and emit the context-window state log when
 * sufficient data is available. Returns `undefined` for nullish usage so
 * callers can short-circuit downstream stats updates.
 */
export function logAndNormalizeUsage(
  usage: ProviderUsage,
  responseTimeMs: number,
  services: UsageLoggingServices,
): NormalizedUsage | undefined {
  if (usage == null) return undefined;
  const normalized = services.modelHandler.normalizeUsage(
    usage,
    responseTimeMs,
  );
  const { inputTokens } = normalized;
  const contextWindow = services.modelHandler.getEffectiveContextWindow();
  if (inputTokens > 0 && contextWindow > 0) {
    services.logger.logContextState(inputTokens, contextWindow);
  }
  return normalized;
}
