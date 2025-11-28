// (none needed)

// Local imports - agent
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import { K_SLICE } from '@utils/config';

// Local file imports
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';

// Type imports
import type { ExtractResponseResult } from './types/IModelHandler';

/**
 * Handler for xAI models using OpenAI-compatible API.
 */
export class ModelHandlerXAI extends ModelHandlerOpenAI {
  protected override get usageProvider(): NormalizedUsage['provider'] {
    return 'xai';
  }

  /**
   * Process thinking blocks for xAI models
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

    // reasoning_effort is not supported by grok-4.
    // Specifying reasoning_effort parameter will get an error response.

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
        );

        // If workspaceState is provided and we have reasoning content,
        // store it in the workspaceState for future use
        if (workspaceState && !workspaceState.reasoning.thinkingAdded) {
          // Create a thinking block in a consistent format
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
      `xAI reasoning content preview: ${reasoningContent.substring(0, K_SLICE)}...`,
    );

    return reasoningContent;
  }

  /** Extracts response text and usage statistics from API response. */
  extractResponse(responseObject: any, endTag: string): ExtractResponseResult {
    const result = super.extractResponse(responseObject, endTag);

    // Extract and add reasoning tokens for usage calculation
    if (responseObject.usage?.completion_tokens_details?.reasoning_tokens) {
      this.logger.debug(
        `Found reasoning tokens: ${responseObject.usage.completion_tokens_details.reasoning_tokens}`,
      );
    }

    return result;
  }
}
