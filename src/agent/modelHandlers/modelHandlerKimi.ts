// Standard library imports
// (none needed)

// Third-party imports
import OpenAI from 'openai';

// Local imports - agent
import { ToolState } from '../core/ToolState';

// Local imports - agent components
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import { OpenAIStreamDeltaAggregator } from './openAIStreamAggregators';
import { MediaEntry } from '@agent/utils/mediaTypes';

// Local imports - utilities
import { getSdkErrorMessage } from '@common/errors/sdkErrorUtils';
import type { ToolDefinition } from '@model';
import { K_SLICE, MESSAGE_PREVIEW_LENGTH } from '@utils/config';

/**
 * Handler for Moonshot Kimi models using OpenAI-compatible API.
 */
export class ModelHandlerKimi extends ModelHandlerOpenAI {
  protected override getStreamAggregator() {
    return new OpenAIStreamDeltaAggregator();
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
   * @param groupId Optional group ID for logging
   * @param toolState Optional toolState to update with the thinking block
   * @returns The extracted reasoning_content or null if none
   */
  processThinkingBlock(
    responseObject: any,
    groupId?: string,
    toolState?: ToolState,
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

      // Check for thinking_content in Kimi thinking model
      if (message.thinking_content) {
        reasoningContent = message.thinking_content;
        this.logger.debug(
          'Found thinking_content in choices[0].message.thinking_content',
          groupId,
        );

        // If toolState is provided and we have reasoning content,
        // store it in the toolState for future use (similar to Anthropic thinking blocks)
        if (toolState && !toolState.thinkingAdded) {
          // Create a thinking block in the same format as Anthropic for consistency
          const thinkingBlock = {
            type: 'thinking',
            thinking: reasoningContent,
          };

          toolState.thinkingBlocks = [thinkingBlock];
          toolState.thinkingAdded = true;
        }
      }
    }

    if (!reasoningContent) {
      return null;
    }

    // Log preview of thinking content
    this.logger.debug(
      `Kimi thinking content preview: ${reasoningContent.substring(0, K_SLICE)}...`,
      groupId,
    );

    return reasoningContent;
  }

  /**
   * Override createResponse to preprocess messages for Kimi models
   */
  async createResponse(
    client: OpenAI,
    messages: any[],
    temperature: number,
    systemPrompt?: string,
    endTag?: string,
    signal?: AbortSignal,
    tools?: ToolDefinition[],
  ): Promise<any> {
    // Preprocess messages for Kimi compatibility
    const processedMessages = this.normalizeMessages(messages, {
      convertContentToString: true,
    });

    if (processedMessages.length !== messages.length) {
      this.logger.info(
        `Preprocessed message array from ${messages.length} to ${processedMessages.length} messages for Kimi model compatibility`,
      );
    }

    // Log the first few characters of each processed message for debugging
    processedMessages.forEach((msg, index) => {
      const contentPreview =
        typeof msg.content === 'string'
          ? msg.content.substring(0, MESSAGE_PREVIEW_LENGTH)
          : 'non-string content';
      this.logger.debug(`Message ${index} (${msg.role}): ${contentPreview}...`);
    });

    // For Kimi thinking model, add the thinking parameter
    const isThinkingModel =
      this.config.name === 'kimit' ||
      (this.config.fullName && this.config.fullName.includes('thinking'));

    if (isThinkingModel) {
      this.logger.debug(
        'Using Kimi thinking model - adding thinking parameter',
      );

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

      try {
        const response = await client.chat.completions.create(kwargs, {
          signal,
        });
        return response;
      } catch (err) {
        this.logger.error(
          `Error in createResponse for Kimi thinking model: ${getSdkErrorMessage(err)}`,
          undefined,
          undefined,
          err,
        );
        throw err;
      }
    }

    // For regular Kimi models, call the parent implementation
    return super.createResponse(
      client,
      processedMessages,
      temperature,
      systemPrompt,
      endTag,
      signal,
      tools,
    );
  }

  /**
   * Creates media content formatted for Kimi models
   * Overrides the parent method to handle Kimi-specific formatting
   */
  createMediaContent(mediaMessage: MediaEntry[]): any[] {
    return mediaMessage.flatMap((media): any[] => {
      if (media.media_category === 'image') {
        return [
          { type: 'text', text: `Image: ${media.file_name}` },
          {
            type: 'image_url',
            image_url: {
              url: `data:${media.media_type};base64,${media.data}`,
            },
          },
        ];
      } else {
        this.logger.warn(
          `Unsupported media category for Kimi: ${media.media_category}`,
        );
        return [];
      }
    });
  }
}
