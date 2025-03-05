// Standard library imports
// (none needed)

// Third-party imports
import OpenAI from 'openai';

// Local imports - agent components
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import { ToolState } from './ToolState';

/**
 * Handler for Deepseek models using OpenAI-compatible API.
 */
export class ModelHandlerDeepseek extends ModelHandlerOpenAI {
  /** Returns OpenAI client configured with Deepseek's base URL. */
  async getClient(): Promise<OpenAI> {
    const apiKey = await this.getApiKey();
    const baseURL = this.getBaseUrl();
    this.logger.debug(`Using Deepseek API key. Base URL: ${baseURL}`);
    return new OpenAI({ apiKey, baseURL });
  }

  /**
   * Process thinking blocks for Deepseek models
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
    if (!responseObject) return null;

    // Extract reasoning content from Deepseek response
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
          this.logger.debug('Added reasoning content to toolState', groupId);
        }
        // For deepseek mode thinking content should not be attached back to the message as a content item.
        // Nevertheless one can include one in a bare way...
      }
    }
    if (!reasoningContent) return null;

    // Log preview of thinking content (assuming it's a string)
    this.logger.debug(
      `Deepseek reasoning content preview: ${reasoningContent.substring(0, 200)}...`,
      groupId,
    );

    // Return the reasoning content (already a string for DeepSeek)
    return reasoningContent;
  }
}
