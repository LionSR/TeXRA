// Third-party imports
import { ResponseUsage } from 'openai/resources/responses/responses';

// Local imports - agent
import { AgentStateGlobal } from '@agent/core/AgentState';
import {
  ExtendedCompletionUsage,
  AnthropicUsage,
  GenerateContentResponseUsageMetadata,
} from '@agent/core/ResponseUsage';
import type { IModelHandler } from '@agent/modelHandlers';
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/modelHandlerOpenAIResponse';
import type {
  TokenUsageStats,
  ExtendedTokenUsageStats,
} from '@agent/types/UsageTypes';
import { bus } from '@eventBus/ProgressEventBus';
// Local imports - log
import { AgentLogger } from '@logger/AgentLogger';

/**
 * Handles recording usage statistics to the log and progress view.
 */
export class UsageMonitor {
  constructor(
    private readonly modelHandler: IModelHandler,
    private readonly channel: string,
    private readonly logger: AgentLogger,
  ) {}

  async recordUsage(
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
          cache_creation: null,
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

      const cachingStats =
        this.modelHandler.capabilities.supportsPromptCaching ||
        this.modelHandler.capabilities.supportsAutoPromptCaching;

      const totalCacheableTokens = cachingStats
        ? this.modelHandler.capabilities.supportsPromptCaching
          ? stateGlobal.totalCacheCreationInputTokens +
            stateGlobal.totalCacheReadInputTokens
          : stateGlobal.totalInputTokens
        : 0;

      const percentageCached = cachingStats
        ? totalCacheableTokens > 0
          ? (stateGlobal.totalCacheReadInputTokens / totalCacheableTokens) * 100
          : 0
        : undefined;

      const baseStats: TokenUsageStats = {
        inputTokens: stateGlobal.totalInputTokens,
        outputTokens: stateGlobal.totalOutputTokens,
        cost: Number(cost.toFixed(3)),
      };

      const payload: ExtendedTokenUsageStats = {
        ...baseStats,
        elapsedTime: Number(stateGlobal.totalResponseTime.toFixed(1)),
        ...(cachingStats && {
          cacheReadInputTokens: stateGlobal.totalCacheReadInputTokens,
          ...(this.modelHandler.capabilities.supportsPromptCaching && {
            cacheCreationInputTokens: stateGlobal.totalCacheCreationInputTokens,
          }),
          percentageCached: Number((percentageCached ?? 0).toFixed(2)),
        }),
        ...(this.modelHandler.capabilities.supportsReasoning && {
          reasoningTokens: stateGlobal.totalReasoningTokens,
        }),
        ...(stateGlobal.totalToolUseTokens > 0 && {
          toolUseTokens: stateGlobal.totalToolUseTokens,
        }),
      };

      this.logger.statistics(payload);
    } catch (error) {
      this.logger.error(`Error printing statistics: ${error}`, statsGroupId);
    }
  }
}
