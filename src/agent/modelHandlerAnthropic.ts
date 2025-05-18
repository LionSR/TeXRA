// Standard library imports
// (none needed)

// Third-party imports
import { Anthropic } from '@anthropic-ai/sdk';
import {
  MessageParam,
  ContentBlock,
} from '@anthropic-ai/sdk/resources/messages';

// Local imports - utilities
import {
  readFile,
  writeFile,
  fileExists,
  fileExistsAndNonTrivial,
} from '../utils/workspaceFileUtils';
import {
  applyReplacements,
  getAllReplacements,
  getAllReplacementsRegex,
  cleanFileContent,
} from '../replacement/replacementUtils';
import { extractAndLogScratchpad } from '../utils/xmlUtils';

// Local imports - agent components
import { AgentConfig } from './AgentConfig';
import { AgentSetting, hasEndTag } from './AgentDataclass';
import { ModelHandler } from './ModelHandler';
import {
  AnthropicAPIResponseUsage,
  ResponseUsageFactory,
} from './ResponseUsage';
import { ToolState } from './ToolState';
import { MediaEntry } from './mediaTypes';
import { AgentStateRound } from './AgentState';
import { messageToSkeleton } from './messageUtils';
import { getConfig } from '../utils/configUtils';
import { K_SLICE } from '../utils/constants';
import { calculateTokenPrice } from '../utils/priceUtils';

/**
 * Anthropic-specific model handler implementation for managing API interactions and message processing.
 */

// The new implicit prompt caching is worth checking out (can eliminate many controls of previous caching)
export class ModelHandlerAnthropic extends ModelHandler {
  /** Initializes an Anthropic API client using the configured API key. */
  async getClient(): Promise<Anthropic> {
    const apiKey = await this.getApiKey();
    this.logger.debug('Using Anthropic API.');
    // there is a time out parameter that be be set; default is 10 minutes
    return new Anthropic({ apiKey });
  }

  /** Creates a chat completion response using Anthropic's API with specified parameters and optional system prompt. */
  async createResponse(
    client: Anthropic,
    messages: any[],
    temperature: number,
    systemPrompt?: string,
    endTag?: string,
    signal?: AbortSignal,
  ): Promise<any> {
    // Get streaming config
    const useStreaming = this.getStreamingConfig();

    // Prepare options for the API call
    const options: any = {
      model: this.config.fullName,
      max_tokens: this.config.maxOutputTokens,
      messages,
      temperature,
      stop_sequences: endTag ? [endTag] : undefined,
      system: systemPrompt,
    };

    // Enable thinking for any models that support reasoning
    if (this.capabilities.supportsReasoning) {
      // This ensures thinking is explicitly enabled for all models that support it
      this.logger.debug('Enabling thinking for model with reasoning support');
      options.thinking = {
        type: 'enabled',
        budget_tokens: useStreaming ? 32768 : 4096,
      };
    }

    // Add beta features for Claude 3.7 Sonnet to increase max output to 128k tokens and enable thinking
    if (this.config.fullName === 'claude-3-7-sonnet-20250219') {
      // useStreaming = true; should consider to be true by default
      delete options.temperature;

      options.betas = ['output-128k-2025-02-19'];
      // Update max tokens to use the higher limit when streaming
      options.max_tokens = useStreaming ? 64000 : this.config.maxOutputTokens;
      // The thinking configuration is now handled above for all reasoning models
    }

    if (this.capabilities.supportsTokenCounting) {
      const responseTokenCount = await client.beta.messages.countTokens({
        model: this.config.fullName,
        system: systemPrompt,
        messages: messages,
      });
      this.logger.debug(
        `Token count of message: ${responseTokenCount.input_tokens}`,
      );
      if (responseTokenCount.input_tokens > this.config.contextWindow) {
        this.logger.error(
          `Token count of message exceeds context window: ${responseTokenCount.input_tokens} > ${this.config.contextWindow}`,
        );
        throw new Error(
          `Token count of message exceeds context window: ${responseTokenCount.input_tokens} > ${this.config.contextWindow}`,
        );
      }
      if (
        this.config.contextWindow - responseTokenCount.input_tokens <
        options.max_tokens
      ) {
        this.logger.warn(
          `Token count of message plus max tokens exceeds context window: ${responseTokenCount.input_tokens} + ${options.max_tokens} > ${this.config.contextWindow}. Reducing max tokens to ${this.config.contextWindow - responseTokenCount.input_tokens}.`,
        );
        options.max_tokens =
          this.config.contextWindow - responseTokenCount.input_tokens - 10;
      }
      // in the future we log this in firstInputTokens of the AgentStateGlobal
    }

    let response;

    if (useStreaming) {
      // in the future if we pass stream to outside, calling stream.controller.abort() will abort the stream; which will be very useful for our stop button
      // we should also make sure partial results can be returned in the presence of errors!
      const stream = await client.beta.messages.stream(options, { signal });
      const response = await stream.finalMessage();
      return response;
    } else {
      response = await client.beta.messages.create(options, { signal });
    }

    return response;
  }

  /** Initializes the message array for Anthropic chat models with user prefix, request, and optional media. */
  async initializeMessages(
    userPrefix: string,
    userRequest: string,
    mediaFiles?: string[],
    systemPrompt?: string,
  ): Promise<MessageParam[]> {
    // Create content list for the user message
    const userMessageContent: ContentBlock[] = [
      { type: 'text', text: userPrefix, citations: null },
    ];

    // Add media if provided (Anthropic currently only supports images)
    if (mediaFiles && this.config.capabilities.supportsVision) {
      const formattedMediaContent = await this.createMediaMessage(mediaFiles);
      // Filter out any non-image content just in case, although createMediaContent should handle this
      userMessageContent.push(
        ...formattedMediaContent.filter(
          (c) =>
            c.type === 'image' ||
            (c.type === 'text' && c.text?.startsWith('Image:')),
        ),
      );
    }

    // Add user request with optional caching
    const requestBlock: ContentBlock = {
      type: 'text',
      text: userRequest,
      citations: null,
      ...(this.capabilities.supportsPromptCaching
        ? { cache_control: { type: 'ephemeral' } }
        : {}),
    };
    userMessageContent.push(requestBlock);

    // Note: Anthropic handles system prompts differently via createResponse()
    const messages: MessageParam[] = [
      { role: 'user', content: userMessageContent },
    ];
    return messages;
  }

  public removeCacheControl(content: any[]) {
    // With the updated Anthropic prompt caching, we should ensure we never exceed
    // Anthropic's limit of 4 cache_control blocks across the entire conversation

    // Complete removal approach - remove all cache_control properties
    // This ensures we don't accumulate too many cache points over time
    if (Array.isArray(content) && content.length > 0) {
      for (let i = 0; i < content.length; i++) {
        if (typeof content[i] === 'object' && content[i]?.cache_control) {
          delete content[i].cache_control;
        }
      }
    }
  }

  /** Creates a reflection message array for Anthropic models, managing cache control and image content. */
  async createReflectionMessages(
    messages: any[],
    userMessage: string,
    mediaFiles?: string[],
  ): Promise<MessageParam[]> {
    // Create content list for the reflection message
    const reflectionContent: ContentBlock[] = [];

    // Add media if provided (Anthropic currently only supports images)
    if (
      mediaFiles &&
      mediaFiles.length > 0 &&
      this.config.capabilities.supportsVision
    ) {
      try {
        const formattedMediaContent = await this.createMediaMessage(mediaFiles);
        // Filter out any non-image content
        reflectionContent.push(
          ...formattedMediaContent.filter(
            (c) =>
              c.type === 'image' ||
              (c.type === 'text' && c.text?.startsWith('Image:')),
          ),
        );
      } catch (err) {
        this.logger.error(
          `Error processing media files for reflection: ${err}`,
        );
      }
    }

    // Add message text with optional caching
    const messageBlock: ContentBlock = {
      type: 'text',
      text: userMessage,
      citations: null,
      ...(this.capabilities.supportsPromptCaching
        ? { cache_control: { type: 'ephemeral' } }
        : {}),
    };
    reflectionContent.push(messageBlock);

    // We need to ensure we don't exceed Anthropic's limit of 4 cache_control blocks
    // Remove cache_control from ALL previous message contents
    if (this.capabilities.supportsPromptCaching) {
      for (const msg of messages) {
        if (Array.isArray(msg.content)) {
          this.removeCacheControl(msg.content);
        }
      }
    }

    messages.push({ role: 'user', content: reflectionContent });
    return messages;
  }

  /** Converts image/document content array into Anthropic-compatible message format with type and source metadata. */
  createMediaContent(mediaMessage: MediaEntry[]): ContentBlock[] {
    if (mediaMessage.length === 0) {
      return [];
    }
    this.logger.debug(
      `Creating media content for ${mediaMessage.length} items for Anthropic`,
    );
    return mediaMessage.flatMap((media): ContentBlock[] => {
      if (media.media_category === 'image') {
        // for backward compatibility
        // Always ensure media_type exists
        if (!media.media_type) {
          // Default to image/png since PDFs from TikZ are converted to PNG
          media.media_type = 'image/png';
          this.logger.warn(
            `No media_type found for image ${media.file_name}, defaulting to image/png`,
          );
        }

        // Check for native PDF support
        const isPdf =
          this.capabilities.supportsNativePdf &&
          media.media_type === 'application/pdf';
        return [
          {
            type: 'text',
            text: `${isPdf ? 'Document' : 'Image'}: ${media.file_name}`,
            citations: null,
          },
          {
            type: isPdf ? 'document' : 'image',
            source: {
              type: 'base64',
              media_type: media.media_type,
              data: media.data,
            },
          } as any,
        ];
      } else if (media.media_category === 'audio') {
        // Anthropic doesn't explicitly support native audio input yet
        this.logger.warn(
          `Audio input received (${media.file_name}) but native audio is not currently supported by the Anthropic handler. Skipping.`,
        );
        return []; // Return empty array to skip audio
      } else {
        this.logger.warn(
          `Unknown media category for Anthropic: ${media.media_category}`,
        );
        return [];
      }
    });
  }

  /** Processes Anthropic API response, handling errors, and formatting while returning [response, usage, stopReason]. */
  extractResponse(responseObject: any, endTag: string): [string, any, string] {
    if (responseObject.error) {
      const errorMsg = `API error: ${JSON.stringify(responseObject.error)}`;
      this.logger.error(errorMsg);
      throw new Error(errorMsg);
    }

    // Check for empty response
    if (responseObject.usage.output_tokens === 3) {
      // Anthropic specific empty response check
      const errorMsg = 'No output generated - API returned empty response';
      this.logger.error(errorMsg);
      this.logger.debug(`responseObject: ${responseObject}`);
      this.logger.debug(`responseObject.content: ${responseObject.content}`);
      throw new Error(errorMsg);
    }

    // Extract base response
    const stopReason = responseObject.stop_reason;
    let newResponse = '';

    if (
      this.capabilities.supportsReasoning &&
      Array.isArray(responseObject.content) &&
      responseObject.content.length > 0
    ) {
      // Handle text blocks in Claude 3.7 Sonnet responses
      for (const block of responseObject.content) {
        if (block.type === 'text') {
          newResponse += block.text.trim();
        }
        // We don't include thinking blocks in the response text
      }
    } else if (responseObject.content && responseObject.content.length > 0) {
      // Handle regular text responses
      newResponse = responseObject.content[0].text.trim();
    }

    // Add end tag if needed
    if (stopReason === 'stop_sequence' && !newResponse.includes(endTag)) {
      newResponse += `\n${endTag}`;
    }

    newResponse = applyReplacements(newResponse, getAllReplacements()).trim();
    newResponse = applyReplacements(
      newResponse,
      getAllReplacementsRegex(),
    ).trim();

    return [newResponse, responseObject.usage, stopReason];
  }

  /** Manages continuation with prefill support (typically no-op for models with prefill). */
  addContinueMessageWithPrefill(
    messages: any[],
    stateRound: AgentStateRound,
    toolState: ToolState,
    agentSetting: AgentSetting,
    agentConfig: AgentConfig,
  ): void {
    this.logger.debug('Skipping continuation - assistant prefill is supported');
    // No-op for models that support prefill
  }

  /** Manages continuation for models without prefill support by adding a continuation prompt. */
  addContinueMessageWithoutPrefill(
    messages: any[],
    stateRound: AgentStateRound,
    toolState: ToolState,
    agentSetting: AgentSetting,
    agentConfig: AgentConfig,
  ): void {
    // Create continuation message with last K tokens
    const prefillTokens = toolState.lastResponse.slice(-K_SLICE);
    const userMessageContinuation =
      `Your response got cut off, because you only have limited response space. ` +
      `Continue responding exactly from where you left off until the very end, ` +
      `marked by ${agentSetting.endTag}. ` +
      'Avoid repeat yourself and avoid starting over. ' +
      `Start your response at the next token after: "${prefillTokens}"`;

    // Add continuation message
    this.logger.info(
      `Adding continuation message to conversation. Continuation message:\n ${userMessageContinuation}`,
    );
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: userMessageContinuation }],
      // cache_control: { type: 'ephemeral' },
      // if we keep removing this userContinuation message, then the cache_control will be removed too!
    });
  }

  /** Initializes output file and handles prefill content, returning [isComplete, updatedMessages]. */
  async initializeOutputAndPrefill(
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    messages: any[],
    toolState: ToolState,
    outputFile: string,
    prefill: string,
  ): Promise<[boolean, any[]]> {
    let endTurn = false;

    if (!(await fileExistsAndNonTrivial(outputFile))) {
      if (
        agentConfig.toolConfig.usePrefillFromInput &&
        toolState.firstKCharsFromInput
      ) {
        prefill += toolState.firstKCharsFromInput;
        toolState.updateAccumulatedOutput(toolState.firstKCharsFromInput);
      }

      if (this.capabilities.supportsAssistantPrefill) {
        this.logger.debug(`Adding prefill message:\n${prefill}`);
        if (
          toolState.accumulatedOutput.includes('<scratchpad>') &&
          prefill === '<scratchpad>' // this is not so neat
        ) {
          await writeFile(outputFile, prefill);
        } else if (agentSetting.outputExt === 'xml') {
          await writeFile(outputFile, prefill + '\n');
        }
        messages.push({
          role: 'assistant',
          content: [{ type: 'text', text: prefill }],
        });
      } else {
        // For thinking-enabled models that don't support assistant prefill,
        // add prefill as part of the user message like OpenAI handler

        const PseudoPrefillMsgContentString = `Start your response with:\n${prefill}`;
        messages.at(-1).content.push({
          type: 'text',
          text: PseudoPrefillMsgContentString,
        });
        this.logger.debug(
          `Added pseudo prefill message to messages:\n${PseudoPrefillMsgContentString}`,
        );
      }
      return [endTurn, messages];
    }

    // Get prefill from existing and non-trivial file
    let fileContent = await readFile(outputFile);
    fileContent = cleanFileContent(fileContent);

    // Extract and log any existing scratchpad content
    extractAndLogScratchpad(fileContent, this.logger);

    await writeFile(outputFile, fileContent);

    // Update the toolState with the actual file content
    toolState.updateAccumulatedOutput(fileContent);
    toolState.updateLastResponse(fileContent);

    const lastMessage = messages.at(-1);
    if (hasEndTag(agentSetting, fileContent)) {
      this.logger.debug('End tag detected - skipping continuation');
      // this is suspicious, because the two conflicts!!! we should check
      if (Array.isArray(lastMessage.content)) {
        lastMessage.content[lastMessage.content.length - 1].text = fileContent;
      } else {
        lastMessage.content = [
          {
            type: 'text',
            text: fileContent,
          },
        ];
      }

      this.removeCacheControl(messages.at(-1).content);

      endTurn = true;
      return [endTurn, messages];
    }

    this.logger.warn(
      'Output file exists but no end tag found - continuing from file',
    );

    // For thinking-enabled models that don't support assistant prefill,
    // add continuation as part of the user message

    const content = [
      {
        type: 'text',
        text: fileContent,
        ...(this.capabilities.supportsPromptCaching
          ? { cache_control: { type: 'ephemeral' } }
          : {}),
      },
    ];
    this.logger.debug(`Using existing content as prefill: ${outputFile}`);
    messages.push({ role: 'assistant', content });

    if (!this.capabilities.supportsAssistantPrefill) {
      // For models that don't support assistant prefill, we need to:
      // add a continuation message in addition
      const state = new AgentStateRound(0);
      this.addContinueMessageWithoutPrefill(
        messages,
        state,
        toolState,
        agentSetting,
        agentConfig,
      );

      this.logger.debug(
        `Added existing content as assistant message and continuation prompt`,
      );
    }

    endTurn = false;
    return [endTurn, messages];
  }

  /** Calculates API usage cost based on input/output tokens and cache usage if supported. */
  computePrice(responseUsage: any): number {
    let basePrice = calculateTokenPrice(
      responseUsage.input_tokens,
      responseUsage.output_tokens,
      this.config.inputPrice,
      this.config.outputPrice,
    );

    if (this.capabilities.supportsPromptCaching) {
      if ('cache_creation_input_tokens' in responseUsage) {
        basePrice +=
          (responseUsage.cache_creation_input_tokens *
            this.config.inputPrice *
            1.25) /
          1e6;
      }
      if ('cache_read_input_tokens' in responseUsage) {
        basePrice +=
          (responseUsage.cache_read_input_tokens *
            this.config.inputPrice *
            this.capabilities.cacheDiscountFactor) /
          1e6;
      }
    }

    return basePrice;
  }

  /** Computes detailed response usage metrics including tokens, price, and response time. */
  computeResponseUsage(
    responseUsage: any,
    responseTime: number,
  ): AnthropicAPIResponseUsage {
    return ResponseUsageFactory.fromAnthropicResponse(
      responseUsage,
      this.computePrice(responseUsage),
      responseTime,
    );
  }

  updateMessageContentWithPrefill(
    messages: any[],
    bestConnector: string,
    newResponse: string,
    toolState: ToolState,
  ): void {
    const lastMessage = messages.at(-1);

    if (lastMessage.role === 'assistant') {
      if (Array.isArray(lastMessage.content)) {
        const newMessage = {
          type: 'text',
          text: bestConnector + newResponse,
        };
        lastMessage.content.push(newMessage);
      } else {
        lastMessage.content = [
          {
            type: 'text',
            text: toolState.accumulatedOutput,
          },
        ];
      }

      if (this.capabilities.supportsPromptCaching) {
        // First remove all cache_control from all previous messages to stay under the limit
        for (let i = 0; i < messages.length - 1; i++) {
          const msg = messages[i];
          this.removeCacheControl(msg.content);
        }

        // Then ensure the current message has at most one cache_control
        if (Array.isArray(lastMessage.content)) {
          // Remove all existing cache_control
          this.removeCacheControl(lastMessage.content);

          lastMessage.content.at(-1).cache_control = {
            type: 'ephemeral',
          };
        }
      }
    }
    return;
  }

  updateMessageContentWithoutPrefill(
    messages: any[],
    bestConnector: string,
    newResponse: string,
    toolState: ToolState,
  ): void {
    // For thinking-enabled anthropic models that don't support assistant prefill,
    // handle like OpenAI models where the last message is always a user message
    const lastMessage = messages.at(-1);
    const secondLastMessage = messages.at(-2);

    if (lastMessage.role !== 'user') {
      this.logger.error(
        'Last message is not a user message - unexpected format',
      );
      return;
    }
    this.logger.debug('Last message is a user message');

    // Fix for continuation issues
    if (this.containCutOffMessage(lastMessage.content)) {
      this.logger.debug(
        'Last message is a user message asking to continue after cutoff',
      );

      // The last message is a user message
      // So the second last message must be an assistant message

      if (secondLastMessage.role === 'assistant') {
        // Preserve any thinking blocks that might exist in the content array
        const thinkingBlocks = secondLastMessage.content.filter(
          (item: any) =>
            item.type === 'thinking' || item.type === 'redacted_thinking',
        );

        // Find text blocks in the content array
        const textBlocks = secondLastMessage.content.filter(
          (item: any) => item.type === 'text',
        );

        // Anthropic models should include thinking blocks first in the content array
        // Add all thinking blocks from toolState if we have them
        if (thinkingBlocks.length > 0) {
          // if we have thinking blocks, then we use them
          this.logger.debug(
            `Using ${thinkingBlocks.length} existing thinking blocks from previous message`,
          );
          secondLastMessage.content.push({
            type: 'text',
            text: bestConnector + newResponse,
          });
        } else {
          secondLastMessage.content.push({
            type: 'text',
            text: bestConnector + newResponse,
          });
          // Add the updated text content
          // If there are existing text blocks, update with new content
          // Otherwise create a new text block with the new returned thinking block if it is not after cut off
          // we should not add the new thinking block if it is after cut off
          // but we still need to add at least somewhere...

          // let newThinkingContent: any[] = [];

          // if (toolState.thinkingAdded && toolState.thinkingBlocks.length > 0) {
          //   // if we have thinking blocks, then we use them
          //   this.logger.debug(
          //     `Using ${toolState.thinkingBlocks.length} existing thinking blocks from previous message`,
          //   );
          //   newThinkingContent = [...toolState.thinkingBlocks];
          // }

          // let newContent: any[] = [];

          // if (textBlocks.length > 0) {
          //   newContent = [...newThinkingContent, ...textBlocks];
          // } else {
          //   newContent = [
          //     ...newThinkingContent,
          //     {
          //       type: 'text',
          //       text: toolState.accumulatedOutput,
          //     },
          //   ];
          // }

          // Replace the content of the second last message with our new content array
          // secondLastMessage.content = newContent;
        }

        // Remove cache_control from previous messages if needed
        if (this.capabilities.supportsPromptCaching) {
          for (let i = 0; i < messages.length - 1; i++) {
            const msg = messages[i];
            this.removeCacheControl(msg.content);
          }
        }

        // Remove the user continuation prompt to keep the conversation clean
        if (messages.at(-1)?.role === 'user') {
          messages.pop();
        } else {
          this.logger.error(
            'Last message is not a user message - unexpected format',
          );
        }
      }
    } else {
      this.logger.debug(
        'Last message is a request message rather than a ask to continue after cut off',
      );
      // Create a new assistant message with the response
      const assistantMessage: { role: string; content: any[] } = {
        role: 'assistant',
        content: [],
      };

      // Include all thinking blocks from toolState if available
      if (toolState.thinkingBlocks && toolState.thinkingBlocks.length > 0) {
        this.logger.debug(
          `Adding ${toolState.thinkingBlocks.length} thinking blocks to new assistant message`,
        );
        assistantMessage.content.push(...toolState.thinkingBlocks);
      }

      // Add the text content
      assistantMessage.content.push({
        type: 'text',
        text: toolState.accumulatedOutput,
      });

      messages.push(assistantMessage);
      this.logger.debug('Added a new assistant message');
    }
  }

  /** Determines if generation should continue based on stop reason and end tag presence. */
  shouldContinue(
    stopReason: string,
    newResponse: string,
    agentSetting: AgentSetting,
  ): boolean {
    // DEBUG: Log the stop reason to help diagnose continuation issues
    this.logger.debug(
      `Checking if should continue - stop reason: "${stopReason}"`,
    );

    // We should continue if:
    // 1. We hit the max tokens limit (stopReason === 'max_tokens')
    // 2. AND we don't have an end tag (meaning the response is incomplete)
    if (stopReason === 'max_tokens' && !hasEndTag(agentSetting, newResponse)) {
      return true;
    }
    if (stopReason === 'stop_sequence') {
      if (!hasEndTag(agentSetting, newResponse)) {
        return true;
      } else {
        this.logger.debug('Should not continue - no end tag found');
        return false;
      }
    }
    return false;
  }

  /**
   * Process thinking blocks for Anthropic models
   * @param responseObject The response object from Anthropic API
   * @param groupId Optional group ID for logging
   * @param toolState Optional toolState to update with the thinking blocks
   * @returns The extracted thinking content (or null if none)
   * This preserves the full thinking objects including signature which is required
   * when sending back to the Anthropic API for continuing a conversation
   */
  processThinkingBlock(
    responseObject: any,
    groupId?: string,
    toolState?: ToolState,
  ): string | null {
    if (!responseObject) {
      return null;
    }

    // Extract all thinking blocks from the response
    const thinkingBlocks = [];
    let regularThinkingContent = null;

    try {
      if (responseObject.content && Array.isArray(responseObject.content)) {
        // Collect all thinking and redacted_thinking blocks
        for (const item of responseObject.content) {
          if (item.type === 'thinking' && item.thinking) {
            thinkingBlocks.push(item);
            // Save the first regular thinking content for returning
            if (regularThinkingContent === null) {
              regularThinkingContent = item.thinking;
            }
          } else if (item.type === 'redacted_thinking' && item.data) {
            thinkingBlocks.push(item);
          }
        }
      }
    } catch (e) {
      this.logger.error(`Error extracting thinking blocks: ${e}`, groupId);
      return null;
    }

    if (thinkingBlocks.length === 0) {
      return null;
    }

    this.logger.debug(
      `Found ${thinkingBlocks.length} thinking blocks`,
      groupId,
    );

    // If toolState is provided, update it with all thinking blocks
    if (toolState && !toolState.thinkingAdded) {
      // Store all thinking blocks for future reference
      if (!this.containCutOffMessage(regularThinkingContent)) {
        toolState.thinkingBlocks = thinkingBlocks;
        // thinkingBlock is now a getter that returns thinkingBlocks[0]
        toolState.thinkingAdded = true;
        this.logger.debug(
          `Added ${thinkingBlocks.length} thinking blocks to toolState`,
          groupId,
        );
      } else {
        this.logger.debug(
          `Skipping adding thinking blocks to toolState because of cut off message`,
          groupId,
        );
      }
    }

    // Return content of the first regular thinking block for logging
    return regularThinkingContent;
  }
}
