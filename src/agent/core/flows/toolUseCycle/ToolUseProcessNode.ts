// Local imports - core flow primitives
import { BaseNode } from '@agent/node';
import { logWebFetch, logWebSearch } from '@agent/trace';
import { recordCycleMetrics } from '@agent/core/execution/AgentState';
import { extractModelResponse } from '@agent/core/flows/CommonCycleTypes';
import type { SdkToolCall } from '@agent/modelHandlers/types/IModelHandler';
import type { ServerToolContentBlock } from '@agent/modelHandlers/types/ServerToolTypes';
import type { ProviderStopReason } from '@agent/modelHandlers/types/StopReasonTypes';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';

// Local imports - logging
import { MESSAGE_TYPES } from '@shared/schemas';
import { isNonEmptyString } from '@utils/core';
import { formatContent } from '@utils/text/xmlUtils';

// Local file imports
import { FlowTransition } from '../FlowTransitions';
import type { CycleParams, ToolUseCycleServices } from '../CycleServices';
import type { ToolUseCycleShared } from './cycleShared';

/** Result of exec() containing extracted data needed for post() side effects. */
type ToolUseProcessExecResult =
  | { kind: 'skipped' }
  | {
      kind: 'success';
      toolCalls?: SdkToolCall[];
      stopReason?: ProviderStopReason;
      text?: string;
      endTurn: boolean;
      serverToolContentBlocks?: ServerToolContentBlock[];
      lastAssistantContent?: unknown[];
      normalizedUsage?: NormalizedUsage;
    };

/** Prep result for ToolUseProcessNode - captures shared state snapshot for exec. */
interface ToolUseProcessPrepResult {
  shouldStop: boolean;
  response?: unknown;
  responseTimeMs?: number;
}

/** Processes the model response to extract tool calls and usage data. */
export class ToolUseProcessNode<C> extends BaseNode<
  ToolUseCycleShared,
  CycleParams,
  ToolUseCycleServices<C>
> {
  async prep(shared: ToolUseCycleShared): Promise<ToolUseProcessPrepResult> {
    return {
      shouldStop: shared.shouldStop,
      response: shared.response,
      responseTimeMs: shared.responseTimeMs,
    };
  }

  async exec(
    prepRes: ToolUseProcessPrepResult,
  ): Promise<ToolUseProcessExecResult> {
    if (prepRes.shouldStop || !prepRes.response) {
      return { kind: 'skipped' };
    }

    const services = this.services;

    const { text, stopReason, thinking, useStreaming, normalizedUsage } =
      extractModelResponse(
        prepRes.response,
        prepRes.responseTimeMs,
        '',
        services,
      );

    if (thinking && !useStreaming) {
      const formatted = await formatContent(thinking);
      if (isNonEmptyString(formatted)) {
        services.logger.info(formatted, {
          messageType: MESSAGE_TYPES.THINKING,
        });
      }
    }

    const toolCalls = services.modelHandler.extractToolUse(prepRes.response);
    const serverToolData = services.modelHandler.extractServerToolData(
      prepRes.response,
    );

    if (!useStreaming) {
      for (const searchResult of serverToolData.webSearchResults) {
        logWebSearch(services.logger, searchResult);
      }
      for (const fetchResult of serverToolData.webFetchResults) {
        logWebFetch(services.logger, fetchResult);
      }
    }

    const lastAssistantContent = services.modelHandler.extractAssistantContent(
      prepRes.response,
    );

    if (text) {
      services.logger.debug(`Model response: ${text.slice(0, 100)}`);
      if (!useStreaming) {
        const formatted = await formatContent(text);
        services.logger.info(formatted, {
          messageType: MESSAGE_TYPES.MODEL_RESPONSE,
        });
      }
    }

    const endTurn =
      services.modelHandler.isEndTurnStop(stopReason) || !toolCalls?.length;

    return {
      kind: 'success',
      toolCalls: endTurn ? undefined : toolCalls,
      stopReason,
      text: text ?? undefined,
      endTurn,
      serverToolContentBlocks: serverToolData.contentBlocks,
      lastAssistantContent,
      normalizedUsage,
    };
  }

  async post(
    shared: ToolUseCycleShared,
    prepRes: ToolUseProcessPrepResult,
    execRes: ToolUseProcessExecResult,
  ): Promise<string | undefined> {
    const { run, workspace, onRoundFinalized, modelHandler } = this.services;

    if (execRes.kind === 'skipped') {
      return FlowTransition.COMPLETE;
    }

    workspace.serverToolContent.contentBlocks =
      execRes.serverToolContentBlocks ?? [];
    workspace.serverToolContent.lastAssistantContent =
      execRes.lastAssistantContent ?? [];

    if (shared.responseTimeMs != null) {
      shared.cycleResponseTimeMs += shared.responseTimeMs;
    }
    if (execRes.normalizedUsage) {
      shared.cycleNormalizedUsage = execRes.normalizedUsage;
    }

    recordCycleMetrics(
      run,
      shared.cycleIndex,
      shared.cycleResponseTimeMs,
      shared.cycleNormalizedUsage ?? null,
    );
    await onRoundFinalized?.(run);
    run.totalRounds += 1;

    shared.stopReason = execRes.stopReason;

    if (execRes.endTurn) {
      shared.toolCalls = undefined;
      shared.shouldStop = true;
      shared.endTurn = true;
      if (execRes.text) {
        shared.messages.push(
          modelHandler.createAssistantMessageFromResponse(
            prepRes.response,
            execRes.text,
          ),
        );
        workspace.assembly.lastResponse = execRes.text;
      }
      workspace.resetServerToolContent();
      workspace.resetReasoning();
      return FlowTransition.COMPLETE;
    }

    shared.toolCalls = execRes.toolCalls;
    shared.text = execRes.text;
    shared.cycleIndex += 1;
    shared.cycleResponseTimeMs = 0;
    shared.cycleNormalizedUsage = undefined;
    return FlowTransition.DEFAULT;
  }
}
