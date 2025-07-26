// Local imports - log
import { AgentLogger } from '@logger/AgentLogger';
import { bus } from '@eventBus/ProgressEventBus';
import { AgentStateGlobal } from '@agent/core/AgentState';
import type { IModelHandler } from '@agent/modelHandlers';
import {
  ExtendedCompletionUsage,
  AnthropicUsage,
  GenerateContentResponseUsageMetadata,
} from '@agent/core/ResponseUsage';
import { ResponseUsage } from 'openai/resources/responses/responses';
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/modelHandlerOpenAIResponse';

/**
 * Handles printing usage statistics to the log and progress view.
 */
export class UsageStatsManager {
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

      if (statsGroupId) {
        bus.emit('updateGroupUsage', {
          stream: this.channel,
          groupId: statsGroupId,
          usage: {
            inputTokens:
              stateGlobal.totalInputTokens +
              (stateGlobal.totalCacheCreationInputTokens ?? 0),
            outputTokens: stateGlobal.totalOutputTokens,
            cost,
          },
        });
      }

      const payload: Record<string, number> = {
        inputTokens: stateGlobal.totalInputTokens,
        outputTokens: stateGlobal.totalOutputTokens,
        elapsedTime: Number(stateGlobal.totalResponseTime.toFixed(1)),
        cost: Number(cost.toFixed(3)),
      };

      if (
        this.modelHandler.capabilities.supportsPromptCaching ||
        this.modelHandler.capabilities.supportsAutoPromptCaching
      ) {
        payload.cacheReadInputTokens = stateGlobal.totalCacheReadInputTokens;

        if (this.modelHandler.capabilities.supportsPromptCaching) {
          payload.cacheCreationInputTokens =
            stateGlobal.totalCacheCreationInputTokens;
        }

        const totalCacheableTokens = this.modelHandler.capabilities
          .supportsPromptCaching
          ? stateGlobal.totalCacheCreationInputTokens +
            stateGlobal.totalCacheReadInputTokens
          : stateGlobal.totalInputTokens;

        const percentageCached =
          totalCacheableTokens > 0
            ? (stateGlobal.totalCacheReadInputTokens / totalCacheableTokens) *
              100
            : 0;

        payload.percentageCached = Number(percentageCached.toFixed(2));
      }

      if (this.modelHandler.capabilities.supportsReasoning) {
        payload.reasoningTokens = stateGlobal.totalReasoningTokens;
      }

      if (stateGlobal.totalToolUseTokens > 0) {
        payload.toolUseTokens = stateGlobal.totalToolUseTokens;
      }

      this.logger.statistics(payload, statsGroupId);
    } catch (error) {
      this.logger.error(`Error printing statistics: ${error}`, statsGroupId);
    }
  }
}
