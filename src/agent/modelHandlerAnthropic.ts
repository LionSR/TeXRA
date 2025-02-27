// Standard library imports
// (none needed)

// Third-party imports
import Anthropic from '@anthropic-ai/sdk';

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
import { stream } from 'winston';

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
    const useStreaming = getConfig<boolean>('model.useStreaming', false);

    // Prepare options for the API call
    const options: any = {
      model: this.config.fullName,
      max_tokens: this.config.maxOutputTokens,
      messages,
      temperature,
      stop_sequences: endTag ? [endTag] : undefined,
      system: systemPrompt,
    };

    // Add beta features for Claude 3.7 Sonnet to increase max output to 128k tokens and enable thinking
    if (this.config.fullName === 'claude-3-7-sonnet-20250219') {
      delete options.temperature;

      options.betas = ['output-128k-2025-02-19'];
      // Update max tokens to use the higher limit when streaming
      options.max_tokens = useStreaming ? 128000 : this.config.maxOutputTokens;
      if (this.capabilities.supportsReasoning) {
        options.thinking = {
          type: 'enabled',
          // Set higher budget_tokens for streaming
          budget_tokens: useStreaming ? 32000 : 4096,
        };
      }
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
      // in the future we log this in firstInputTokens of the AgentStateGlobal
    }

    let response;

    if (useStreaming) {

      // in the future if we pass stream to outside, calling stream.controller.abort() will abort the stream; which will be very useful for our stop button
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
  createReflectionMessages(
    messages: any[],
    userMessage: string,
    figureFiles?: string[],
  ): any[] {
    // Create content list
    const content: any[] = [];

    // Add images if provided
    if (figureFiles) {
      content.push(...this.createImageContent(figureFiles));
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
    return imageContents.flatMap((image) => {
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

  /** Processes Anthropic API response, handling errors, and formatting while returning [response, usage, thinkingBlock, stopReason]. */
  extractResponse(
    responseObject: any,
    endTag: string,
  ): [string, any, any, string] {
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
    let thinkingBlock = null;

    if (
      this.capabilities.supportsReasoning &&
      Array.isArray(responseObject.content) &&
      responseObject.content.length > 0
    ) {
      // Handle thinking blocks in Claude 3.7 Sonnet responses
      for (const block of responseObject.content) {
        if (block.type === 'text') {
          newResponse += block.text.trim();
        }
        if (block.type === 'thinking' || block.type === 'redacted_thinking') {
          // Store the entire thinking block object
          thinkingBlock = block;
        }
        // We don't include thinking blocks (type: thinking or redacted_thinking) in the response text
        // They need to be preserved in the message object for the next turn though
      }
    } else if (responseObject.content && responseObject.content.length > 0) {
      // Handle regular text responses
      newResponse = responseObject.content[0].text.trim();
    }

    // Add end tag if needed
    if (stopReason === 'stop_sequence' && !newResponse.includes(endTag)) {
      newResponse += `\n${endTag}`;
    }

    return [newResponse, responseObject.usage, thinkingBlock, stopReason];
  }

  /** Adds continuation message when response is truncated. */
  addContinueMessage(
    messages: any[],
    stateRound: AgentStateRound,
    toolState: ToolState,
    agentSetting: AgentSetting,
    agentConfig: AgentConfig,
  ): void {
    // Skip if model supports assistant prefill
    if (this.capabilities.supportsAssistantPrefill) {
      this.logger.debug(
        'Skipping continuation - assistant prefill is supported',
      );
      return;
    }

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
      this.addContinueMessage(
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

  /** Updates message content with new responses while managing cache control and content formatting. */
  updateMessageContent(
    messages: any[],
    bestConnector: string,
    newResponse: string,
    toolState: ToolState,
  ): void {
    // For thinking-enabled anthropic models that don't support assistant prefill,
    // handle like OpenAI models where the last message is always a user message
    if (this.capabilities.supportsAssistantPrefill) {
      messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: toolState.accumulatedOutput }],
      });

      // Handle normal Anthropic models
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

    // For thinking-enabled anthropic models that don't support assistant prefill,
    // handle like OpenAI models where the last message is always a user message
    if (messages.at(-1)?.role !== 'user') {
      this.logger.error('Last message is not a user message');
      return;
    }
    this.logger.debug('Last message is a user message');

    let lastMessage = messages.at(-1);
    let secondLastMessage = messages.at(-2);

    // Fix for continuation issues
    if (this.containCutOffMessage(lastMessage.content)) {
      this.logger.debug(
        'Last message is a user message asking to continue after cut off',
      );

      // The last message is a user message
      // The second last message must be an assistant message
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
        const newContent = [...thinkingBlocks];

        // If there are existing text blocks, update the last one with new content
        // Otherwise create a new text block
        if (textBlocks.length > 0) {
          // Use accumulated output to ensure we have the complete context
          const updatedText = {
            type: 'text',
            text: toolState.accumulatedOutput,
          };
          newContent.push(updatedText);
        } else {
          newContent.push({
            type: 'text',
            text: toolState.accumulatedOutput,
          });
        }

        // Update the second last message with the new content array
        secondLastMessage.content = newContent;
        if (thinkingBlocks.length === 0) {
          const thinkingBlock = toolState.thinkingBlock;
          if (thinkingBlock) {
            secondLastMessage.content = [thinkingBlock, ...newContent];
          }
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
        }

        this.logger.debug(
          `Updated second last message with thinking block: ${JSON.stringify(
            messageToSkeleton(messages),
          )}`,
        );

        this.logger.debug(
          `Updated second last message with accumulated output (${toolState.accumulatedOutput.length} chars)`,
        );
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
    return (
      stopReason !== 'max_tokens' &&
      stopReason !== 'stop_sequence' &&
      !hasEndTag(agentSetting, newResponse)
    );
  }
}
