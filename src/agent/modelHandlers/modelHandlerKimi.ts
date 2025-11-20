// (none needed)

// Third-party imports
import OpenAI from 'openai';

// Local imports - agent
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { MediaEntry } from '@agent/utils/mediaTypes';
import { formatProviderHttpError } from '@common/errors/sdkErrorUtils';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import { K_SLICE } from '@utils/config';
import { BaseReasoningStreamAggregator } from './BaseReasoningStreamAggregator';
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import { toOpenAITools } from './toolConversion';
import type { CreateResponseOptions } from './types/IModelHandler';
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import type { ContentDeltaEvent } from 'openai/lib/ChatCompletionStream';

// Internal imports

// Local file imports

/**
 * Handler for Moonshot Kimi models using OpenAI-compatible API.
 */
export class ModelHandlerKimi extends ModelHandlerOpenAI {
  protected createStreamingAggregator(): BaseReasoningStreamAggregator | null {
    // Use aggregator for thinking models to properly reconstruct the response
    const isThinkingModel =
      this.config.capabilities.supportsReasoning ||
      this.capabilities.supportsReasoning;
    return isThinkingModel ? new BaseReasoningStreamAggregator() : null;
  }
  /**
   * Get the base URL for the Moonshot API.
   * The Moonshot API has a different base URL than OpenAI.
   */
  getBaseUrl(): string {
    return 'https://api.moonshot.cn/v1';
  }

  /**
   * Process thinking blocks for Moonshot models
   * @param responseObject The raw response object from the model
   * @param workspaceState Optional workspaceState to update with the thinking block
   * @returns The extracted reasoning_content or null if none
   */
  processThinkingBlock(
    responseObject: any,
    workspaceState?: AgentWorkspaceState,
  ): string | null {
    if (!responseObject) {
      return null;
    }

    // Extract reasoning content from Moonshot Kimi thinking model response
    let reasoningContent = null;

    if (
      responseObject.choices &&
      responseObject.choices.length > 0 &&
      responseObject.choices[0].message
    ) {
      const message = responseObject.choices[0].message;

      if (message.reasoning_content) {
        reasoningContent = message.reasoning_content;
        this.logger.debug(
          'Found reasoning_content in choices[0].message.reasoning_content',
        );

        // If workspaceState is provided and we have reasoning content,
        // store it in the workspaceState for future use (similar to Anthropic thinking blocks)
        if (workspaceState && !workspaceState.reasoning.thinkingAdded) {
          // Create a thinking block in the same format as Anthropic for consistency
          const thinkingBlock = {
            type: 'thinking',
            thinking: reasoningContent,
          };

          workspaceState.reasoning.thinkingBlocks = [thinkingBlock];
          workspaceState.reasoning.thinkingAdded = true;
        }
      }
    }

    if (!reasoningContent) {
      return null;
    }

    // Log preview of thinking content
    this.logger.debug(
      `Kimi thinking content preview: ${reasoningContent.substring(0, K_SLICE)}...`,
    );

    return reasoningContent;
  }

  /**
   * Override createResponse to preprocess messages for Kimi models
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

      try {
        if (useStreaming) {
          // Use streaming with aggregator for thinking model
          kwargs.stream = true;
          kwargs.stream_options = { include_usage: true };

          const stream = client.chat.completions.stream(kwargs, {
            signal,
          });
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
              const reasoningContent = (
                delta as { reasoning_content?: unknown }
              ).reasoning_content;
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
            const sdkFinalResponse = await stream.finalChatCompletion();

            // Use aggregator to build the final response with all content
            const finalResponse =
              streamingAggregator.finalize(sdkFinalResponse);

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
        } else {
          // Non-streaming request
          return client.chat.completions.create(kwargs, {
            signal,
          });
        }
      } catch (err) {
        const formattedError = formatProviderHttpError(err);
        this.logger.error(
          `Error in createResponse for Kimi thinking model: ${formattedError.message}`,
          {
            messageType: MESSAGE_TYPES.PROGRESS_STATUS,
            data: formattedError,
          },
        );
        throw err;
      }
    }

    // For regular Kimi models, call the parent implementation
    return super.createResponse({
      ...options,
      messages: processedMessages,
    });
  }

  /**
   * Creates media content formatted for Kimi models
   * Overrides the parent method to handle Kimi-specific formatting
   */
  createMediaContent(mediaMessage: MediaEntry[]): any[] {
    return mediaMessage.flatMap((media): any[] => {
      if (media.media_category === 'image') {
        return this.buildStandardVisionParts(media);
      } else {
        this.logger.warn(
          `Unsupported media category for Kimi: ${media.media_category}`,
        );
        return [];
      }
    });
  }
}
