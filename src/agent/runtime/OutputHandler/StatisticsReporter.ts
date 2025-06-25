import { AgentLogger } from '@logger/AgentLogger';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import { AgentStateGlobal } from '@agent/core/AgentState';

export class StatisticsReporter {
  constructor(
    private readonly modelHandler: any,
    private readonly channel: string,
    private readonly logger: AgentLogger,
  ) {}

  async printStatistics(
    stateGlobal: AgentStateGlobal,
    groupId?: string,
  ): Promise<void> {
    const statsGroupId = groupId ?? this.logger.getActiveGroupId();

    try {
      this.logger.debug('=== Task Statistics ===', statsGroupId);
      this.logger.debug(
        `Total input tokens  : ${stateGlobal.totalInputTokens}`,
        statsGroupId,
      );
      this.logger.debug(
        `Total output tokens : ${stateGlobal.totalOutputTokens}`,
        statsGroupId,
      );

      if (
        this.modelHandler.capabilities.supportsPromptCaching ||
        this.modelHandler.capabilities.supportsAutoPromptCaching
      ) {
        this.logger.debug(
          `Total input tokens (cache read): ${stateGlobal.totalCacheReadInputTokens}`,
          statsGroupId,
        );

        if (this.modelHandler.capabilities.supportsPromptCaching) {
          this.logger.debug(
            `Total input tokens (cache create): ${stateGlobal.totalCacheCreationInputTokens}`,
            statsGroupId,
          );
        }

        let totalCacheableTokens: number;
        if (this.modelHandler.capabilities.supportsPromptCaching) {
          totalCacheableTokens =
            stateGlobal.totalCacheCreationInputTokens +
            stateGlobal.totalCacheReadInputTokens;
        } else {
          totalCacheableTokens = stateGlobal.totalInputTokens;
        }

        const percentageCached =
          totalCacheableTokens > 0
            ? (stateGlobal.totalCacheReadInputTokens / totalCacheableTokens) *
              100
            : 0;
        this.logger.debug(
          `Percentage cached: ${percentageCached.toFixed(2)}%`,
          statsGroupId,
        );
      }

      if (this.modelHandler.capabilities.supportsReasoning) {
        this.logger.debug(
          `Total reasoning tokens: ${stateGlobal.totalReasoningTokens}`,
          statsGroupId,
        );
      }

      if (stateGlobal.totalToolUseTokens > 0) {
        this.logger.debug(
          `Total tool use tokens: ${stateGlobal.totalToolUseTokens}`,
          statsGroupId,
        );
      }

      let responseUsage: any = {};
      if (this.modelHandler.isOpenai) {
        if (this.modelHandler.capabilities.supportsAutoPromptCaching) {
          responseUsage = {
            prompt_tokens: stateGlobal.totalInputTokens,
            completion_tokens: stateGlobal.totalOutputTokens,
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
            reasoning_tokens: stateGlobal.totalReasoningTokens,
            cached_tokens: stateGlobal.totalCacheReadInputTokens,
          };
        }
      } else if (this.modelHandler.isAnthropic) {
        responseUsage = {
          input_tokens: stateGlobal.totalInputTokens,
          output_tokens: stateGlobal.totalOutputTokens,
          cache_read_input_tokens: stateGlobal.totalCacheReadInputTokens,
          cache_creation_input_tokens:
            stateGlobal.totalCacheCreationInputTokens,
        };
      } else if (this.modelHandler.isGoogle) {
        responseUsage = {
          promptTokens: stateGlobal.totalInputTokens,
          completionTokens: stateGlobal.totalOutputTokens,
          toolUseTokenCount: stateGlobal.totalToolUseTokens,
        };
      }

      const cost = this.modelHandler.computePrice(responseUsage);

      const provider = ProgressViewProvider.getInstance();
      if (provider && statsGroupId) {
        provider.updateGroupUsage(this.channel, statsGroupId, {
          inputTokens:
            stateGlobal.totalInputTokens +
            (stateGlobal.totalCacheCreationInputTokens ?? 0),
          outputTokens: stateGlobal.totalOutputTokens,
          cost,
        });
      }

      this.logger.debug(
        `Total response time : ${stateGlobal.totalResponseTime.toFixed(1)} seconds`,
        statsGroupId,
      );
      this.logger.debug(
        `Total cost          : ${cost.toFixed(3)} USD`,
        statsGroupId,
      );
      this.logger.debug('=======================', statsGroupId);
    } catch (error) {
      this.logger.error(`Error printing statistics: ${error}`, statsGroupId);
    }
  }
}
