// Standard library imports
// (none needed)

// Third-party imports
import OpenAI from 'openai';

// Local imports - agent components
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import { ToolState } from './ToolState';

// Local imports - utilities
import { convertContentToString } from '../utils/messageUtils';
import { MESSAGE_PREVIEW_LENGTH } from '../utils/constants';

/**
 * Handler for DashScope Qwen models using OpenAI-compatible API.
 */
export class ModelHandlerDashScope extends ModelHandlerOpenAI {
  /** Returns OpenAI client configured with DashScope's base URL. */
  async getClient(): Promise<OpenAI> {
    const apiKey = await this.getApiKey();
    const baseURL = this.getBaseUrl();
    this.logger.debug(`Using DashScope API key. Base URL: ${baseURL}`);
    return new OpenAI({ apiKey, baseURL });
  }

  /**
   * Process thinking blocks for DashScope models
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
    // DashScope Qwen models don't currently support thinking blocks
    return null;
  }

  /**
   * Preprocess messages array for DashScope Qwen models
   * Ensures compatibility with Qwen API format requirements
   * @param messages Original messages array
   * @returns Processed messages array
   */
  private preprocessMessages(messages: any[]): any[] {
    if (!messages || messages.length <= 1) {
      return messages;
    }

    // Process messages to ensure compatibility with DashScope API
    const processedMessages = messages.map((message) => {
      // Clone the message to avoid modifying the original
      const processedMessage = { ...message };

      // Convert content to string if it's an array
      if (Array.isArray(processedMessage.content)) {
        processedMessage.content = convertContentToString(
          processedMessage.content,
        );
        this.logger.debug(
          `Converted content array to string for ${processedMessage.role} message`,
        );
      }

      return processedMessage;
    });

    return processedMessages;
  }

  /**
   * Override createResponse to preprocess messages for DashScope models
   */
  async createResponse(
    client: OpenAI,
    messages: any[],
    temperature: number,
    systemPrompt?: string,
    endTag?: string,
  ): Promise<any> {
    // Preprocess messages for DashScope compatibility
    const processedMessages = this.preprocessMessages(messages);

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
    );
  }

  /**
   * Creates media content formatted for DashScope Qwen-VL models
   * Overrides the parent method to handle DashScope-specific formatting
   */
  createMediaContent(mediaMessage: any[]): any[] {
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
