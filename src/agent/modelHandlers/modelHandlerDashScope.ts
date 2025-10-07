// Standard library imports
// (none needed)

// Third-party imports
import OpenAI from 'openai';

// Local imports - agent components
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import { MediaEntry } from '@agent/utils/mediaTypes';

// Local imports - utilities
import type { ToolDefinition } from '@model';

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
    const processedMessages = this.prepareNormalizedMessages(
      messages,
      {
        convertContentToString: true,
      },
      'DashScope',
    );

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
