/** Common types shared across cycle flows (ResponseCycleFlow, ToolUseRoundFlow). */

import { z } from 'zod';

import { logContextStateSnapshot } from '@agent/trace';
import { isRemoteAgent } from '@agent/index/agentRegistry';
import type { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { AgentCore } from '@agent/core/flows/BaseFlowServices';
import {
  ProviderMessageArraySchema,
  type ProviderMessage,
} from '@agent/types/ProviderMessage';
import type { ProviderStopReason } from '@agent/types/StopReasonTypes';
import type { ProviderUsage } from '@agent/core/usage/ResponseUsage';
import type { FinalTool } from '@agent/types/ModelHandlerContracts';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import { maybeSaveDebugObject } from '@agent/utils/debugMessageSaver';
import { formatPostCompactionContext } from '@agent/core/flows/postCompactionContext';
import { RetryErrorInfoSchema } from '@shared/schemas';

/** Base schema for fields common to all cycle flows. */
export const BaseCycleFieldsSchema = z.object({
  messages: ProviderMessageArraySchema,
  shouldStop: z.boolean(),
  /** Distinguishes: completion (true) vs cancellation/failure (false) */
  endTurn: z.boolean(),
  responseTimeMs: z.number().nonnegative().optional(),
  stopReason: z.string().nullish(),
  lastError: RetryErrorInfoSchema.optional(),
});

/** Runtime fields shared by every model invocation cycle. */
export type BaseCycleFields = z.infer<typeof BaseCycleFieldsSchema>;

/** Result type for nodes that can be skipped based on flow state. */
export type SkippableNodeResult<T> =
  { kind: 'skipped' } | { kind: 'success'; value: T };

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
  finalTool?: FinalTool;
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

/** Core services scoped with the run's workspace state. */
type WorkspaceScopedCore = AgentCore & { workspace: AgentWorkspaceState };

export type CycleDebugFileOptions = {
  continuationCount: number;
  baseName: string;
  outputFile?: string;
};

export async function saveCycleDebug(
  object: unknown,
  objectType: 'messages' | 'response',
  services: Pick<AgentCore, 'logger' | 'config' | 'runScope'>,
  fileOptions: CycleDebugFileOptions,
): Promise<void> {
  const { executionId } = services.runScope;
  await maybeSaveDebugObject({
    object,
    objectType,
    context: {
      logger: services.logger,
      executionId,
      modelName: services.config.model,
      isRemote: isRemoteAgent(services.config.agent),
    },
    fileOptions,
  });
}

export function defaultPostCompactionContext(
  services: Pick<WorkspaceScopedCore, 'workspace' | 'runScope'>,
): string | null {
  const { session, streamId } = services.runScope;
  return formatPostCompactionContext(
    session.executions.getActiveChildren(streamId),
    services.workspace.workPlan.toSnapshot(),
  );
}

interface ExtractedModelResponse {
  text: string;
  usage: ProviderUsage;
  stopReason: ProviderStopReason;
  thinking: string | null;
  useStreaming: boolean;
  /** `undefined` when raw usage is skipped or the handler reports none. */
  normalizedUsage: NormalizedUsage | undefined;
}

type ExtractModelResponseOptions = {
  /**
   * Ask the handler to normalize nullish provider usage. A handler may still
   * return undefined when its provider exposes no usage data.
   */
  normalizeNullUsage?: boolean;
};

export function extractModelResponse(
  response: unknown,
  responseTimeMs: number | undefined,
  endTag: string,
  services: Pick<WorkspaceScopedCore, 'modelCell' | 'workspace' | 'logger'>,
  options: ExtractModelResponseOptions = {},
): ExtractedModelResponse {
  const { workspace, logger } = services;
  const modelHandler = services.modelCell.handler;
  const thinking = modelHandler.processThinkingBlock(response, workspace);
  const useStreaming = modelHandler.getStreamingConfig();
  const { text, usage, stopReason } = modelHandler.extractResponse(
    response,
    endTag,
  );

  let normalizedUsage: NormalizedUsage | undefined;
  if (usage != null || options.normalizeNullUsage === true) {
    normalizedUsage = modelHandler.normalizeUsage(usage, responseTimeMs ?? 0);
    if (normalizedUsage) {
      const usageRoute =
        normalizedUsage.usageRoute ??
        modelHandler.getLastCredentialUsageRoute();
      if (usageRoute !== undefined) {
        normalizedUsage = { ...normalizedUsage, usageRoute };
      }
      const { inputTokens } = normalizedUsage;
      const contextWindow = modelHandler.getEffectiveContextWindow();
      if (inputTokens > 0 && contextWindow > 0) {
        logContextStateSnapshot(logger, inputTokens, contextWindow);
      }
    }
  }

  return { text, usage, stopReason, thinking, useStreaming, normalizedUsage };
}
