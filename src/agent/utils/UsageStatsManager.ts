// Local imports
import { bus } from '@eventBus/ProgressEventBus';
import { AgentStateGlobal } from '@agent/core/AgentState';
import type { IModelHandler } from '@agent/modelHandlers';
import { AgentLogger } from '@logger/AgentLogger';
import {
  ExtendedCompletionUsage,
  AnthropicUsage,
  GenerateContentResponseUsageMetadata,
} from '@agent/core/ResponseUsage';
import { ResponseUsage } from 'openai/resources/responses/responses';
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/modelHandlerOpenAIResponse';

/**
 * Manages usage statistics reporting for agent runs.
 * Computes token costs using the provided model handler.
 */
export class UsageStatsManager {
  constructor(
    private readonly modelHandler: IModelHandler,
    private readonly logger: AgentLogger,
  ) {}

  /**
   * Report token usage statistics for a completed round.
   */
  reportStatistics(
    state: AgentStateGlobal,
    channel: string,
    groupId?: string,
  ): void {
    const statsGroupId = groupId ?? this.logger.getActiveGroupId();

    try {
      let responseUsage:
        | ExtendedCompletionUsage
        | AnthropicUsage
        | GenerateContentResponseUsageMetadata
        | ResponseUsage = {} as any;

      if (this.modelHandler instanceof ModelHandlerOpenAIResponse) {
        responseUsage = {
          input_tokens: state.totalInputTokens,
          output_tokens: state.totalOutputTokens,
          total_tokens: state.totalInputTokens + state.totalOutputTokens,
          input_tokens_details: {
            cached_tokens: state.totalCacheReadInputTokens,
          },
          output_tokens_details: {
            reasoning_tokens: state.totalReasoningTokens,
          },
        };
      } else if (this.modelHandler.isOpenai) {
        if (this.modelHandler.capabilities.supportsAutoPromptCaching) {
          responseUsage = {
            prompt_tokens: state.totalInputTokens,
            completion_tokens: state.totalOutputTokens,
            total_tokens: state.totalInputTokens + state.totalOutputTokens,
            prompt_tokens_details: {
              cached_tokens: state.totalCacheReadInputTokens,
            },
            completion_tokens_details: {
              reasoning_tokens: state.totalReasoningTokens,
            },
          };
        } else {
          responseUsage = {
            prompt_tokens: state.totalInputTokens,
            completion_tokens: state.totalOutputTokens,
            total_tokens: state.totalInputTokens + state.totalOutputTokens,
            reasoning_tokens: state.totalReasoningTokens,
            cached_tokens: state.totalCacheReadInputTokens,
          } as ExtendedCompletionUsage;
        }
      } else if (this.modelHandler.isAnthropic) {
        responseUsage = {
          input_tokens: state.totalInputTokens,
          output_tokens: state.totalOutputTokens,
          cache_read_input_tokens: state.totalCacheReadInputTokens,
          cache_creation_input_tokens: state.totalCacheCreationInputTokens,
          server_tool_use: null,
          service_tier: null,
        };
      } else if (this.modelHandler.isGoogle) {
        responseUsage = {
          promptTokenCount: state.totalInputTokens,
          candidatesTokenCount: state.totalOutputTokens,
          toolUsePromptTokenCount: state.totalToolUseTokens,
          thoughtsTokenCount: state.totalReasoningTokens,
          cachedContentTokenCount: state.totalCacheReadInputTokens,
        };
      }

      const cost = this.modelHandler.computePrice(responseUsage);

      if (statsGroupId) {
        bus.emit('updateGroupUsage', {
          stream: channel,
          groupId: statsGroupId,
          usage: {
            inputTokens:
              state.totalInputTokens +
              (state.totalCacheCreationInputTokens ?? 0),
            outputTokens: state.totalOutputTokens,
            cost,
          },
        });
      }

      const payload: Record<string, number> = {
        inputTokens: state.totalInputTokens,
        outputTokens: state.totalOutputTokens,
        elapsedTime: Number(state.totalResponseTime.toFixed(1)),
        cost: Number(cost.toFixed(3)),
      };

      if (
        this.modelHandler.capabilities.supportsPromptCaching ||
        this.modelHandler.capabilities.supportsAutoPromptCaching
      ) {
        payload.cacheReadInputTokens = state.totalCacheReadInputTokens;

        if (this.modelHandler.capabilities.supportsPromptCaching) {
          payload.cacheCreationInputTokens =
            state.totalCacheCreationInputTokens;
        }

        const totalCacheableTokens = this.modelHandler.capabilities
          .supportsPromptCaching
          ? state.totalCacheCreationInputTokens +
            state.totalCacheReadInputTokens
          : state.totalInputTokens;

        const percentageCached =
          totalCacheableTokens > 0
            ? (state.totalCacheReadInputTokens / totalCacheableTokens) * 100
            : 0;

        payload.percentageCached = Number(percentageCached.toFixed(2));
      }

      if (this.modelHandler.capabilities.supportsReasoning) {
        payload.reasoningTokens = state.totalReasoningTokens;
      }

      if (state.totalToolUseTokens > 0) {
        payload.toolUseTokens = state.totalToolUseTokens;
      }

      this.logger.statistics(payload, statsGroupId);
    } catch (error) {
      this.logger.error(`Error reporting statistics: ${error}`, statsGroupId);
    }
  }
}
