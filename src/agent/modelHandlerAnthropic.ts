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
      // Update max tokens to use the higher limit
      options.max_tokens = this.config.maxOutputTokens;
      if (this.capabilities.supportsReasoning) {
        options.thinking = {
          type: 'enabled',
          // budget_tokens: 32000,
          budget_tokens: 4096,
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
    }

    return client.beta.messages.create(options);
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
    // With the updated Anthropic prompt caching, we only need to add cache_control
    // to the new message - Anthropic will automatically check for cache hits
    // at previous positions

    // First clear any existing cache control points to stay under the 4 breakpoint limit

    if (Array.isArray(content) && content.length > 0) {
      for (let i = 0; i < content.length - 1; i++) {
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

    // Since Anthropic now automatically checks for cache hits at previous positions,
    // we only need to remove cache_control from previous message to avoid
    // exceeding the 4 cache breakpoint limit
    if (
      this.capabilities.supportsPromptCaching &&
      Array.isArray(messages.at(-1)?.content)
    ) {
      this.removeCacheControl(messages.at(-1).content);
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
      Array.isArray(responseObject.content)
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
      content: userMessageContinuation,
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
        messages.push({ role: 'assistant', content: prefill });
      } else {
        // For thinking-enabled models that don't support assistant prefill,
        // add prefill as part of the user message like OpenAI handler

        const PseudoPrefillMsgContentString = `Start your response with:\n${prefill}`;
        if (Array.isArray(messages.at(-1).content)) {
          messages.at(-1).content.push({
            type: 'text',
            text: PseudoPrefillMsgContentString,
          });
        }
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

    if (hasEndTag(agentSetting, fileContent)) {
      this.logger.debug('End tag detected - skipping continuation');
      if (Array.isArray(messages.at(-1).content)) {
        messages.at(-1).content[messages.at(-1).content.length - 1].text =
          fileContent;
      } else {
        messages.at(-1).content = fileContent;
      }

      this.removeCacheControl(messages.at(-1).content);

      endTurn = true;
      return [endTurn, messages];
    }

    this.logger.warn(
      'Output file exists but no end tag found - continuing from file',
    );
    toolState.updateAccumulatedOutput(fileContent);

    // For thinking-enabled models that don't support assistant prefill,
    // add continuation as part of the user message
    if (this.capabilities.supportsAssistantPrefill) {
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
    } else {
      const state = AgentStateRound.initialize(0);
      toolState.lastResponse = toolState.accumulatedOutput;
      this.addContinueMessage(
        messages,
        state,
        toolState,
        agentSetting,
        agentConfig,
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
      this.logger.debug(
        'Last message is a request message rather than a ask to continue after cut off',
      );
      messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: toolState.accumulatedOutput }],
      });

      // Handle normal Anthropic models
      const lastMessage = messages.at(-1);
      if (lastMessage.role === 'assistant') {
        if (Array.isArray(lastMessage.content)) {
          const newMessage = {
            type: 'text',
            text: bestConnector + newResponse,
          };
          lastMessage.content.push(newMessage);
        } else {
          lastMessage.content = toolState.accumulatedOutput;
        }

        if (this.capabilities.supportsPromptCaching) {
          if (Array.isArray(lastMessage.content)) {
            this.removeCacheControl(lastMessage.content);

            // Add cache_control to the new message
            lastMessage.content.at(-1).cache_control = {
              type: 'ephemeral',
            };
          } else {
            // Initialize content list with single message
            lastMessage.content = [
              {
                type: 'text',
                text: toolState.accumulatedOutput,
                cache_control: { type: 'ephemeral' },
              },
            ];
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
    let secondLastMessageType = secondLastMessage.content.at(0).type;

    if (this.containCutOffMessage(lastMessage.content)) {
      // The last message is a user message
      // The second last message must be an assistant message
      if (secondLastMessage.role === 'assistant') {
        if (
          secondLastMessageType === 'thinking' ||
          secondLastMessageType === 'redacted_thinking'
        ) {
          // great, we already have the thinking block in the second last message
          this.logger.debug('Second last message has a thinking block');
        } else {
          // how to append to the first element of the content array?
          secondLastMessage.content.at(0).text += bestConnector + newResponse;
          this.logger.debug(
            'Second last message content: ' +
              secondLastMessage.content.at(0).text,
          );
        }
        if (Array.isArray(secondLastMessage.content)) {
          secondLastMessage.content.push({
            type: 'text',
            text: bestConnector + newResponse,
            ...(this.capabilities.supportsPromptCaching
              ? { cache_control: { type: 'ephemeral' } }
              : {}),
          });
        } else {
          this.logger.error('Second last message content is not a list');
          secondLastMessage.content = toolState.accumulatedOutput;
        }
        // Remove the user continuation prompt
        messages.pop();
      }
      return;
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
