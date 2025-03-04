// Standard library imports
// (none needed)

// Third-party imports
import { Anthropic } from '@anthropic-ai/sdk';

// Local imports - utilities
import {
  readFile,
  writeFile,
  fileExists,
  fileExistsAndNonTrivial,
} from '../utils/workspaceFileUtils';
import {
  applyReplacements,
  getReplacementsByCategory,
  getAllReplacements,
  getAllReplacementsRegex,
} from '../utils/replacementUtils';
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
import { AgentStateRound } from './AgentState';
import { messageToSkeleton } from './messageUtils';
import { getConfig } from '../frontend-utils/commonUtils';

const K_SLICE = 200;

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
  ): Promise<any> {
    // Get streaming config
    let useStreaming = getConfig<boolean>('model.useStreaming', false);

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
      // in the future we log this in firstInputTokens of the AgentStateGlobal
    }

    let response;

    if (useStreaming) {
      // in the future if we pass stream to outside, calling stream.controller.abort() will abort the stream; which will be very useful for our stop button
      // we should also make sure partial results can be returned in the presence of errors!
      const stream = await client.beta.messages.stream(options);
      const response = await stream.finalMessage();
      return response;
    } else {
      response = await client.beta.messages.create(options);
    }

    return response;
  }

  /** Initializes the message array for Anthropic chat models with user prefix, request, and optional images. */
  async initializeMessages(
    userPrefix: string,
    userRequest: string,
    figureFiles?: string[],
    systemPrompt?: string,
  ): Promise<any[]> {
    // Create content list with user prefix
    const content: any[] = [{ type: 'text', text: userPrefix }];

    // Add images if provided
    if (figureFiles) {
      content.push(...(await this.createImageMessage(figureFiles)));
    }

    // Add user request with optional caching
    const request = {
      type: 'text',
      text: userRequest,
      ...(this.capabilities.supportsPromptCaching
        ? { cache_control: { type: 'ephemeral' } }
        : {}),
    };
    content.push(request);

    // Note: Anthropic handles system prompts differently via createResponse()
    return [{ role: 'user', content }];
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
    figureFiles?: string[],
  ): Promise<any[]> {
    // Create content list
    const content: any[] = [];

    // Add images if provided
    if (figureFiles && figureFiles.length > 0) {
      try {
        const imageContent = await this.createImageMessage(figureFiles);
        content.push(...imageContent);
      } catch (err) {
        this.logger.error(`Error processing image files: ${err}`);
      }
    }

    // Add message with optional caching
    const message = {
      type: 'text',
      text: userMessage,
      ...(this.capabilities.supportsPromptCaching
        ? { cache_control: { type: 'ephemeral' } }
        : {}),
    };
    content.push(message);

    // We need to ensure we don't exceed Anthropic's limit of 4 cache_control blocks
    // Remove cache_control from ALL previous message contents
    if (this.capabilities.supportsPromptCaching) {
      for (const msg of messages) {
        this.removeCacheControl(msg.content);
      }
    }

    messages.push({ role: 'user', content });
    return messages;
  }

  /** Converts image/document content array into Anthropic-compatible message format with type and source metadata. */
  createImageContent(imageContents: any[]): any[] {
    this.logger.debug(
      `Creating image content for ${imageContents.length} images`,
    );
    return imageContents.flatMap((image) => {
      // Log minimal debug info, focused on media_type
      // this.logger.debug(
      //   `Image content: ${JSON.stringify({
      //     media_type: image.media_type || 'MISSING',
      //   })}`,
      // );

      // Always ensure media_type exists
      if (!image.media_type) {
        // Default to image/png since PDFs from TikZ are converted to PNG
        image.media_type = 'image/png';
        this.logger.debug(`Applied default media_type: image/png`);
      }

      const isPdf =
        this.capabilities.supportsNativePdf &&
        image.media_type === 'application/pdf';
      return [
        {
          type: 'text',
          text: `${isPdf ? 'Document' : 'Image'}: ${image.file_name}`,
        },
        {
          type: isPdf ? 'document' : 'image',
          source: {
            type: 'base64',
            media_type: image.media_type,
            data: image.data,
          },
        },
      ];
    });
  }

  /** Processes Anthropic API response, handling errors, and formatting while returning [response, usage, stopReason]. */
  extractResponse(responseObject: any, endTag: string): [string, any, string] {
    if (responseObject.error) {
      const errorMsg = `API error: ${responseObject.error}`;
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
    let stopReason = responseObject.stop_reason;
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
    fileContent = applyReplacements(fileContent, getAllReplacements()).trim();
    fileContent = applyReplacements(
      fileContent,
      getAllReplacementsRegex(),
    ).trim();

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
      const state = AgentStateRound.initialize(0);
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
    let basePrice =
      (responseUsage.input_tokens * this.config.inputPrice +
        responseUsage.output_tokens * this.config.outputPrice) /
      1e6;

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
            0.1) /
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
    messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: toolState.accumulatedOutput }],
    });
    // i thought accumulatedOutput would have been updated already??

    // Handle normal Anthropic models with prefill
    const lastMessage = messages.at(-1);
    if (lastMessage.role === 'assistant') {
      // why does the following two differ?
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
    let lastMessage = messages.at(-1);
    let secondLastMessage = messages.at(-2);

    if (lastMessage.role !== 'user') {
      this.logger.error('Last message is not a user message');
      return;
    }
    this.logger.debug('Last message is a user message');

    // Fix for continuation issues
    if (this.containCutOffMessage(lastMessage.content)) {
      this.logger.debug(
        'Last message is a user message asking to continue after cut off',
      );

      // The last message is a user message
      // The second last message must be an assistant message

      // here it can be tricky because it can be that the model response has not started yet...
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

        // Create a new content array starting with any thinking blocks
        // const newContent = [...thinkingBlocks];
        let newContent = [];
        // this should only be set once?

        // If there are existing text blocks, update the last one with new content
        // Otherwise create a new text block
        if (textBlocks.length > 0) {
          // Use accumulated output to ensure we have the complete context
          const updatedText = {
            type: 'text',
            text: bestConnector + newResponse,
          };
          newContent.push(updatedText);
        } else {
          this.logger.error('Second last message content is not a list');
          newContent.push({
            type: 'text',
            text: toolState.accumulatedOutput,
          });
        }

        // Anthropic models support attaching back thinking blocks
        if (thinkingBlocks.length > 0) {
          if (!toolState.thinkingAdded) {
            this.logger.debug('(non-redacted) Thinking block found');
            if (toolState.thinkingBlock && toolState.thinkingAdded) {
              newContent = [toolState.thinkingBlock, ...newContent];
              this.logger.debug('Using the first thinking block');
            } else {
              this.logger.debug('No existing thinking block found');
              toolState.thinkingBlock = thinkingBlocks[0];
              toolState.thinkingAdded = true;
            }
          }
        }

        // Update the second last message with the new content array
        // secondLastMessage.content = newContent;
        secondLastMessage.content.push(...newContent);

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
        }
      }
      return;
    } else {
      // This is a regular response, not a continuation
      this.logger.debug(
        'Last message is a request message rather than a ask to continue after cut off',
      );
      const message = {
        role: 'assistant',
        content: [{ type: 'text', text: toolState.accumulatedOutput }],
      };
      if (toolState.thinkingBlock) {
        message.content = [toolState.thinkingBlock, ...message.content];
      }

      messages.push(message);
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
      this.logger.debug(
        'Should continue - adding continuation message to conversation',
      );
      return true;
    }
    if (stopReason === 'stop_sequence') {
      if (!hasEndTag(agentSetting, newResponse)) {
        this.logger.debug(
          'Should continue - adding continuation message to conversation',
        );
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
   * @returns The extracted thinking content (or null if none)
   * there is a subtlety! Anthropic model would return a object rather than a string for the thinking block, but we should save them in the toolState as an object
   * we need to handle this properly in the updateMessageContent function
   */
  processThinkingBlock(responseObject: any, groupId?: string): string | null {
    if (!responseObject) return null;

    // Extract thinking block from the response
    let thinkingBlock = null;
    try {
      if (responseObject.content && Array.isArray(responseObject.content)) {
        for (const item of responseObject.content) {
          if (item.type === 'thinking' && item.thinking) {
            thinkingBlock = item;
            break;
          } else if (item.type === 'redacted_thinking' && item.data) {
            thinkingBlock = item;
            break;
          }
        }
      }
    } catch (e) {
      this.logger.error(`Error extracting thinking block: ${e}`, groupId);
      return null;
    }

    if (!thinkingBlock) return null;

    this.logger.debug(`Thinking block type: ${thinkingBlock.type}`, groupId);

    if (thinkingBlock.type === 'thinking' && thinkingBlock.thinking) {
      // Log preview of thinking content
      this.logger.debug(
        `Thinking content preview: ${thinkingBlock.thinking.substring(0, 200)}...`,
        groupId,
      );

      // Return the thinking content
      return thinkingBlock.thinking;
    } else if (
      thinkingBlock.type === 'redacted_thinking' &&
      thinkingBlock.data
    ) {
      this.logger.debug(`Redacted thinking data available (encoded)`, groupId);
      // For redacted thinking, we don't have accessible content
      return null;
    }

    return null;
  }
}
