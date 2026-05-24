/** Common types shared across cycle flows (ResponseCycleFlow, ToolUseCycleFlow). */

import { z } from 'zod';

import type { AgentTrace } from '@agent/trace';
import { isRemoteAgent } from '@agent/index/agentRegistry';
import type { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { AgentCore } from '@agent/implementations/flows/common/BaseFlowServices';
import {
  ProviderMessageSchema,
  type ProviderMessage,
} from '@agent/modelHandlers/types/ProviderMessage';
import type { ProviderStopReason } from '@agent/modelHandlers/types/StopReasonTypes';
import type { ProviderUsage } from '@agent/core/ResponseUsage';
import { getActiveChildren } from '@agent/runtime/executionRegistry';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import {
  maybeSaveDebugObject,
  type DebugContext,
} from '@agent/utils/debugMessageSaver';
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
function getDebugContext(
  services: { logger: AgentTrace; executionId?: ExecutionId },
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

type CycleServices = AgentCore & { workspace: AgentWorkspaceState };

export type CycleDebugFileOptions = {
  continuationCount: number;
  baseName: string;
  outputFile?: string;
};

export async function saveCycleDebug(
  object: unknown,
  objectType: 'messages' | 'response',
  services: AgentCore,
  fileOptions: CycleDebugFileOptions,
): Promise<void> {
  await maybeSaveDebugObject({
    object,
    objectType,
    context: getDebugContext(services, {
      modelName: services.config.model,
      isRemote: isRemoteAgent(services.config.agent),
    }),
    fileOptions,
  });
}

export function defaultPostCompactionContext(
  services: CycleServices,
): string | null {
  const { subagents, processes } = getActiveChildren(services.streamId);
  return formatPostCompactionContext(
    subagents,
    processes,
    services.workspace.workPlan.toSnapshot(),
  );
}

export interface ExtractedModelResponse {
  text: string;
  usage: ProviderUsage;
  stopReason: ProviderStopReason;
  thinking: string | null;
  useStreaming: boolean;
  /** `undefined` when the caller chooses to skip nullish raw usage. */
  normalizedUsage: NormalizedUsage | undefined;
}

export type ExtractModelResponseOptions = {
  /**
   * Response flows historically normalized null provider usage into a zero
   * snapshot. Tool-use flows historically skipped missing usage. Keep that
   * distinction explicit at the call site.
   */
  normalizeNullUsage?: boolean;
};

export function extractModelResponse(
  response: unknown,
  responseTimeMs: number | undefined,
  endTag: string,
  services: CycleServices,
  options: ExtractModelResponseOptions = {},
): ExtractedModelResponse {
  const { modelHandler, workspace, logger } = services;
  const thinking = modelHandler.processThinkingBlock(response, workspace);
  const useStreaming = modelHandler.getStreamingConfig();
  const { text, usage, stopReason } = modelHandler.extractResponse(
    response,
    endTag,
  );

  let normalizedUsage: NormalizedUsage | undefined;
  if (usage != null || options.normalizeNullUsage === true) {
    normalizedUsage = modelHandler.normalizeUsage(usage, responseTimeMs ?? 0);
    const { inputTokens } = normalizedUsage;
    const contextWindow = modelHandler.getEffectiveContextWindow();
    if (inputTokens > 0 && contextWindow > 0) {
      logger.logContextState(inputTokens, contextWindow);
    }
  }

  return { text, usage, stopReason, thinking, useStreaming, normalizedUsage };
}
