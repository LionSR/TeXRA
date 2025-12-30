// Third-party imports
import OpenAI from 'openai';

// Local imports - agent
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import { BaseReasoningStreamAggregator } from './BaseReasoningStreamAggregator';
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import { executeRequest } from './utils/requestExecutor';
import { toOpenAITools } from './toolConversion';
import type { CreateResponseOptions } from './types/IModelHandler';
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import type { ContentDeltaEvent } from 'openai/lib/ChatCompletionStream';

/**
 * Handler for Moonshot Kimi models using OpenAI-compatible API.
 */
export class ModelHandlerKimi extends ModelHandlerOpenAI {
  protected override get usageProvider(): NormalizedUsage['provider'] {
    return 'kimi';
  }

  protected createStreamingAggregator(): BaseReasoningStreamAggregator | null {
    // Use aggregator for thinking models to properly reconstruct the response
    const isThinkingModel =
      this.config.capabilities.supportsReasoning ||
      this.capabilities.supportsReasoning;
    return isThinkingModel ? new BaseReasoningStreamAggregator() : null;
  }
  // Note: getBaseUrl() is NOT overridden here.
  // The base ModelHandler.getBaseUrl() correctly handles:
  // - Server-side keys: routes through relay
  // - Direct access: uses BASE_URLS[MOONSHOT] = 'https://api.moonshot.cn/v1'

  /**
   * Override createResponse to preprocess messages for Kimi models.
   *
   * Note: This handler does NOT use the getMessageNormalizationOptions() hook
   * because Kimi thinking models require additional custom logic:
   * - Conditional `thinking: true` parameter
   * - Custom streaming aggregation for reasoning_content
   * - Different request structure for thinking vs regular models
   *
   * processThinkingBlock is inherited from ModelHandlerOpenAI which
   * already handles reasoning_content extraction via extractReasoningFromMessage().
   */
  async createResponse(
    options: CreateResponseOptions<ChatCompletionMessageParam, OpenAI>,
  ): Promise<ChatCompletion> {
    const { client, messages, temperature, endTag, signal, tools } = options;
    // Preprocess messages for Kimi compatibility
    const processedMessages = this.prepareNormalizedMessages(
      messages,
      {
        convertContentToString: true,
      },
      'Kimi',
    );

    // For Kimi thinking model, add the thinking parameter
    const isThinkingModel =
      this.config.capabilities.supportsReasoning ||
      this.capabilities.supportsReasoning;

    if (isThinkingModel) {
      this.logger.debug(
        'Using Kimi thinking model - adding thinking parameter',
      );

      // Check if streaming is enabled
      const useStreaming = this.getStreamingConfig();

      const kwargs: any = {
        model: this.config.fullName,
        messages: processedMessages,
        temperature: temperature,
        max_tokens: this.config.maxOutputTokens,
        thinking: true,
      };

      if (endTag) {
        kwargs.stop = [endTag];
      }

      if (tools && tools.length > 0) {
        kwargs.tools = toOpenAITools(tools);
        kwargs.tool_choice = 'auto';
      }

      if (useStreaming) {
        // Use streaming with aggregator for thinking model
        kwargs.stream = true;
        kwargs.stream_options = { include_usage: true };

        const stream = await executeRequest(
          {
            model: this.config.name,
            operation: 'kimi.chat.completions.stream',
            signal,
          },
          () => client.chat.completions.stream(kwargs, { signal }),
        );
        const thinking = this.createThinkingStream();
        const output = this.isOutputStreamingEnabled()
          ? this.createOutputStream()
          : undefined;

        // Create aggregator to properly reconstruct the final response
        const streamingAggregator = new BaseReasoningStreamAggregator();

        const onContentDelta = ({ delta }: ContentDeltaEvent): void => {
          if (!delta) {
            return;
          }
          output?.append(delta);
          streamingAggregator.appendContent(delta);
        };

        const onChunk = (chunk: ChatCompletionChunk): void => {
          streamingAggregator.consumeChunk(chunk);

          // Extract reasoning_content from the chunk delta
          const choice = chunk.choices?.[0];
          if (!choice) {
            return;
          }
          const delta = choice.delta as unknown;
          if (
            delta &&
            typeof delta === 'object' &&
            'reasoning_content' in delta
          ) {
            const reasoningContent = (delta as { reasoning_content?: unknown })
              .reasoning_content;
            const reasoningDelta =
              typeof reasoningContent === 'string' ? reasoningContent : '';
            if (reasoningDelta) {
              thinking.append(reasoningDelta);
              streamingAggregator.appendReasoning(reasoningDelta);
            }
          }
        };

        stream.on('content.delta', onContentDelta);
        stream.on('chunk', onChunk);

        try {
          const finalResponse = await this.awaitFinalResponse(
            stream,
            streamingAggregator,
          );

          const finalReasoning = this.processThinkingBlock(finalResponse);
          if (finalReasoning === null) {
            thinking.finalize();
          } else {
            thinking.finalize(finalReasoning);
          }
          const finalOutput =
            finalResponse.choices?.[0]?.message?.content ?? '';
          output?.finalize(finalOutput);
          return finalResponse;
        } finally {
          stream.off('content.delta', onContentDelta);
          stream.off('chunk', onChunk);
        }
      }

      // Non-streaming request
      return executeRequest(
        {
          model: this.config.name,
          operation: 'kimi.chat.completions.create',
          signal,
        },
        () => client.chat.completions.create(kwargs, { signal }),
      );
    }

    // For regular Kimi models, call the parent implementation
    return super.createResponse({
      ...options,
      messages: processedMessages,
    });
  }

  // Note: createMediaContent is inherited from ModelHandlerOpenAI which
  // already handles images via buildStandardVisionParts() and logs
  // appropriate warnings for unsupported media categories.
}
