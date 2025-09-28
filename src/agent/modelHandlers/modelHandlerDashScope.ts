// Standard library imports
// (none needed)

// Third-party imports
import OpenAI from 'openai';

// Local imports - agent components
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import { MediaEntry } from '@agent/utils/mediaTypes';

// Local imports - utilities
import type { ToolDefinition } from '@model';
import { MESSAGE_PREVIEW_LENGTH } from '@utils/config';

/**
 * Handler for DashScope Qwen models using OpenAI-compatible API.
 */
export class ModelHandlerDashScope extends ModelHandlerOpenAI {
  /** Thinking blocks are handled by the base OpenAI handler. */
  /**
   * Override createResponse to preprocess messages for DashScope models
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
    // Preprocess messages for DashScope compatibility
    const processedMessages = this.normalizeMessages(messages, {
      convertContentToString: true,
    });

    if (processedMessages.length !== messages.length) {
      this.logger.info(
        `Preprocessed message array from ${messages.length} to ${processedMessages.length} messages for DashScope model compatibility`,
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

    // Call the parent implementation with the processed messages
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
   * Creates media content formatted for DashScope Qwen-VL models
   * Overrides the parent method to handle DashScope-specific formatting
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
          `Unsupported media category for DashScope: ${media.media_category}`,
        );
        return [];
      }
    });
  }
}
