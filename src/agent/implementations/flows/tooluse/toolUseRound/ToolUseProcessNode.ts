// Local imports
import { BaseNode } from '@agent/node';
import { logWebFetch, logWebSearch } from '@agent/trace';
import { recordCycleMetrics } from '@agent/core/state/AgentState';
import { extractModelResponse } from '@agent/core/flows/CommonCycleTypes';
import { appendFollowUpAsUserMessage } from '@agent/followUp/followUpMessages';
import type { SdkToolCall } from '@agent/types/ModelHandlerContracts';
import type { ProviderMessage } from '@agent/types/ProviderMessage';
import type { ServerToolContentBlock } from '@agent/types/ServerTools';
import type { ProviderStopReason } from '@agent/types/StopReasonTypes';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import type { ToolUseRoundServices } from '@agent/core/flows/CycleServices';
import { MESSAGE_TYPES } from '@shared/schemas';
import { isNonEmptyString, isObject } from '@utils/core';
import { formatContent } from '@utils/text/xmlConversion';

// Local file imports
import type { ToolUseRoundShared } from './roundShared';

const BLANK_TOOL_RESULT_CONTINUATION =
  'The previous assistant turn after a tool result was blank. Continue now with the final answer or next required action.';
const FINAL_TOOL_INSTRUCTION = 'Submit the final structured output now.';

function hasToolResultContent(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((item) => {
    if (!isObject(item)) return false;
    return (
      item.type === 'tool_result' ||
      item.kind === 'toolResult' ||
      isObject(item.functionResponse)
    );
  });
}

function isToolResultMessage(message: ProviderMessage | undefined): boolean {
  if (!isObject(message)) return false;
  const record: Record<string, unknown> = message;

  if (
    record['type'] === 'function_call_output' ||
    record['type'] === 'function_result' ||
    record['role'] === 'tool'
  ) {
    return true;
  }

  return (
    record['role'] === 'user' &&
    (hasToolResultContent(record['content']) ||
      hasToolResultContent(record['parts']))
  );
}

/** Advance to the next round, resetting the per-round accumulators. */
function advanceRound(shared: ToolUseRoundShared): void {
  shared.roundIndex += 1;
  shared.roundResponseTimeMs = 0;
  shared.roundNormalizedUsage = undefined;
}

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
      useStreaming: boolean;
    };

/** Prep result for ToolUseProcessNode - captures shared state snapshot for exec. */
interface ToolUseProcessPrepResult {
  shouldStop: boolean;
  response?: unknown;
  responseTimeMs?: number;
}

/** Processes the model response to extract tool calls and usage data. */
export class ToolUseProcessNode<C> extends BaseNode<
  ToolUseRoundShared,
  ToolUseRoundServices<C>
> {
  async prep(shared: ToolUseRoundShared): Promise<ToolUseProcessPrepResult> {
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
    const modelHandler = services.modelCell.handler;

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

    const toolCalls = modelHandler.extractToolUse(prepRes.response);
    const serverToolData = modelHandler.extractServerToolData(prepRes.response);

    if (!useStreaming) {
      for (const searchResult of serverToolData.webSearchResults) {
        logWebSearch(services.logger, searchResult);
      }
      for (const fetchResult of serverToolData.webFetchResults) {
        logWebFetch(services.logger, fetchResult);
      }
    }

    const lastAssistantContent = modelHandler.extractAssistantContent(
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
      modelHandler.isEndTurnStop(stopReason) || !toolCalls?.length;

    return {
      kind: 'success',
      toolCalls: endTurn ? undefined : toolCalls,
      stopReason,
      text,
      endTurn,
      serverToolContentBlocks: serverToolData.contentBlocks,
      lastAssistantContent,
      normalizedUsage,
      useStreaming,
    };
  }

  async post(
    shared: ToolUseRoundShared,
    prepRes: ToolUseProcessPrepResult,
    execRes: ToolUseProcessExecResult,
  ): Promise<string | undefined> {
    const { run, workspace, onRoundFinalized, logger, finalTool } =
      this.services;
    const modelHandler = this.services.modelCell.handler;

    if (execRes.kind === 'skipped') {
      return FlowTransition.COMPLETE;
    }

    if (execRes.text) shared.latestAssistantText = execRes.text;

    // `finalTool` selects only the request whose response is being processed.
    // Keep the separate attempted bit so a malformed/ignored forced response
    // cannot force every later round or schedule a second final attempt.
    shared.finalTool = undefined;

    workspace.serverToolContent.contentBlocks =
      execRes.serverToolContentBlocks ?? [];
    workspace.serverToolContent.lastAssistantContent =
      execRes.lastAssistantContent ?? [];

    if (shared.responseTimeMs != null) {
      shared.roundResponseTimeMs += shared.responseTimeMs;
    }
    if (execRes.normalizedUsage) {
      shared.roundNormalizedUsage = execRes.normalizedUsage;
    }

    recordCycleMetrics(
      run,
      shared.roundResponseTimeMs,
      shared.roundNormalizedUsage ?? null,
    );
    await onRoundFinalized(run);
    run.totalRounds += 1;

    shared.stopReason = execRes.stopReason;

    if (execRes.endTurn) {
      const lastMessageIndex = shared.messages.length - 1;
      const blankAfterToolResult =
        !execRes.text?.trim() && isToolResultMessage(shared.messages.at(-1));
      if (
        blankAfterToolResult &&
        shared.blankToolResultContinuationMessageIndex !== lastMessageIndex
      ) {
        const result = await appendFollowUpAsUserMessage(
          shared.messages,
          {
            text: BLANK_TOOL_RESULT_CONTINUATION,
            origin: 'synthetic',
          },
          this.services,
        );
        shared.messages = result.messages;
        shared.blankToolResultContinuationMessageIndex = lastMessageIndex;
        workspace.resetServerToolContent();
        workspace.resetReasoning();
        advanceRound(shared);
        return FlowTransition.CONTINUE;
      }

      if (execRes.text) {
        shared.messages.push(
          modelHandler.createAssistantMessageFromResponse(
            prepRes.response,
            execRes.text,
          ),
        );
        workspace.assembly.lastResponse = execRes.text;
        // A streamed MODEL_RESPONSE writes raw provider chunks in real time,
        // before replacement rules run, so its persisted transcript text can
        // differ from this authoritative post-replacement value (#7086).
        // Reconcile the two once, at the turn boundary both a mid-run WAITING
        // pause and the terminal round pass through. Non-streaming responses
        // log their own formatted MODEL_RESPONSE line in `exec()`.
        if (execRes.useStreaming) {
          logger.responseFinalized(execRes.text);
        }
      }
      workspace.resetServerToolContent();
      workspace.resetReasoning();

      if (finalTool && !shared.finalToolAttempted) {
        const result = await appendFollowUpAsUserMessage(
          shared.messages,
          { text: FINAL_TOOL_INSTRUCTION, origin: 'synthetic' },
          this.services,
        );
        shared.messages = result.messages;
        if (modelHandler.supportsForcedToolChoice) {
          shared.finalTool = finalTool;
        }
        shared.finalToolAttempted = true;
        shared.toolCalls = undefined;
        advanceRound(shared);
        return FlowTransition.CONTINUE;
      }

      shared.toolCalls = undefined;
      shared.shouldStop = true;
      shared.endTurn = true;
      return FlowTransition.COMPLETE;
    }

    shared.toolCalls = execRes.toolCalls;
    shared.text = execRes.text;
    advanceRound(shared);
    return FlowTransition.DEFAULT;
  }
}
