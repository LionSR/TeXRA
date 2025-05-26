// Standard library imports
// (none needed)

// Third-party imports
import OpenAI from 'openai';

// Local imports - agent components
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import { ToolState } from './ToolState';

// Local imports - utilities
import { convertContentToString } from '../utils/messageUtils';

/**
 * Handler for DeepSeek models using OpenAI-compatible API.
 */
export class ModelHandlerDeepSeek extends ModelHandlerOpenAI {
  /** Returns OpenAI client configured with DeepSeek's base URL. */
  async getClient(): Promise<OpenAI> {
    const apiKey = await this.getApiKey();
    const baseURL = this.getBaseUrl();
    this.logger.debug(`Using DeepSeek API key. Base URL: ${baseURL}`);
    return new OpenAI({ apiKey, baseURL });
  }

  /**
   * Process thinking blocks for DeepSeek models
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

    // Extract reasoning content from DeepSeek response
    let reasoningContent = null;

    // Check for reasoning_content based on DeepSeek API structure
    // Example from their site: response.choices[0].message.reasoning_content
    if (
      responseObject.choices &&
      responseObject.choices.length > 0 &&
      responseObject.choices[0].message
    ) {
      const message = responseObject.choices[0].message;

      // Primary location according to DeepSeek docs
      if (message.reasoning_content) {
        reasoningContent = message.reasoning_content;
        this.logger.debug(
          'Found reasoning_content in choices[0].message.reasoning_content',
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
          // this.logger.debug('Added reasoning content to toolState', groupId);
        }
        // For deepseek mode thinking content should not be attached back to the message as a content item.
        // Nevertheless one can include one in a bare way...
      }
    }
    if (!reasoningContent) {
      return null;
    }

    // Log preview of thinking content (assuming it's a string)
    this.logger.debug(
      `DeepSeek reasoning content preview: ${reasoningContent.substring(0, 200)}...`,
      groupId,
    );

    // Return the reasoning content (already a string for DeepSeek)
    return reasoningContent;
  }

  /**
   * Preprocess messages array to ensure there are no consecutive user or assistant messages
   * and that content is in string format for DeepSeek models
   * @param messages Original messages array
   * @returns Processed messages array with merged consecutive messages and string content
   */
  private preprocessMessages(messages: any[]): any[] {
    if (!messages || messages.length <= 1) {
      return messages;
    }

    // First, handle merging consecutive messages with the same role
    const mergedMessages: any[] = [messages[0]];

    for (let i = 1; i < messages.length; i++) {
      const currentMessage = messages[i];
      const previousMessage = mergedMessages[mergedMessages.length - 1];

      // If current message has the same role as the previous one, merge them
      if (currentMessage.role === previousMessage.role) {
        this.logger.debug(
          `Merging consecutive ${currentMessage.role} messages`,
        );

        // Handle content merging based on content type
        if (
          Array.isArray(previousMessage.content) &&
          Array.isArray(currentMessage.content)
        ) {
          // If both have content arrays, concatenate them
          previousMessage.content.push(...currentMessage.content);
        } else if (Array.isArray(previousMessage.content)) {
          // If previous has content array but current doesn't
          if (typeof currentMessage.content === 'string') {
            previousMessage.content.push({
              type: 'text',
              text: currentMessage.content,
            });
          }
        } else if (Array.isArray(currentMessage.content)) {
          // If current has content array but previous doesn't
          if (typeof previousMessage.content === 'string') {
            const textContent = previousMessage.content;
            previousMessage.content = [
              { type: 'text', text: textContent },
              ...currentMessage.content,
            ];
          }
        } else if (
          typeof previousMessage.content === 'string' &&
          typeof currentMessage.content === 'string'
        ) {
          // If both are strings, concatenate them with a newline
          previousMessage.content =
            previousMessage.content + '\n' + currentMessage.content;
        }
      } else {
        // Different roles, add as a new message
        mergedMessages.push(currentMessage);
      }
    }

    // Now convert all content arrays to strings for DeepSeek compatibility
    const processedMessages = mergedMessages.map((message) => {
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
   * Override createResponse to preprocess messages for Deepseek models
   */
  async createResponse(
    client: OpenAI,
    messages: any[],
    temperature: number,
    systemPrompt?: string,
    endTag?: string,
    signal?: AbortSignal,
  ): Promise<any> {
    // Preprocess messages to merge consecutive messages and convert content to strings
    const processedMessages = this.preprocessMessages(messages);

    if (processedMessages.length !== messages.length) {
      this.logger.info(
        `Preprocessed message array from ${messages.length} to ${processedMessages.length} messages for Deepseek model compatibility`,
      );
    }

    // Log the first few characters of each processed message for debugging
    processedMessages.forEach((msg, index) => {
      const contentPreview =
        typeof msg.content === 'string'
          ? msg.content.substring(0, 50)
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
    );
  }
}
