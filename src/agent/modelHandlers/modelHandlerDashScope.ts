// (none needed)

// Third-party imports
import OpenAI from 'openai';

// Local imports - agent components
import { MediaEntry } from '@agent/utils/mediaTypes';

// Local file imports
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import type { CreateResponseOptions } from './types/IModelHandler';
import type {
  ChatCompletion,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';

/**
 * Handler for DashScope Qwen models using OpenAI-compatible API.
 */
export class ModelHandlerDashScope extends ModelHandlerOpenAI {
  /** Thinking blocks are handled by the base OpenAI handler. */
  /**
   * Override createResponse to preprocess messages for DashScope models
   */
  async createResponse(
    options: CreateResponseOptions<ChatCompletionMessageParam, OpenAI>,
  ): Promise<ChatCompletion> {
    const { messages } = options;
    // Preprocess messages for DashScope compatibility
    const processedMessages = this.prepareNormalizedMessages(
      messages,
      {
        convertContentToString: true,
      },
      'DashScope',
    );

    // Call the parent implementation with the processed messages
    return super.createResponse({
      ...options,
      messages: processedMessages,
    });
  }

  /**
   * Creates media content formatted for DashScope Qwen-VL models
   * Overrides the parent method to handle DashScope-specific formatting
   */
  createMediaContent(mediaMessage: MediaEntry[]): any[] {
    return mediaMessage.flatMap((media): any[] => {
      if (media.media_category === 'image') {
        return this.buildStandardVisionParts(media);
      } else {
        this.logger.warn(
          `Unsupported media category for DashScope: ${media.media_category}`,
        );
        return [];
      }
    });
  }
}
