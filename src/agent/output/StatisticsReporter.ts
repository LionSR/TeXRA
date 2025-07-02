import { AgentLogger } from '@logger/AgentLogger';
import { emitProgress } from '@eventBus/ProgressEventBus';
import { AgentStateGlobal } from '@agent/core/AgentState';
import type { IModelHandler } from '@agent/modelHandlers';
import {
  ExtendedCompletionUsage,
  AnthropicUsage,
  GenerateContentResponseUsageMetadata,
} from '@agent/core/ResponseUsage';
import { ResponseUsage } from 'openai/resources/responses/responses';
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/modelHandlerOpenAIResponse';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import { objectToLogString } from '@utils/text/stringUtils';

export class StatisticsReporter {
  constructor(
    private readonly modelHandler: IModelHandler,
    private readonly channel: string,
    private readonly logger: AgentLogger,
  ) {}

  async printStatistics(
    stateGlobal: AgentStateGlobal,
    groupId?: string,
  ): Promise<void> {
    const statsGroupId = groupId ?? this.logger.getActiveGroupId();

    try {
      const usageSummary: any = {
        inputTokens:
          stateGlobal.totalInputTokens +
          (stateGlobal.totalCacheCreationInputTokens ?? 0),
        outputTokens: stateGlobal.totalOutputTokens,
        cost: 0,
      };

      if (
        this.modelHandler.capabilities.supportsPromptCaching ||
        this.modelHandler.capabilities.supportsAutoPromptCaching
      ) {
        usageSummary.cacheReadTokens = stateGlobal.totalCacheReadInputTokens;
        if (this.modelHandler.capabilities.supportsPromptCaching) {
          usageSummary.cacheCreateTokens =
            stateGlobal.totalCacheCreationInputTokens;
        }
      }

      if (this.modelHandler.capabilities.supportsReasoning) {
        usageSummary.reasoningTokens = stateGlobal.totalReasoningTokens;
      }

      if (stateGlobal.totalToolUseTokens > 0) {
        usageSummary.toolUseTokens = stateGlobal.totalToolUseTokens;
      }

      let responseUsage:
        | ExtendedCompletionUsage
        | AnthropicUsage
        | GenerateContentResponseUsageMetadata
        | ResponseUsage = {} as any;

      if (this.modelHandler instanceof ModelHandlerOpenAIResponse) {
        responseUsage = {
          input_tokens: stateGlobal.totalInputTokens,
          output_tokens: stateGlobal.totalOutputTokens,
          total_tokens:
            stateGlobal.totalInputTokens + stateGlobal.totalOutputTokens,
          input_tokens_details: {
            cached_tokens: stateGlobal.totalCacheReadInputTokens,
          },
          output_tokens_details: {
            reasoning_tokens: stateGlobal.totalReasoningTokens,
          },
        };
      } else if (this.modelHandler.isOpenai) {
        if (this.modelHandler.capabilities.supportsAutoPromptCaching) {
          responseUsage = {
            prompt_tokens: stateGlobal.totalInputTokens,
            completion_tokens: stateGlobal.totalOutputTokens,
            total_tokens:
              stateGlobal.totalInputTokens + stateGlobal.totalOutputTokens,
            prompt_tokens_details: {
              cached_tokens: stateGlobal.totalCacheReadInputTokens,
            },
            completion_tokens_details: {
              reasoning_tokens: stateGlobal.totalReasoningTokens,
            },
          };
        } else {
          responseUsage = {
            prompt_tokens: stateGlobal.totalInputTokens,
            completion_tokens: stateGlobal.totalOutputTokens,
            total_tokens:
              stateGlobal.totalInputTokens + stateGlobal.totalOutputTokens,
            reasoning_tokens: stateGlobal.totalReasoningTokens,
            cached_tokens: stateGlobal.totalCacheReadInputTokens,
          } as ExtendedCompletionUsage;
        }
      } else if (this.modelHandler.isAnthropic) {
        responseUsage = {
          input_tokens: stateGlobal.totalInputTokens,
          output_tokens: stateGlobal.totalOutputTokens,
          cache_read_input_tokens: stateGlobal.totalCacheReadInputTokens,
          cache_creation_input_tokens:
            stateGlobal.totalCacheCreationInputTokens,
          server_tool_use: null,
          service_tier: null,
        };
      } else if (this.modelHandler.isGoogle) {
        responseUsage = {
          promptTokenCount: stateGlobal.totalInputTokens,
          candidatesTokenCount: stateGlobal.totalOutputTokens,
          toolUsePromptTokenCount: stateGlobal.totalToolUseTokens,
          thoughtsTokenCount: stateGlobal.totalReasoningTokens,
          cachedContentTokenCount: stateGlobal.totalCacheReadInputTokens,
        };
      }

      const cost = this.modelHandler.computePrice(responseUsage);

      usageSummary.cost = cost;
      usageSummary.responseTime = stateGlobal.totalResponseTime;

      if (statsGroupId) {
        emitProgress('updateGroupUsage', {
          stream: this.channel,
          groupId: statsGroupId,
          usage: {
            inputTokens: usageSummary.inputTokens,
            outputTokens: usageSummary.outputTokens,
            cost,
          },
        });
      }

      this.logger.info(
        objectToLogString(usageSummary),
        statsGroupId,
        MESSAGE_TYPES.STATISTICS,
      );
    } catch (error) {
      this.logger.error(`Error printing statistics: ${error}`, statsGroupId);
    }
  }
}
