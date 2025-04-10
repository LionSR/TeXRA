// Standard library imports
// (none needed)

// Third-party imports
import OpenAI from 'openai';

// Local imports - agent components
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';
import { ToolState } from './ToolState';
import { ReasoningEffort } from '../model/ModelConfig';

/**
 * Handler for xAI models using OpenAI-compatible API.
 */
export class ModelHandlerXAI extends ModelHandlerOpenAI {
  /** Returns OpenAI client configured with xAI's base URL. */
  async getClient(): Promise<OpenAI> {
    const apiKey = await this.getApiKey();
    const baseURL = this.getBaseUrl();
    this.logger.debug(`Using xAI API key. Base URL: ${baseURL}`);
    return new OpenAI({ apiKey, baseURL });
  }

  /**
   * Validates reasoning effort to ensure only supported values are used.
   * xAI models only support 'low' and 'high', not 'medium'.
   */
  private validateReasoningEffort(effort: ReasoningEffort): string {
    // xAI models only support 'low' and 'high'
    if (effort === ReasoningEffort.LOW || effort === ReasoningEffort.HIGH) {
      return effort;
    }
    
    // Default to 'high' for MEDIUM and any other values
    this.logger.warn(`xAI models only support 'low' or 'high' reasoning effort. Converting '${effort}' to 'high'.`);
    return ReasoningEffort.HIGH;
  }

  /** Creates a chat completion with xAI-specific parameters. */
  async createResponse(
    client: OpenAI,
    messages: any[],
    temperature: number,
    systemPrompt?: string,
    endTag?: string,
  ): Promise<any> {
    const kwargs: any = {
      model: this.config.fullName,
      messages,
      max_tokens: this.config.maxOutputTokens,
      temperature,
    };

    // Add reasoning_effort parameter for models that support it
    if (
      this.config.capabilities.supportsReasoning &&
      this.config.capabilities.supportsReasoningEffort &&
      this.config.capabilities.reasoningEffort
    ) {
      // Ensure only supported values are used
      kwargs.reasoning_effort = this.validateReasoningEffort(
        this.config.capabilities.reasoningEffort
      );
    }

    if (endTag) {
      kwargs.stop = [endTag];
    }

    try {
      const response = await client.chat.completions.create(kwargs);
      return response;
    } catch (err) {
      this.logger.error(`Error in createResponse: ${err}`);
      throw err;
    }
  }

  /**
   * Process thinking blocks for xAI models
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

    // Extract reasoning content from xAI response
    let reasoningContent = null;

    // Check for reasoning_content based on xAI API structure
    if (
      responseObject.choices &&
      responseObject.choices.length > 0 &&
      responseObject.choices[0].message
    ) {
      const message = responseObject.choices[0].message;

      // Extract reasoning_content from xAI response
      if (message.reasoning_content) {
        reasoningContent = message.reasoning_content;
        this.logger.debug(
          'Found reasoning_content in choices[0].message.reasoning_content',
          groupId,
        );

        // If toolState is provided and we have reasoning content,
        // store it in the toolState for future use
        if (toolState && !toolState.thinkingAdded) {
          // Create a thinking block in a consistent format
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
      `xAI reasoning content preview: ${reasoningContent.substring(0, 200)}...`,
      groupId,
    );

    return reasoningContent;
  }

  /** Extracts response text and usage statistics from API response. */
  extractResponse(responseObject: any, endTag: string): [string, any, string] {
    const [responseText, usage, stopReason] = super.extractResponse(responseObject, endTag);
    
    // Extract and add reasoning tokens for usage calculation
    if (
      responseObject.usage?.completion_tokens_details?.reasoning_tokens
    ) {
      this.logger.debug(`Found reasoning tokens: ${responseObject.usage.completion_tokens_details.reasoning_tokens}`);
    }
    
    return [responseText, usage, stopReason];
  }
} 